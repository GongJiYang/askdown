//! Companion-aware file operations. Every mutation has a durable, readable
//! recovery bundle, and uses the same lock and path checks as editor saves.
use crate::storage::{self, VaultPath};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use uuid::Uuid;

fn invalid(message: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, message.into())
}

fn document_set(path: &Path, root: &Path) -> io::Result<Vec<VaultPath>> {
    let primary = storage::vault_path(path, root)?;
    let lower = primary.relative.to_lowercase();
    if !lower.ends_with(".md")
        || lower.ends_with(".notes.md")
        || lower.ends_with(".annotations.md")
        || primary.relative.split('/').any(|part| {
            part.starts_with('.')
                || part == "node_modules"
                || part.contains([':', '\\'])
                || part.chars().any(char::is_control)
                || part.ends_with(['.', ' '])
        })
    {
        return Err(invalid(
            "请选择文件库内的 Markdown 正文，路径不能包含隐藏目录或保留名称",
        ));
    }
    let stem = primary.relative[..primary.relative.len() - 3].to_owned();
    let mut paths = Vec::with_capacity(4);
    for suffix in [".notes.md", ".annotations.md", ".reading.json"] {
        paths.push(storage::vault_path(
            &primary.root.join(format!("{stem}{suffix}")),
            &primary.root,
        )?);
    }
    paths.insert(0, primary);
    Ok(paths)
}

struct Record {
    source: PathBuf,
    destination: Option<PathBuf>,
    original: Vec<u8>,
    // History records embed their relative path; rewrite that field on move.
    replacement: Option<Vec<u8>>,
}

impl Record {
    fn output(&self) -> &[u8] {
        self.replacement.as_deref().unwrap_or(&self.original)
    }
}

fn optional_bytes(path: &Path) -> io::Result<Option<Vec<u8>>> {
    match fs::read(path) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

fn vacant(path: &Path) -> io::Result<()> {
    match fs::symlink_metadata(path) {
        Ok(_) => Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            format!("目标或关联文件已存在：{}", path.display()),
        )),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

fn checked(root: &Path, path: &Path) -> io::Result<PathBuf> {
    let relative = path
        .strip_prefix(root)
        .map_err(|_| invalid("路径不在文件库内"))?;
    storage::check_components(root, relative, false)
}

fn publish(root: &Path, path: &Path, bytes: &[u8]) -> io::Result<()> {
    let parent = path.parent().ok_or_else(|| invalid("缺少父目录"))?;
    storage::check_components(
        root,
        parent
            .strip_prefix(root)
            .map_err(|_| invalid("路径不在文件库内"))?,
        true,
    )?;
    checked(root, path)?;
    storage::prepare_atomic(path, bytes)?
        .persist_noclobber(path)
        .map_err(|error| error.error)?;
    storage::sync_parent(path)
}

fn collect(sources: &[VaultPath], targets: &[VaultPath]) -> io::Result<Vec<Record>> {
    let mut records = Vec::new();
    for (index, source) in sources.iter().enumerate() {
        let target = targets.get(index);
        if let Some(target) = target {
            vacant(&target.target)?;
            let history = storage::history_dir(target, false)?;
            match fs::read_dir(history) {
                Ok(mut entries) => {
                    if let Some(entry) = entries.next() {
                        entry?;
                        return Err(invalid("目标已有恢复历史，请选择其他文件名"));
                    }
                }
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(error) => return Err(error),
            }
        }
        let bytes = optional_bytes(&source.target)?;
        if index == 0 && bytes.is_none() {
            return Err(io::Error::new(io::ErrorKind::NotFound, "正文文件不存在"));
        }
        if let Some(original) = bytes {
            records.push(Record {
                source: source.target.clone(),
                destination: target.map(|value| value.target.clone()),
                original,
                replacement: None,
            });
        }
        let directory = storage::history_dir(source, false)?;
        let entries = match fs::read_dir(&directory) {
            Ok(entries) => entries,
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error),
        };
        for entry in entries {
            let entry = entry?;
            let name = entry
                .file_name()
                .into_string()
                .map_err(|_| invalid("无效历史文件名"))?;
            if name.starts_with(".askdown-tmp-") {
                continue;
            }
            let id = name
                .strip_suffix(".json")
                .ok_or_else(|| invalid("无效历史文件"))?;
            let mut snapshot = storage::load_snapshot(source, id)?;
            let original = fs::read(checked(&source.root, &entry.path())?)?;
            let (destination, replacement) = if let Some(target) = target {
                snapshot.relative = target.relative.clone();
                (
                    Some(storage::history_dir(target, false)?.join(name)),
                    Some(serde_json::to_vec(&snapshot)?),
                )
            } else {
                (None, None)
            };
            records.push(Record {
                source: entry.path(),
                destination,
                original,
                replacement,
            });
        }
    }
    Ok(records)
}

fn archive(root: &Path, records: &[Record], operation: &str) -> io::Result<PathBuf> {
    let relative = Path::new(".askdown/trash").join(Uuid::new_v4().to_string());
    let directory = storage::check_components(root, &relative, true)?;
    let mut entries = Vec::new();
    for record in records {
        let source = record
            .source
            .strip_prefix(root)
            .map_err(|_| invalid("路径不在文件库内"))?;
        let backup = directory.join("files").join(source);
        publish(root, &backup, &record.original)?;
        entries.push(serde_json::json!({
            "source": source,
            "destination": record.destination.as_ref().and_then(|path| path.strip_prefix(root).ok()),
            "backup": Path::new("files").join(source),
        }));
    }
    publish(
        root,
        &directory.join("manifest.json"),
        &serde_json::to_vec_pretty(&serde_json::json!({
            "operation": operation,
            "entries": entries,
        }))?,
    )?;
    Ok(directory)
}

fn rollback(root: &Path, records: &[Record], published: &[usize]) -> io::Result<()> {
    // Restore missing originals first; never overwrite concurrent external edits.
    let mut errors = Vec::new();
    for record in records.iter().rev() {
        let result = (|| {
            checked(root, &record.source)?;
            match optional_bytes(&record.source)? {
                Some(bytes) if bytes == record.original => Ok(()),
                Some(_) => Err(invalid(format!(
                    "源文件已被外部修改：{}",
                    record.source.display()
                ))),
                None => publish(root, &record.source, &record.original),
            }
        })();
        if let Err(error) = result {
            errors.push(error.to_string());
        }
    }
    for &index in published.iter().rev() {
        let record = &records[index];
        let path = record.destination.as_ref().expect("published destination");
        let result = (|| {
            checked(root, path)?;
            match optional_bytes(path)? {
                Some(bytes) if bytes == record.output() => {
                    fs::remove_file(path)?;
                    storage::sync_parent(path)
                }
                None => Ok(()),
                Some(_) => Err(invalid(format!("目标已被外部修改：{}", path.display()))),
            }
        })();
        if let Err(error) = result {
            errors.push(error.to_string());
        }
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(io::Error::other(errors.join("；")))
    }
}

fn change_locked(
    path: &Path,
    destination: Option<&Path>,
    root: &Path,
    mut before_remove: impl FnMut(usize) -> io::Result<()>,
) -> io::Result<()> {
    let sources = document_set(path, root)?;
    let targets = destination
        .map(|path| document_set(path, root))
        .transpose()?
        .unwrap_or_default();
    if targets
        .first()
        .is_some_and(|target| target.target == sources[0].target)
    {
        return Ok(());
    }
    let root = &sources[0].root;
    let records = collect(&sources, &targets)?;
    let recovery = archive(
        root,
        &records,
        if destination.is_some() {
            "move"
        } else {
            "delete"
        },
    )?;
    let mut published = Vec::new();
    let result = (|| {
        // Publish protection metadata and companions before exposing the primary.
        for (index, record) in records.iter().enumerate().rev() {
            if let Some(target) = &record.destination {
                // Record publication even if a subsequent directory sync fails.
                let parent = target.parent().ok_or_else(|| invalid("缺少父目录"))?;
                storage::check_components(
                    root,
                    parent
                        .strip_prefix(root)
                        .map_err(|_| invalid("路径不在文件库内"))?,
                    true,
                )?;
                checked(root, target)?;
                storage::prepare_atomic(target, record.output())?
                    .persist_noclobber(target)
                    .map_err(|error| error.error)?;
                published.push(index);
                storage::sync_parent(target)?;
            }
        }
        // Validate the entire set before removing any source, then recheck each
        // file immediately before unlinking, matching save's external-write guard.
        for record in &records {
            checked(root, &record.source)?;
            if optional_bytes(&record.source)?.as_deref() != Some(record.original.as_slice()) {
                return Err(invalid("源文件已被外部修改，请刷新后重试"));
            }
        }
        for (index, record) in records.iter().enumerate() {
            before_remove(index)?;
            checked(root, &record.source)?;
            if optional_bytes(&record.source)?.as_deref() != Some(record.original.as_slice()) {
                return Err(invalid("源文件已被外部修改，请刷新后重试"));
            }
            fs::remove_file(&record.source)?;
            storage::sync_parent(&record.source)?;
        }
        Ok(())
    })();
    if let Err(error) = result {
        return match rollback(root, &records, &published) {
            Ok(()) => Err(io::Error::other(format!(
                "{error}；恢复副本：{}",
                recovery.display()
            ))),
            Err(rollback_error) => Err(io::Error::other(format!(
                "{error}；回滚未完成：{rollback_error}；完整恢复副本：{}",
                recovery.display()
            ))),
        };
    }
    Ok(())
}

pub(crate) fn move_document(path: &Path, destination: &Path, root: &Path) -> io::Result<()> {
    let _guard = storage::WRITES
        .lock()
        .map_err(|_| io::Error::other("写入锁不可用"))?;
    change_locked(path, Some(destination), root, |_| Ok(()))
}

pub(crate) fn remove_document(path: &Path, root: &Path) -> io::Result<()> {
    let _guard = storage::WRITES
        .lock()
        .map_err(|_| io::Error::other("写入锁不可用"))?;
    change_locked(path, None, root, |_| Ok(()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn moves_companions_and_rewrites_history_identity() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("note.md");
        let notes = dir.path().join("note.notes.md");
        storage::write(&path, dir.path(), "old", None).unwrap();
        storage::write(&path, dir.path(), "current", Some("old")).unwrap();
        storage::write(&notes, dir.path(), "notes", None).unwrap();
        storage::snapshot(&notes, dir.path(), "notes recovery").unwrap();
        fs::write(dir.path().join("note.reading.json"), "{\"readonly\":true}").unwrap();
        fs::write(dir.path().join("note.annotations.md"), "qa identity").unwrap();
        let target = dir.path().join("nested/renamed.md");
        move_document(&path, &target, dir.path()).unwrap();
        assert!(!path.exists());
        assert_eq!(fs::read_to_string(&target).unwrap(), "current");
        assert_eq!(
            fs::read_to_string(dir.path().join("nested/renamed.annotations.md")).unwrap(),
            "qa identity"
        );
        assert_eq!(
            fs::read_to_string(dir.path().join("nested/renamed.reading.json")).unwrap(),
            "{\"readonly\":true}"
        );
        let history = storage::history(&target, dir.path()).unwrap();
        assert_eq!(
            storage::read_history(&target, dir.path(), &history[0].id).unwrap(),
            "old"
        );
        let moved_notes = dir.path().join("nested/renamed.notes.md");
        let history = storage::history(&moved_notes, dir.path()).unwrap();
        assert_eq!(
            storage::read_history(&moved_notes, dir.path(), &history[0].id).unwrap(),
            "notes recovery"
        );
        move_document(&target, &path, dir.path()).unwrap();
        assert_eq!(fs::read_to_string(path).unwrap(), "current");
    }

    #[test]
    fn companion_collision_and_injected_failure_preserve_sources() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("note.md");
        fs::write(&path, "original").unwrap();
        fs::write(dir.path().join("note.notes.md"), "notes").unwrap();
        let target = dir.path().join("new.md");
        fs::write(dir.path().join("new.reading.json"), "occupied").unwrap();
        assert!(move_document(&path, &target, dir.path()).is_err());
        assert!(!target.exists());
        assert_eq!(fs::read_to_string(&path).unwrap(), "original");
        fs::remove_file(dir.path().join("new.reading.json")).unwrap();
        let _guard = storage::WRITES.lock().unwrap();
        assert!(change_locked(&path, Some(&target), dir.path(), |index| {
            if index == 1 {
                Err(io::Error::other("failure after removing the primary"))
            } else {
                Ok(())
            }
        })
        .is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "original");
        assert_eq!(
            fs::read_to_string(dir.path().join("note.notes.md")).unwrap(),
            "notes"
        );
        assert!(!target.exists());
        assert!(!dir.path().join("new.notes.md").exists());
    }

    #[test]
    fn deletion_archives_current_bytes_and_history_before_removing_set() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("note.md");
        storage::write(&path, dir.path(), "old", None).unwrap();
        storage::write(&path, dir.path(), "new", Some("old")).unwrap();
        fs::write(dir.path().join("note.notes.md"), "notes").unwrap();
        remove_document(&path, dir.path()).unwrap();
        assert!(!path.exists());
        assert!(!dir.path().join("note.notes.md").exists());
        let archive = fs::read_dir(dir.path().join(".askdown/trash"))
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        assert_eq!(
            fs::read_to_string(archive.join("files/note.md")).unwrap(),
            "new"
        );
        assert_eq!(
            fs::read_to_string(archive.join("files/note.notes.md")).unwrap(),
            "notes"
        );
        let manifest: serde_json::Value =
            serde_json::from_slice(&fs::read(archive.join("manifest.json")).unwrap()).unwrap();
        let entries = manifest["entries"].as_array().unwrap();
        let prior = entries
            .iter()
            .find(|entry| {
                entry["source"]
                    .as_str()
                    .unwrap()
                    .starts_with(".askdown/history/")
            })
            .unwrap();
        let history: serde_json::Value = serde_json::from_slice(
            &fs::read(archive.join(prior["backup"].as_str().unwrap())).unwrap(),
        )
        .unwrap();
        assert_eq!(history["content"], "old");
    }

    #[test]
    fn rejects_traversal_outside_roots_and_internal_documents() {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let path = dir.path().join("note.md");
        fs::write(&path, "keep").unwrap();
        for target in [
            dir.path().join("../escape.md"),
            outside.path().join("escape.md"),
            dir.path().join(".askdown/prompts/moved.md"),
            dir.path().join("other.notes.md"),
        ] {
            assert!(move_document(&path, &target, dir.path()).is_err());
        }
        assert_eq!(fs::read_to_string(path).unwrap(), "keep");
    }

    #[cfg(unix)]
    #[test]
    fn refuses_symlinks_and_external_edits_without_clobbering() {
        use std::os::unix::fs::symlink;
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let path = dir.path().join("note.md");
        let target = dir.path().join("new.md");
        fs::write(&path, "old").unwrap();
        symlink(outside.path(), dir.path().join("linked")).unwrap();
        assert!(move_document(&path, &dir.path().join("linked/new.md"), dir.path()).is_err());
        symlink(
            outside.path().join("missing.md"),
            dir.path().join("note.notes.md"),
        )
        .unwrap();
        assert!(remove_document(&path, dir.path()).is_err());
        fs::remove_file(dir.path().join("note.notes.md")).unwrap();
        let _guard = storage::WRITES.lock().unwrap();
        assert!(
            change_locked(&path, Some(&target), dir.path(), |_| fs::write(
                &path, "external"
            ))
            .is_err()
        );
        assert_eq!(fs::read_to_string(&path).unwrap(), "external");
        assert!(!target.exists());
    }
}
