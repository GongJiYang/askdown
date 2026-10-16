//! Durable compare-and-swap saves and append-only vault history.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io::{self, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tempfile::NamedTempFile;
use uuid::Uuid;

pub(crate) static WRITES: Mutex<()> = Mutex::new(());

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub(crate) enum SaveError {
    Conflict { current: Option<String> },
    Io { message: String },
}
impl From<io::Error> for SaveError {
    fn from(error: io::Error) -> Self {
        Self::Io {
            message: error.to_string(),
        }
    }
}

fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, message)
}

pub(crate) fn read_optional(path: &Path) -> io::Result<Option<String>> {
    match fs::read_to_string(path) {
        Ok(content) => Ok(Some(content)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

/// Refuse every symlink beneath the chosen root, including dangling links.
pub(super) fn check_components(
    root: &Path,
    relative: &Path,
    create_dirs: bool,
) -> io::Result<PathBuf> {
    let mut path = root.to_path_buf();
    for component in relative.components() {
        let Component::Normal(name) = component else {
            return Err(invalid("路径不能包含跳转或绝对路径"));
        };
        #[cfg(windows)]
        {
            let name = name.to_str().ok_or_else(|| invalid("路径必须为 UTF-8"))?;
            if name.contains(':') || name.ends_with([' ', '.']) {
                return Err(invalid("不允许 Windows 路径别名或数据流"));
            }
        }
        path.push(name);
        match fs::symlink_metadata(&path) {
            Ok(metadata) => {
                if metadata.file_type().is_symlink() {
                    return Err(invalid("不允许符号链接路径"));
                }
                #[cfg(windows)]
                {
                    use std::os::windows::fs::MetadataExt;
                    if metadata.file_attributes() & 0x400 != 0 {
                        return Err(invalid("不允许 Windows 重解析路径"));
                    }
                }
                if create_dirs && !metadata.is_dir() {
                    return Err(invalid("历史目录不是目录"));
                }
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                if create_dirs {
                    fs::create_dir(&path)?;
                    sync_parent(&path)?;
                }
            }
            Err(error) => return Err(error),
        }
    }
    Ok(path)
}

pub(super) struct VaultPath {
    pub(super) root: PathBuf,
    pub(super) target: PathBuf,
    pub(super) relative: String,
}

pub(super) fn vault_path(path: &Path, root: &Path) -> io::Result<VaultPath> {
    if !root.is_absolute() || !path.is_absolute() {
        return Err(invalid("文件库和文件路径必须为绝对路径"));
    }
    // components() normalizes '.', so reject it before inspecting components.
    let raw = path.to_string_lossy();
    if raw
        .split(['/', '\\'])
        .any(|part| part == "." || part == "..")
    {
        return Err(invalid("无效文件路径"));
    }
    let root_raw = root.to_string_lossy();
    if root_raw
        .split(['/', '\\'])
        .any(|part| part == "." || part == "..")
    {
        return Err(invalid("无效文件库路径"));
    }
    let canonical_root = fs::canonicalize(root)?;
    let relative = path
        .strip_prefix(root)
        .or_else(|_| path.strip_prefix(&canonical_root))
        .map_err(|_| invalid("文件不在文件库内"))?;
    let prompt_path = relative.starts_with(".askdown/prompts") && relative.components().count() > 2;
    let usage_path = relative == Path::new(".askdown/usage.json");
    if relative.as_os_str().is_empty()
        || relative.components().enumerate().any(|(index, part)| {
            part.as_os_str()
                .to_string_lossy()
                .eq_ignore_ascii_case(".askdown")
                && !(index == 0 && (prompt_path || usage_path))
        })
    {
        return Err(invalid("不能修改内部历史目录"));
    }
    let target = check_components(&canonical_root, relative, false)?;
    let relative = relative
        .components()
        .map(|part| {
            part.as_os_str()
                .to_str()
                .ok_or_else(|| invalid("路径必须为 UTF-8"))
        })
        .collect::<io::Result<Vec<_>>>()?
        .join("/");
    Ok(VaultPath {
        root: canonical_root,
        target,
        relative,
    })
}

pub(super) fn history_dir(vault: &VaultPath, create: bool) -> io::Result<PathBuf> {
    let digest = format!("{:x}", Sha256::digest(vault.relative.as_bytes()));
    check_components(
        &vault.root,
        &Path::new(".askdown").join("history").join(digest),
        create,
    )
}

pub(crate) fn sync_parent(path: &Path) -> io::Result<()> {
    #[cfg(unix)]
    File::open(path.parent().ok_or_else(|| invalid("缺少父目录"))?)?.sync_all()?;
    // Windows NamedTempFile::persist uses atomic replace; the file itself is flushed.
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

pub(crate) fn prepare_atomic(path: &Path, content: &[u8]) -> io::Result<NamedTempFile> {
    let parent = path.parent().ok_or_else(|| invalid("缺少父目录"))?;
    let mut temp = tempfile::Builder::new()
        .prefix(".askdown-tmp-")
        .tempfile_in(parent)?;
    if let Ok(metadata) = fs::metadata(path) {
        temp.as_file().set_permissions(metadata.permissions())?;
    }
    temp.write_all(content)?;
    temp.as_file().sync_all()?;
    Ok(temp)
}

pub(crate) fn replace_atomic(path: &Path, content: &[u8]) -> io::Result<()> {
    prepare_atomic(path, content)?
        .persist(path)
        .map_err(|error| error.error)?;
    sync_parent(path)
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub(crate) struct HistoryEntry {
    pub(crate) id: String,
    pub(crate) created: u64,
}
#[derive(Deserialize, Serialize)]
pub(super) struct Snapshot {
    #[serde(flatten)]
    pub(super) entry: HistoryEntry,
    pub(super) relative: String,
    pub(super) content: String,
}

fn append_snapshot(vault: &VaultPath, content: &str) -> io::Result<()> {
    let directory = history_dir(vault, true)?;
    loop {
        let id = Uuid::new_v4().to_string();
        let record = Snapshot {
            entry: HistoryEntry {
                id: id.clone(),
                created: SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .map_err(io::Error::other)?
                    .as_millis() as u64,
            },
            relative: vault.relative.clone(),
            content: content.to_owned(),
        };
        let bytes = serde_json::to_vec(&record)?;
        let target = directory.join(format!("{id}.json"));
        let temp = prepare_atomic(&target, &bytes)?;
        match temp.persist_noclobber(&target) {
            Ok(_) => return sync_parent(&target),
            Err(error) if error.error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error.error),
        }
    }
}

fn validate_id(id: &str) -> io::Result<()> {
    let uuid = Uuid::parse_str(id).map_err(|_| invalid("无效历史版本"))?;
    if uuid.to_string() != id || uuid.get_version_num() != 4 {
        return Err(invalid("无效历史版本"));
    }
    Ok(())
}

pub(super) fn load_snapshot(vault: &VaultPath, id: &str) -> io::Result<Snapshot> {
    validate_id(id)?;
    let directory = history_dir(vault, false)?;
    let path = check_components(&directory, Path::new(&format!("{id}.json")), false)?;
    let snapshot: Snapshot = serde_json::from_slice(&fs::read(path)?)?;
    if snapshot.entry.id != id || snapshot.relative != vault.relative {
        return Err(invalid("历史版本与文件不匹配"));
    }
    Ok(snapshot)
}

pub(crate) fn history(path: &Path, root: &Path) -> io::Result<Vec<HistoryEntry>> {
    let _guard = WRITES
        .lock()
        .map_err(|_| io::Error::other("写入锁不可用"))?;
    let vault = vault_path(path, root)?;
    let directory = history_dir(&vault, false)?;
    let entries = match fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error),
    };
    let mut out = Vec::new();
    for entry in entries {
        let entry = entry?;
        let name = entry.file_name();
        let name = name.to_str().ok_or_else(|| invalid("无效历史文件名"))?;
        // Only crash-leftover private staging files are excluded; history is never pruned.
        if name.starts_with(".askdown-tmp-") {
            continue;
        }
        let id = name
            .strip_suffix(".json")
            .ok_or_else(|| invalid("无效历史文件"))?;
        out.push(load_snapshot(&vault, id)?.entry);
    }
    out.sort_by(|a, b| b.created.cmp(&a.created).then(a.id.cmp(&b.id)));
    Ok(out)
}

pub(crate) fn read_history(path: &Path, root: &Path, id: &str) -> io::Result<String> {
    let _guard = WRITES
        .lock()
        .map_err(|_| io::Error::other("写入锁不可用"))?;
    Ok(load_snapshot(&vault_path(path, root)?, id)?.content)
}

pub(crate) fn snapshot(path: &Path, root: &Path, content: &str) -> io::Result<()> {
    let _guard = WRITES
        .lock()
        .map_err(|_| io::Error::other("写入锁不可用"))?;
    append_snapshot(&vault_path(path, root)?, content)
}

pub(crate) fn write(
    path: &Path,
    root: &Path,
    content: &str,
    expected: Option<&str>,
) -> Result<(), SaveError> {
    let _guard = WRITES
        .lock()
        .map_err(|_| io::Error::other("写入锁不可用"))?;
    write_locked(path, root, content, expected, || Ok(()))
}

fn write_locked(
    path: &Path,
    root: &Path,
    content: &str,
    expected: Option<&str>,
    before_replace: impl FnOnce() -> io::Result<()>,
) -> Result<(), SaveError> {
    let vault = vault_path(path, root)?;
    let current = read_optional(&vault.target)?;
    if current.as_deref() == Some(content) {
        return Ok(());
    }
    if current.as_deref() != expected {
        return Err(SaveError::Conflict { current });
    }
    let parent = vault.target.parent().ok_or_else(|| invalid("缺少父目录"))?;
    let parent_relative = parent
        .strip_prefix(&vault.root)
        .map_err(|_| invalid("文件不在文件库内"))?;
    check_components(&vault.root, parent_relative, true)?;
    let temp = prepare_atomic(&vault.target, content.as_bytes())?;
    if let Some(old) = current.as_deref() {
        append_snapshot(&vault, old)?;
    }
    before_replace()?;
    // Revalidate paths and exact bytes after staging/history writes. A noncooperating
    // external process can still race between this final read and the OS rename.
    let latest_path = vault_path(path, root)?;
    let latest = read_optional(&latest_path.target)?;
    if latest.as_deref() == Some(content) {
        return Ok(());
    }
    if latest.as_deref() != expected {
        return Err(SaveError::Conflict { current: latest });
    }
    temp.persist(&latest_path.target)
        .map_err(|error| error.error)?;
    sync_parent(&latest_path.target)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cas_detects_external_changes_and_deletion() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("note.md");
        write(&path, dir.path(), "one", None).unwrap();
        fs::write(&path, "external").unwrap();
        assert!(
            matches!(write(&path, dir.path(), "two", Some("one")), Err(SaveError::Conflict { current: Some(value) }) if value == "external")
        );
        fs::remove_file(&path).unwrap();
        assert!(matches!(
            write(&path, dir.path(), "two", Some("one")),
            Err(SaveError::Conflict { current: None })
        ));
        assert!(!path.exists());
    }

    #[test]
    fn history_survives_restore_and_keeps_local_recovery() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("note.md");
        write(&path, dir.path(), "first\r\n", None).unwrap();
        write(&path, dir.path(), "second", Some("first\r\n")).unwrap();
        let entries = history(&path, dir.path()).unwrap();
        let original = read_history(&path, dir.path(), &entries[0].id).unwrap();
        assert_eq!(original, "first\r\n");
        snapshot(&path, dir.path(), "unsaved recovery").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "second");
        write(&path, dir.path(), &original, Some("second")).unwrap();
        let contents: Vec<_> = history(&path, dir.path())
            .unwrap()
            .iter()
            .map(|entry| read_history(&path, dir.path(), &entry.id).unwrap())
            .collect();
        assert!(contents.contains(&"second".to_string()));
        assert!(contents.contains(&"unsaved recovery".to_string()));
        assert_eq!(fs::read_to_string(path).unwrap(), "first\r\n");
    }

    #[test]
    fn recheck_and_failed_replace_preserve_disk_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("note.md");
        fs::write(&path, "old").unwrap();
        let result = write_locked(&path, dir.path(), "new", Some("old"), || {
            fs::write(&path, "external")
        });
        assert!(
            matches!(result, Err(SaveError::Conflict { current: Some(value) }) if value == "external")
        );
        let result = write_locked(&path, dir.path(), "new", Some("external"), || {
            Err(io::Error::other("injected replace failure"))
        });
        assert!(matches!(result, Err(SaveError::Io { .. })));
        assert_eq!(fs::read_to_string(&path).unwrap(), "external");
        assert!(fs::read_dir(dir.path()).unwrap().all(|entry| !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(".askdown-tmp-")));
    }

    #[test]
    fn failed_atomic_rename_leaves_existing_destination_intact() {
        let dir = tempfile::tempdir().unwrap();
        let destination = dir.path().join("existing-directory");
        fs::create_dir(&destination).unwrap();
        fs::write(destination.join("keep.md"), "untouched").unwrap();
        assert!(replace_atomic(&destination, b"replacement").is_err());
        assert_eq!(
            fs::read_to_string(destination.join("keep.md")).unwrap(),
            "untouched"
        );
        assert!(fs::read_dir(dir.path()).unwrap().all(|entry| !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(".askdown-tmp-")));
    }

    #[test]
    fn competing_writers_cannot_overwrite_each_other() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("note.md");
        write(&path, dir.path(), "old", None).unwrap();
        let barrier = std::sync::Barrier::new(2);
        let results = std::thread::scope(|scope| {
            let first = scope.spawn(|| {
                barrier.wait();
                write(&path, dir.path(), "first", Some("old"))
            });
            let second = scope.spawn(|| {
                barrier.wait();
                write(&path, dir.path(), "second", Some("old"))
            });
            [first.join().unwrap(), second.join().unwrap()]
        });
        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
        assert_eq!(
            results
                .iter()
                .filter(|result| matches!(result, Err(SaveError::Conflict { .. })))
                .count(),
            1
        );
        let saved = fs::read_to_string(&path).unwrap();
        write(&path, dir.path(), &saved, Some("stale")).unwrap();
        assert_eq!(history(&path, dir.path()).unwrap().len(), 1);
    }

    #[test]
    fn corrupt_disk_and_history_fail_closed() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("note.md");
        fs::write(&path, [0xff]).unwrap();
        assert!(matches!(
            write(&path, dir.path(), "new", None),
            Err(SaveError::Io { .. })
        ));
        assert_eq!(fs::read(&path).unwrap(), [0xff]);
        fs::write(&path, "old").unwrap();
        fs::write(dir.path().join(".askdown"), "blocked").unwrap();
        assert!(write(&path, dir.path(), "new", Some("old")).is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "old");
    }

    #[test]
    fn rejects_traversal_and_invalid_history_ids() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("note.md");
        assert!(write(&dir.path().join("../escape.md"), dir.path(), "bad", None).is_err());
        assert!(write(
            &dir.path().join(".askdown/history/fake"),
            dir.path(),
            "bad",
            None
        )
        .is_err());
        assert!(read_history(&path, dir.path(), "../../secret").is_err());
        assert!(write(
            &dir.path().join("nested/./note.md"),
            dir.path(),
            "bad",
            None
        )
        .is_err());
    }

    #[test]
    fn prompt_files_use_cas_and_recoverable_history() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(".askdown/prompts/ask.md");
        write(&path, dir.path(), "old prompt", None).unwrap();
        write(&path, dir.path(), "new prompt", Some("old prompt")).unwrap();
        let versions = history(&path, dir.path()).unwrap();
        assert_eq!(
            read_history(&path, dir.path(), &versions[0].id).unwrap(),
            "old prompt"
        );
        assert_eq!(fs::read_to_string(&path).unwrap(), "new prompt");
        assert!(matches!(
            write(&path, dir.path(), "stale prompt", Some("old prompt")),
            Err(SaveError::Conflict { .. })
        ));
    }

    #[cfg(unix)]
    #[test]
    fn rejects_file_and_history_symlink_escapes() {
        use std::os::unix::fs::symlink;
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let path = dir.path().join("note.md");
        symlink(outside.path().join("missing.md"), &path).unwrap();
        assert!(write(&path, dir.path(), "bad", None).is_err());
        fs::remove_file(&path).unwrap();
        symlink(outside.path(), dir.path().join(".askdown")).unwrap();
        assert!(snapshot(&path, dir.path(), "bad").is_err());
        assert!(history(&path, dir.path()).is_err());
    }
}
