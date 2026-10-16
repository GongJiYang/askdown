//! Askdown 的原生层：只负责读写本地文件和保存设置。
//! 所有编辑、AI 调用逻辑都在前端（TypeScript）里。

mod credentials;
mod export;
mod file_operations;
mod storage;
mod watch;

use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;
use tauri::Manager;

#[derive(Serialize)]
struct FileEntry {
    /// 相对文件库根目录的路径，统一用 `/` 分隔
    path: String,
    /// 修改时间（毫秒时间戳）
    modified: u64,
}

fn walk(root: &Path, dir: &Path, out: &mut Vec<FileEntry>) -> std::io::Result<()> {
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().to_string();
        // 跳过隐藏目录（包括 .askdown、.git）和依赖目录
        if name.starts_with('.') || name == "node_modules" {
            continue;
        }
        let path = entry.path();
        let ft = entry.file_type()?;
        if ft.is_dir() {
            walk(root, &path, out)?;
        } else if ft.is_file() && name.to_lowercase().ends_with(".md") {
            let rel = path
                .strip_prefix(root)
                .unwrap_or(&path)
                .components()
                .map(|c| c.as_os_str().to_string_lossy().to_string())
                .collect::<Vec<_>>()
                .join("/");
            let modified = entry
                .metadata()
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            out.push(FileEntry {
                path: rel,
                modified,
            });
        }
    }
    Ok(())
}

#[tauri::command]
fn list_markdown(root: String) -> Result<Vec<FileEntry>, String> {
    let root = PathBuf::from(root);
    let mut out = Vec::new();
    walk(&root, &root, &mut out).map_err(|e| e.to_string())?;
    out.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(out)
}

#[tauri::command]
fn read_text(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|e| format!("读取失败 {path}: {e}"))
}

/// Exact-byte compare-and-swap with durable recovery history.
#[tauri::command]
fn write_text(
    path: String,
    root: String,
    content: String,
    expected: Option<String>,
) -> Result<(), storage::SaveError> {
    storage::write(
        Path::new(&path),
        Path::new(&root),
        &content,
        expected.as_deref(),
    )
}

#[tauri::command]
fn file_history(path: String, root: String) -> Result<Vec<storage::HistoryEntry>, String> {
    storage::history(Path::new(&path), Path::new(&root)).map_err(|error| error.to_string())
}

#[tauri::command]
fn read_history(path: String, root: String, id: String) -> Result<String, String> {
    storage::read_history(Path::new(&path), Path::new(&root), &id)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn snapshot_file(path: String, root: String, content: String) -> Result<(), String> {
    storage::snapshot(Path::new(&path), Path::new(&root), &content)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn move_document(path: String, destination: String, root: String) -> Result<(), String> {
    file_operations::move_document(Path::new(&path), Path::new(&destination), Path::new(&root))
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn remove_document(path: String, root: String) -> Result<(), String> {
    file_operations::remove_document(Path::new(&path), Path::new(&root))
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn path_exists(path: String) -> Result<bool, String> {
    match fs::metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error.to_string()),
    }
}

fn settings_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("settings.json"))
}

#[tauri::command]
fn settings_load(app: tauri::AppHandle) -> Result<Option<String>, String> {
    credentials::load(&settings_path(&app)?)
}

#[tauri::command]
fn settings_save(app: tauri::AppHandle, content: String) -> Result<(), String> {
    credentials::save(&settings_path(&app)?, &content)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let context = tauri::generate_context!();
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_process::init())
        .manage(watch::Watches::default())
        .invoke_handler(tauri::generate_handler![
            list_markdown,
            read_text,
            write_text,
            path_exists,
            file_history,
            read_history,
            snapshot_file,
            move_document,
            remove_document,
            export::export_text,
            watch::watch_file,
            watch::unwatch_file,
            settings_load,
            settings_save
        ]);
    if context.config().plugins.0.contains_key("updater") {
        builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    }
    builder.run(context).expect("启动 Askdown 失败");
}
