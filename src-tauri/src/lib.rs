//! Thin Tauri shell: every command delegates to `gantry-core`.
//!
//! Commands return `gantry_core::Error`, which serializes to `{ kind, message }`.

use gantry_core::{
    ActionEvent, ActionTarget, ComposeAction, ComposeAvailability, ComposeEvent, ComposeProject,
    Connections, Container, ContainerAction, ContainerDetails, ContainerWatchEvent, ContextList,
    DetectedEngine, Endpoint, EngineInfo, ExecEvent, ExecOptions, ExecSessions, Image, LogEvent,
    LogOptions, PruneOutcome, PullEvent, RemoveOutcome, Stack, StatsEvent, TlsFiles, Volume,
    VolumePruneOutcome, VolumeSpec, WatchTiming, Watches,
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

/// Runs a command with a terminal in container `id` and streams its output through `on_event`
/// until it ends or `exec_close` ends session `session_id`. Input and resizes arrive through
/// `exec_write` and `exec_resize`.
#[tauri::command]
async fn exec_start(
    connections: tauri::State<'_, Connections>,
    sessions: tauri::State<'_, ExecSessions>,
    endpoint: Endpoint,
    id: String,
    options: ExecOptions,
    session_id: String,
    on_event: Channel<ExecEvent>,
) -> Result<(), gantry_core::Error> {
    let docker = connections.activate(&endpoint)?;
    gantry_core::run_exec(&docker, &sessions, &session_id, &id, &options, |event| {
        let _ = on_event.send(event);
    })
    .await
}

/// Sends keyboard input to an exec session.
#[tauri::command]
fn exec_write(sessions: tauri::State<'_, ExecSessions>, session_id: String, data: String) {
    sessions.write(&session_id, &data);
}

/// Resizes the terminal of an exec session.
#[tauri::command]
fn exec_resize(sessions: tauri::State<'_, ExecSessions>, session_id: String, cols: u16, rows: u16) {
    sessions.resize(&session_id, cols, rows);
}

/// Ends an exec session and its process.
#[tauri::command]
fn exec_close(sessions: tauri::State<'_, ExecSessions>, session_id: String) {
    sessions.close(&session_id);
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

/// Lists the images of `endpoint` with the number of containers that use each.
#[tauri::command]
async fn images_list(
    connections: tauri::State<'_, Connections>,
    endpoint: Endpoint,
) -> Result<Vec<Image>, gantry_core::Error> {
    gantry_core::list_images(&connections.activate(&endpoint)?).await
}

/// Pulls `reference` and streams the progress per layer through `on_event` until it ends or
/// `containers_unwatch` stops the pull `watch_id`. Resolves with `false` when it was stopped.
#[tauri::command]
async fn images_pull(
    connections: tauri::State<'_, Connections>,
    watches: tauri::State<'_, Watches>,
    endpoint: Endpoint,
    reference: String,
    watch_id: String,
    on_event: Channel<PullEvent>,
) -> Result<bool, gantry_core::Error> {
    let docker = connections.activate(&endpoint)?;
    let cancel = watches.register(&watch_id);
    let result = gantry_core::pull_image(&docker, &reference, &cancel, |event| {
        let _ = on_event.send(event);
    })
    .await;
    watches.finish(&watch_id);
    result
}

/// Removes an image by reference or ID.
#[tauri::command]
async fn images_remove(
    connections: tauri::State<'_, Connections>,
    endpoint: Endpoint,
    target: String,
    force: bool,
) -> Result<RemoveOutcome, gantry_core::Error> {
    gantry_core::remove_image(&connections.activate(&endpoint)?, &target, force).await
}

/// Removes the images no container uses: the dangling ones, or with `all` every unused image.
#[tauri::command]
async fn images_prune(
    connections: tauri::State<'_, Connections>,
    endpoint: Endpoint,
    all: bool,
) -> Result<PruneOutcome, gantry_core::Error> {
    gantry_core::prune_images(&connections.activate(&endpoint)?, all).await
}

/// Lists the volumes of `endpoint` with their size and the containers that use them.
#[tauri::command]
async fn volumes_list(
    connections: tauri::State<'_, Connections>,
    endpoint: Endpoint,
) -> Result<Vec<Volume>, gantry_core::Error> {
    gantry_core::list_volumes(&connections.activate(&endpoint)?).await
}

/// Creates a volume.
#[tauri::command]
async fn volumes_create(
    connections: tauri::State<'_, Connections>,
    endpoint: Endpoint,
    spec: VolumeSpec,
) -> Result<(), gantry_core::Error> {
    gantry_core::create_volume(&connections.activate(&endpoint)?, spec).await
}

/// Removes a volume by name.
#[tauri::command]
async fn volumes_remove(
    connections: tauri::State<'_, Connections>,
    endpoint: Endpoint,
    name: String,
    force: bool,
) -> Result<(), gantry_core::Error> {
    gantry_core::remove_volume(&connections.activate(&endpoint)?, &name, force).await
}

/// Removes every volume no container uses.
#[tauri::command]
async fn volumes_prune(
    connections: tauri::State<'_, Connections>,
    endpoint: Endpoint,
) -> Result<VolumePruneOutcome, gantry_core::Error> {
    gantry_core::prune_volumes(&connections.activate(&endpoint)?).await
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

/// Reads a Compose file for the read-only preview before a deployment.
#[tauri::command]
async fn compose_preview(path: String) -> Result<String, gantry_core::Error> {
    gantry_core::preview_compose_file(&path)
}

/// Builds the project of a new deployment from the picked files and the entered project name.
#[tauri::command]
fn compose_deploy_project(
    compose_file: String,
    env_file: Option<String>,
    name: String,
) -> Result<ComposeProject, gantry_core::Error> {
    gantry_core::deploy_project(&compose_file, env_file.as_deref(), &name)
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
    let builder = tauri::Builder::default();
    // The updater checks only when the user asks (frontend `check()`); nothing runs at startup.
    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init());
    builder
        .manage(Connections::default())
        .manage(Watches::default())
        .manage(ExecSessions::default())
        .plugin(tauri_plugin_dialog::init())
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
            images_list,
            images_pull,
            images_remove,
            images_prune,
            volumes_list,
            volumes_create,
            volumes_remove,
            volumes_prune,
            containers_inspect,
            containers_watch,
            containers_unwatch,
            containers_action,
            containers_logs,
            exec_start,
            exec_write,
            exec_resize,
            exec_close,
            containers_stats,
            compose_check,
            compose_run,
            compose_preview,
            compose_deploy_project,
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
