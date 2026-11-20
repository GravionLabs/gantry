//! Thin Tauri shell: every command delegates to `gantry-core`.

use gantry_core::{Endpoint, EngineInfo};
use serde::Serialize;

/// Error shape the frontend receives from every command.
#[derive(Debug, Serialize)]
pub struct CommandError {
    message: String,
}

impl From<gantry_core::Error> for CommandError {
    fn from(error: gantry_core::Error) -> Self {
        Self {
            message: error.to_string(),
        }
    }
}

/// Reads the version of the default local engine.
#[tauri::command]
async fn engine_ping() -> Result<EngineInfo, CommandError> {
    Ok(gantry_core::ping(&Endpoint::local_default()).await?)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![engine_ping])
        .run(tauri::generate_context!())
        .expect("error while running Gantry");
}
