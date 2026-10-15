//! Askdown 的原生层：只负责读写本地文件和保存设置。
//! 所有编辑、AI 调用逻辑都在前端（TypeScript）里。

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
            out.push(FileEntry { path: rel, modified });
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

/// 先写临时文件再重命名，避免写到一半崩溃导致文件损坏。
#[tauri::command]
fn write_text(path: String, content: String) -> Result<(), String> {
    let target = PathBuf::from(&path);
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let file_name = target
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "file".into());
    let tmp = target.with_file_name(format!(".{file_name}.askdown-tmp"));
    fs::write(&tmp, content.as_bytes()).map_err(|e| format!("写入失败 {path}: {e}"))?;
    fs::rename(&tmp, &target).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("保存失败 {path}: {e}")
    })
}

#[tauri::command]
fn path_exists(path: String) -> bool {
    Path::new(&path).exists()
}

fn settings_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("settings.json"))
}

#[tauri::command]
fn settings_load(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let p = settings_path(&app)?;
    if !p.exists() {
        return Ok(None);
    }
    fs::read_to_string(p).map(Some).map_err(|e| e.to_string())
}

#[tauri::command]
fn settings_save(app: tauri::AppHandle, content: String) -> Result<(), String> {
    let p = settings_path(&app)?;
    write_text(p.to_string_lossy().to_string(), content)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_http::init())
        .invoke_handler(tauri::generate_handler![
            list_markdown,
            read_text,
            write_text,
            path_exists,
            settings_load,
            settings_save
        ])
        .run(tauri::generate_context!())
        .expect("启动 Askdown 失败");
}
