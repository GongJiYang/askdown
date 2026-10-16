use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::Emitter;

struct FileWatch {
    watcher: RecommendedWatcher,
    parent: PathBuf,
}
#[derive(Default)]
pub(crate) struct Watches(Mutex<HashMap<String, FileWatch>>);
#[derive(Clone, Serialize)]
struct Change {
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[tauri::command]
pub(crate) fn watch_file(
    app: tauri::AppHandle,
    watches: tauri::State<'_, Watches>,
    path: String,
    id: String,
) -> Result<(), String> {
    let uuid = uuid::Uuid::parse_str(&id).map_err(|_| "无效监听 ID".to_string())?;
    if uuid.to_string() != id {
        return Err("无效监听 ID".into());
    }
    let path = Path::new(&path);
    let parent = std::fs::canonicalize(path.parent().ok_or("缺少父目录")?)
        .map_err(|error| error.to_string())?;
    let target = parent.join(path.file_name().ok_or("缺少文件名")?);
    let event_name = format!("askdown-watch-{id}");
    let initial_event = event_name.clone();
    let emit_app = app.clone();
    let observed_parent = parent.clone();
    let mut watcher =
        notify::recommended_watcher(move |result: notify::Result<notify::Event>| match result {
            Ok(event) if !matches!(event.kind, EventKind::Access(_)) => {
                if event
                    .paths
                    .iter()
                    .any(|path| path == &target || path == &observed_parent)
                {
                    let error = if !observed_parent.is_dir() {
                        Some("文件所在目录已被移除，请重新打开文件库".into())
                    } else {
                        None
                    };
                    let _ = emit_app.emit(&event_name, Change { error });
                }
            }
            Err(error) => {
                let _ = emit_app.emit(
                    &event_name,
                    Change {
                        error: Some(error.to_string()),
                    },
                );
            }
            _ => {}
        })
        .map_err(|error| error.to_string())?;
    watcher
        .watch(&parent, RecursiveMode::NonRecursive)
        .map_err(|error| error.to_string())?;
    let mut registry = watches.0.lock().map_err(|_| "监听锁不可用".to_string())?;
    if registry.contains_key(&id) {
        return Err("重复监听 ID".into());
    }
    registry.insert(id.clone(), FileWatch { watcher, parent });
    // A catch-up notification covers changes between the caller's last read and watch startup.
    if let Err(error) = app.emit(&initial_event, Change { error: None }) {
        registry.remove(&id);
        return Err(error.to_string());
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn unwatch_file(watches: tauri::State<'_, Watches>, id: String) -> Result<(), String> {
    let removed = watches
        .0
        .lock()
        .map_err(|_| "监听锁不可用".to_string())?
        .remove(&id);
    if let Some(mut watch) = removed {
        watch
            .watcher
            .unwatch(&watch.parent)
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}
