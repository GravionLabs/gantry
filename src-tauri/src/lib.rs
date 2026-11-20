//! Thin Tauri shell: every command delegates to `gantry-core`.
//!
//! Commands return `gantry_core::Error`, which serializes to `{ kind, message }`.

use gantry_core::{Endpoint, EngineInfo};

/// Reads the version of the default local engine.
#[tauri::command]
async fn engine_ping() -> Result<EngineInfo, gantry_core::Error> {
    gantry_core::ping(&Endpoint::local_default()).await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![engine_ping])
        .run(tauri::generate_context!())
        .expect("error while running Gantry");
}
