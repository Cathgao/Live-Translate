// Persistent app configuration (WebSocket endpoint, etc.).
//
// Stored as JSON in the OS-specific per-user app data directory so the user
// can inspect or back up the file with a text editor. Path examples:
//
//   Windows : %LOCALAPPDATA%\com.example.live-translate-desktop\settings.json
//   macOS   : ~/Library/Application Support/com.example.live-translate-desktop/settings.json
//   Linux   : ~/.local/share/com.example.live-translate-desktop/settings.json
//
// `get_config` returns a default-initialised struct when the file is missing
// or unparseable, so a corrupt file never bricks the app — it just triggers
// the first-launch settings dialog on the frontend.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::Manager;

#[derive(Serialize, Deserialize, Default, Debug, Clone)]
#[serde(default)]
pub struct AppConfig {
    /// Full WebSocket URL including scheme (ws:// or wss://) and path.
    pub ws_url: String,
}

const CONFIG_FILE_NAME: &str = "settings.json";

fn config_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("无法获取应用数据目录: {e}"))?;
    // Tauri may not have created the directory yet on a fresh install.
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建配置目录失败: {e}"))?;
    Ok(dir.join(CONFIG_FILE_NAME))
}

#[tauri::command]
pub fn get_config(app: tauri::AppHandle) -> Result<AppConfig, String> {
    let path = config_path(&app)?;
    if !path.exists() {
        return Ok(AppConfig::default());
    }
    let raw = std::fs::read_to_string(&path).map_err(|e| {
        format!("读取配置文件失败 ({}) : {e}", path.display())
    })?;
    // A corrupt file should never crash the app — return defaults so the UI
    // can prompt the user to re-enter the URL.
    let parsed: AppConfig = serde_json::from_str(&raw).unwrap_or_default();
    Ok(parsed)
}

#[tauri::command]
pub fn save_config(app: tauri::AppHandle, config: AppConfig) -> Result<(), String> {
    let path = config_path(&app)?;
    let raw = serde_json::to_string_pretty(&config)
        .map_err(|e| format!("序列化配置失败: {e}"))?;
    // Atomic-ish write: serialize first, then write. On Windows, std::fs::write
    // truncates + writes in one syscall which is good enough for this use case.
    std::fs::write(&path, raw).map_err(|e| format!("写入配置文件失败 ({}): {e}", path.display()))?;
    Ok(())
}