//! Thin Tauri shell: every command delegates to `gantry-core`.
//!
//! Commands return `gantry_core::Error`, which serializes to `{ kind, message }`.

use gantry_core::{Connections, ContextList, DetectedEngine, Endpoint, EngineInfo, TlsFiles};
use tauri::{Manager, RunEvent};

/// Connects to an endpoint and reads the engine version ("Test connection" and the status bar).
#[tauri::command]
async fn endpoint_test(endpoint: Endpoint) -> Result<EngineInfo, gantry_core::Error> {
    gantry_core::ping(&endpoint).await
}

/// Validates what the user typed for a manual endpoint and builds the endpoint.
#[tauri::command]
fn endpoint_build(
    name: String,
    address: String,
    tls: Option<TlsFiles>,
) -> Result<Endpoint, gantry_core::Error> {
    Endpoint::manual(&name, &address, tls)
}

/// The Docker CLI contexts as read-only endpoints.
#[tauri::command]
fn endpoints_contexts() -> ContextList {
    gantry_core::import_contexts()
}

/// Makes `endpoint` the active one and reads its engine version. Its connection (an `ssh`
/// process for `ssh://`) is reused until another endpoint is activated.
#[tauri::command]
async fn endpoint_activate(
    connections: tauri::State<'_, Connections>,
    endpoint: Endpoint,
) -> Result<EngineInfo, gantry_core::Error> {
    let version = connections.activate(&endpoint)?.version().await?;
    Ok(EngineInfo {
        version: version.version,
        api_version: version.api_version,
        os: version.os,
        arch: version.arch,
    })
}

/// Finds the Docker engines on this machine and reports whether each is reachable.
#[tauri::command]
async fn endpoints_detect() -> Vec<DetectedEngine> {
    gantry_core::detect().await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(Connections::default())
        .plugin(tauri_plugin_store::Builder::default().build())
        .invoke_handler(tauri::generate_handler![
            endpoint_test,
            endpoint_activate,
            endpoint_build,
            endpoints_contexts,
            endpoints_detect
        ])
        .build(tauri::generate_context!())
        .expect("error while building Gantry")
        .run(|app, event| {
            // Ends the `ssh` processes of remote endpoints.
            if let RunEvent::Exit = event {
                app.state::<Connections>().close_all();
            }
        });
}
