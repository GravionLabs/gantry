//! Thin Tauri shell: every command delegates to `gantry-core`.
//!
//! Commands return `gantry_core::Error`, which serializes to `{ kind, message }`.

use gantry_core::{Connections, Endpoint, EngineInfo};
use tauri::{Manager, RunEvent};

/// Reads the version of the default local engine.
#[tauri::command]
async fn engine_ping() -> Result<EngineInfo, gantry_core::Error> {
    gantry_core::ping(&Endpoint::local_default()).await
}

/// Reads the version of the engine at `address`; it becomes the active endpoint and its
/// connection (an `ssh` process for `ssh://`) is reused until another endpoint is activated.
#[tauri::command]
async fn endpoint_ping(
    connections: tauri::State<'_, Connections>,
    name: String,
    address: String,
) -> Result<EngineInfo, gantry_core::Error> {
    let endpoint = Endpoint::parse(name, &address)?;
    let version = connections.activate(&endpoint)?.version().await?;
    Ok(EngineInfo {
        version: version.version,
        api_version: version.api_version,
        os: version.os,
        arch: version.arch,
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(Connections::default())
        .invoke_handler(tauri::generate_handler![engine_ping, endpoint_ping])
        .build(tauri::generate_context!())
        .expect("error while building Gantry")
        .run(|app, event| {
            // Ends the `ssh` processes of remote endpoints.
            if let RunEvent::Exit = event {
                app.state::<Connections>().close_all();
            }
        });
}
