use std::fs;
use tauri_plugin_dialog::DialogExt;

#[tauri::command]
pub async fn export_text(
    app: tauri::AppHandle,
    default_name: String,
    content: String,
    extension: String,
) -> Result<bool, String> {
    if !matches!(extension.as_str(), "html" | "md") {
        return Err("不支持的导出格式".into());
    }
    let selected = app
        .dialog()
        .file()
        .set_file_name(default_name)
        .add_filter(
            if extension == "html" {
                "HTML 文档"
            } else {
                "Markdown 文档"
            },
            &[&extension],
        )
        .blocking_save_file();
    let Some(selected) = selected else {
        return Ok(false);
    };
    let path = selected.into_path().map_err(|error| error.to_string())?;
    fs::write(path, content).map_err(|error| format!("导出失败：{error}"))?;
    Ok(true)
}
