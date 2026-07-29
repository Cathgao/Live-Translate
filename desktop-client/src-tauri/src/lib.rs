// Tauri 2 entry point for Live Translate desktop client.

mod config;
mod serial_mgr;

use serial_mgr::{PortInfo, SerialConfig, SerialManager};
use tauri::Manager;

#[tauri::command]
fn serial_list(_state: tauri::State<'_, SerialManager>) -> Vec<PortInfo> {
    SerialManager::list_ports_inner()
}

#[tauri::command]
async fn serial_open(
    app: tauri::AppHandle,
    _state: tauri::State<'_, SerialManager>,
    config: SerialConfig,
) -> Result<u32, String> {
    // Open on a blocking thread because serialport is sync.
    let mgr_handle = app.state::<SerialManager>().inner() as *const _ as usize;
    // SAFETY: SerialManager is 'static (we put it in app.manage below). Reconstruct
    // a reference for the call. The blocking call internally takes a Mutex.
    let mgr_ref: &SerialManager = unsafe { &*(mgr_handle as *const SerialManager) };
    let app_clone = app.clone();
    tauri::async_runtime::spawn_blocking(move || mgr_ref.open_inner(app_clone, config))
        .await
        .map_err(|e| format!("join error: {e}"))?
}

#[tauri::command]
async fn serial_close(
    app: tauri::AppHandle,
    _state: tauri::State<'_, SerialManager>,
    port_id: u32,
) -> Result<(), String> {
    let mgr_handle = app.state::<SerialManager>().inner() as *const _ as usize;
    let mgr_ref: &SerialManager = unsafe { &*(mgr_handle as *const SerialManager) };
    let app_clone = app.clone();
    tauri::async_runtime::spawn_blocking(move || mgr_ref.close_inner(&app_clone, port_id))
        .await
        .map_err(|e| format!("join error: {e}"))?
}

#[tauri::command]
async fn serial_write(
    app: tauri::AppHandle,
    _state: tauri::State<'_, SerialManager>,
    port_id: u32,
    bytes: Vec<u8>,
) -> Result<(), String> {
    let mgr_handle = app.state::<SerialManager>().inner() as *const _ as usize;
    let mgr_ref: &SerialManager = unsafe { &*(mgr_handle as *const SerialManager) };
    tauri::async_runtime::spawn_blocking(move || mgr_ref.write_inner(port_id, bytes))
        .await
        .map_err(|e| format!("join error: {e}"))?
}

#[tauri::command]
fn app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(SerialManager::default())
        .invoke_handler(tauri::generate_handler![
            serial_list,
            serial_open,
            serial_close,
            serial_write,
            config::get_config,
            config::save_config,
            app_version,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}