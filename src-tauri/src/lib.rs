//! Thin Tauri shell: every command delegates to `gantry-core`.
//!
//! Commands return `gantry_core::Error`, which serializes to `{ kind, message }`.

use gantry_core::{
    ActionEvent, ActionTarget, ComposeAction, ComposeAvailability, ComposeEvent, ComposeProject,
    Connections, Container, ContainerAction, ContainerDetails, ContainerWatchEvent, ContextList,
    DetectedEngine, Endpoint, EngineInfo, LogEvent, LogOptions, Stack, StatsEvent, TlsFiles,
    WatchTiming, Watches,
};
use tauri::ipc::Channel;
use tauri::{Manager, RunEvent};
use tauri_plugin_opener::OpenerExt;

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

/// Lists the containers of `endpoint` (all states).
#[tauri::command]
async fn containers_list(
    connections: tauri::State<'_, Connections>,
    endpoint: Endpoint,
) -> Result<Vec<Container>, gantry_core::Error> {
    gantry_core::list_containers(&connections.activate(&endpoint)?).await
}

/// Lists the Compose stacks of `endpoint`, recognized by their labels.
#[tauri::command]
async fn stacks_list(
    connections: tauri::State<'_, Connections>,
    endpoint: Endpoint,
) -> Result<Vec<Stack>, gantry_core::Error> {
    gantry_core::list_stacks(&connections.activate(&endpoint)?).await
}

/// Reads the full details of one container (`docker inspect`).
#[tauri::command]
async fn containers_inspect(
    connections: tauri::State<'_, Connections>,
    endpoint: Endpoint,
    id: String,
) -> Result<ContainerDetails, gantry_core::Error> {
    gantry_core::inspect_container(&connections.activate(&endpoint)?, &id).await
}

/// Streams the container list of `endpoint` through `on_event` until `containers_unwatch` stops
/// watch `watch_id`: a snapshot first, then one after every change, reconnecting when the engine
/// restarts.
#[tauri::command]
async fn containers_watch(
    connections: tauri::State<'_, Connections>,
    watches: tauri::State<'_, Watches>,
    endpoint: Endpoint,
    watch_id: String,
    on_event: Channel<ContainerWatchEvent>,
) -> Result<(), gantry_core::Error> {
    let docker = connections.activate(&endpoint)?;
    let cancel = watches.register(&watch_id);
    gantry_core::watch_containers(&docker, &cancel, WatchTiming::default(), |event| {
        // A closed channel means the view is gone; its unwatch call ends the watch.
        let _ = on_event.send(event);
    })
    .await;
    watches.finish(&watch_id);
    Ok(())
}

/// Stops the watch started by `containers_watch` with the same `watch_id`.
#[tauri::command]
fn containers_unwatch(watches: tauri::State<'_, Watches>, watch_id: String) {
    watches.cancel(&watch_id);
}

/// Applies `action` to the `targets` and reports each container through `on_event`. Resolves with
/// the number of containers that failed; their messages arrive as events.
#[tauri::command]
async fn containers_action(
    connections: tauri::State<'_, Connections>,
    endpoint: Endpoint,
    action: ContainerAction,
    targets: Vec<ActionTarget>,
    on_event: Channel<ActionEvent>,
) -> Result<usize, gantry_core::Error> {
    let docker = connections.activate(&endpoint)?;
    Ok(gantry_core::run_action(&docker, targets, action, |event| {
        let _ = on_event.send(event);
    })
    .await)
}

/// Streams the logs of a container through `on_event` until they end or `containers_unwatch`
/// stops the stream `watch_id` (a followed log ends only that way).
#[tauri::command]
async fn containers_logs(
    connections: tauri::State<'_, Connections>,
    watches: tauri::State<'_, Watches>,
    endpoint: Endpoint,
    id: String,
    options: LogOptions,
    watch_id: String,
    on_event: Channel<LogEvent>,
) -> Result<(), gantry_core::Error> {
    let docker = connections.activate(&endpoint)?;
    let cancel = watches.register(&watch_id);
    let result = gantry_core::stream_logs(&docker, &id, &options, &cancel, |event| {
        let _ = on_event.send(event);
    })
    .await;
    watches.finish(&watch_id);
    result
}

/// Streams the resource stats of a container through `on_event` until the container stops or
/// `containers_unwatch` stops the stream `watch_id`.
#[tauri::command]
async fn containers_stats(
    connections: tauri::State<'_, Connections>,
    watches: tauri::State<'_, Watches>,
    endpoint: Endpoint,
    id: String,
    watch_id: String,
    on_event: Channel<StatsEvent>,
) -> Result<(), gantry_core::Error> {
    let docker = connections.activate(&endpoint)?;
    let cancel = watches.register(&watch_id);
    let result = gantry_core::stream_stats(&docker, &id, &cancel, |event| {
        let _ = on_event.send(event);
    })
    .await;
    watches.finish(&watch_id);
    result
}

/// Tells whether Compose actions can run for `project`: the plugin is installed and the Compose
/// files exist on this machine.
#[tauri::command]
async fn compose_check(project: ComposeProject) -> ComposeAvailability {
    gantry_core::check_compose(&project).await
}

/// Runs a Compose `action` on `project` at `endpoint` and streams the CLI output through
/// `on_event` until it ends or `containers_unwatch` stops the run `watch_id`.
#[tauri::command]
async fn compose_run(
    watches: tauri::State<'_, Watches>,
    endpoint: Endpoint,
    project: ComposeProject,
    action: ComposeAction,
    watch_id: String,
    on_event: Channel<ComposeEvent>,
) -> Result<(), gantry_core::Error> {
    let cancel = watches.register(&watch_id);
    let result = gantry_core::run_compose(&endpoint, &project, action, &cancel, |event| {
        let _ = on_event.send(event);
    })
    .await;
    watches.finish(&watch_id);
    result
}

/// Opens `http://localhost:<port>` in the default browser. Only the port comes from the UI, so
/// the command cannot be used to open another address.
#[tauri::command]
fn open_local_port(app: tauri::AppHandle, port: u16) -> Result<(), String> {
    app.opener()
        .open_url(format!("http://localhost:{port}"), None::<&str>)
        .map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(Connections::default())
        .manage(Watches::default())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .invoke_handler(tauri::generate_handler![
            endpoint_test,
            endpoint_activate,
            endpoint_build,
            endpoints_contexts,
            endpoints_detect,
            containers_list,
            stacks_list,
            containers_inspect,
            containers_watch,
            containers_unwatch,
            containers_action,
            containers_logs,
            containers_stats,
            compose_check,
            compose_run,
            open_local_port
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
