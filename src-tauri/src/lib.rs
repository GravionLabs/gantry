//! Thin Tauri shell: every command delegates to `gantry-core`.
//!
//! Commands return `gantry_core::Error`, which serializes to `{ kind, message }`.

use gantry_core::{DetectedEngine, Endpoint, EngineInfo};

/// Reads the version of the default local engine.
#[tauri::command]
async fn engine_ping() -> Result<EngineInfo, gantry_core::Error> {
    gantry_core::ping(&Endpoint::local_default()).await
}

/// Finds the Docker engines on this machine and reports whether each is reachable.
#[tauri::command]
async fn endpoints_detect() -> Vec<DetectedEngine> {
    gantry_core::detect().await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![engine_ping, endpoints_detect])
        .run(tauri::generate_context!())
        .expect("error while running Gantry");
}
