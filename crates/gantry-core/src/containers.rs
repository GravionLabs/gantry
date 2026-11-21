//! The container list and its live updates from the engine's `/events` stream.
//!
//! The list is event driven: [`watch_containers`] sends a full snapshot first, then a new snapshot
//! after every event that changes a container (events are coalesced), and reconnects with a backoff
//! when the stream ends, for example after an engine restart.
//!
//! [`run_action`] applies a lifecycle action (start, stop, remove, ...) to one or many containers
//! and reports progress and the engine's message per container.

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use bollard::Docker;
use bollard::models::{
    ContainerInspectResponse, ContainerStateStatusEnum, ContainerSummary,
    ContainerSummaryHealthStatusEnum, ContainerSummaryStateEnum, HealthStatusEnum,
    PortSummaryTypeEnum, RestartPolicyNameEnum,
};
use bollard::query_parameters::{
    EventsOptionsBuilder, ListContainersOptionsBuilder, RemoveContainerOptionsBuilder,
};
use futures_util::StreamExt;
use futures_util::stream::BoxStream;
use serde::{Deserialize, Serialize};
use specta::Type;
use tokio::sync::Notify;

use crate::Result;

const COMPOSE_PROJECT_LABEL: &str = "com.docker.compose.project";

/// The lifecycle state of a container.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ContainerState {
    Created,
    Running,
    Paused,
    Restarting,
    Exited,
    Removing,
    Dead,
    Stopping,
    Unknown,
}

/// The result of the health check of a container that defines one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ContainerHealth {
    Starting,
    Healthy,
    Unhealthy,
}

/// A published port: a container port that is reachable on the host.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PortMapping {
    /// The host address the port is bound to, e.g. `0.0.0.0`.
    pub ip: Option<String>,
    pub private_port: u16,
    /// Absent for a port that is exposed but not published.
    pub public_port: Option<u16>,
    /// `tcp`, `udp` or `sctp`.
    pub protocol: String,
}

/// One row of the container list.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Container {
    pub id: String,
    /// The name without the leading `/`.
    pub name: String,
    pub image: String,
    pub state: ContainerState,
    pub health: Option<ContainerHealth>,
    /// The engine's text, e.g. `Up 2 hours (healthy)`.
    pub status: String,
    /// Published ports, deduplicated (IPv4 and IPv6 bindings of one port count once).
    pub ports: Vec<PortMapping>,
    /// Creation time in seconds since the Unix epoch.
    pub created: u32,
    /// The Compose project the container belongs to, from its labels.
    pub compose_project: Option<String>,
}

impl Container {
    fn from_summary(summary: ContainerSummary) -> Option<Self> {
        let id = summary.id?;
        let name = summary
            .names
            .and_then(|names| names.into_iter().next())
            .map(|name| name.trim_start_matches('/').to_owned())
            .unwrap_or_else(|| id.chars().take(12).collect());
        let status = summary.status.unwrap_or_default();
        let health = summary
            .health
            .and_then(|h| h.status)
            .and_then(|s| match s {
                ContainerSummaryHealthStatusEnum::STARTING => Some(ContainerHealth::Starting),
                ContainerSummaryHealthStatusEnum::HEALTHY => Some(ContainerHealth::Healthy),
                ContainerSummaryHealthStatusEnum::UNHEALTHY => Some(ContainerHealth::Unhealthy),
                _ => None,
            })
            .or_else(|| health_from_status(&status));
        let labels = summary.labels.unwrap_or_default();
        Some(Self {
            id,
            name,
            image: summary.image.unwrap_or_default(),
            state: match summary.state {
                Some(ContainerSummaryStateEnum::CREATED) => ContainerState::Created,
                Some(ContainerSummaryStateEnum::RUNNING) => ContainerState::Running,
                Some(ContainerSummaryStateEnum::PAUSED) => ContainerState::Paused,
                Some(ContainerSummaryStateEnum::RESTARTING) => ContainerState::Restarting,
                Some(ContainerSummaryStateEnum::EXITED) => ContainerState::Exited,
                Some(ContainerSummaryStateEnum::REMOVING) => ContainerState::Removing,
                Some(ContainerSummaryStateEnum::DEAD) => ContainerState::Dead,
                Some(ContainerSummaryStateEnum::STOPPING) => ContainerState::Stopping,
                _ => ContainerState::Unknown,
            },
            health,
            status,
            ports: ports_of(summary.ports.unwrap_or_default()),
            created: summary.created.unwrap_or(0).clamp(0, i64::from(u32::MAX)) as u32,
            compose_project: labels
                .get(COMPOSE_PROJECT_LABEL)
                .filter(|p| !p.is_empty())
                .cloned(),
        })
    }
}

/// Older engines do not report `Health` in the list; their status text carries it.
fn health_from_status(status: &str) -> Option<ContainerHealth> {
    if status.contains("(healthy)") {
        Some(ContainerHealth::Healthy)
    } else if status.contains("(unhealthy)") {
        Some(ContainerHealth::Unhealthy)
    } else if status.contains("(health: starting)") {
        Some(ContainerHealth::Starting)
    } else {
        None
    }
}

fn ports_of(summaries: Vec<bollard::models::PortSummary>) -> Vec<PortMapping> {
    let mut seen = HashSet::new();
    let mut ports: Vec<PortMapping> = summaries
        .into_iter()
        .filter(|p| p.public_port.is_some())
        .map(|p| PortMapping {
            ip: p.ip,
            private_port: p.private_port,
            public_port: p.public_port,
            protocol: match p.typ {
                Some(PortSummaryTypeEnum::UDP) => "udp",
                Some(PortSummaryTypeEnum::SCTP) => "sctp",
                _ => "tcp",
            }
            .to_owned(),
        })
        // `0.0.0.0` and `::` bind the same port twice.
        .filter(|p| seen.insert((p.public_port, p.private_port, p.protocol.clone())))
        .collect();
    ports.sort_by_key(|p| (p.public_port, p.private_port));
    ports
}

/// Lists all containers (running or not), sorted by name.
pub async fn list_containers(docker: &Docker) -> Result<Vec<Container>> {
    let options = ListContainersOptionsBuilder::default().all(true).build();
    let mut containers: Vec<Container> = docker
        .list_containers(Some(options))
        .await?
        .into_iter()
        .filter_map(Container::from_summary)
        .collect();
    containers.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(containers)
}

/// A restart policy, e.g. `on-failure` with at most 3 retries.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RestartPolicy {
    /// `no`, `always`, `unless-stopped` or `on-failure`.
    pub name: String,
    /// Only meaningful for `on-failure`; 0 means unlimited.
    pub max_retries: u32,
}

/// One environment variable of the container configuration.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct EnvVar {
    pub name: String,
    pub value: String,
}

/// A mount of a container.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct MountInfo {
    /// `bind`, `volume`, `tmpfs`, ...
    pub kind: String,
    /// The volume name; only for volumes.
    pub name: Option<String>,
    pub source: String,
    pub destination: String,
    pub read_write: bool,
}

/// The attachment of a container to a network.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct NetworkAttachment {
    pub name: String,
    pub network_id: String,
    pub ip_address: String,
    pub gateway: String,
    pub mac_address: String,
    pub aliases: Vec<String>,
}

/// A label of the container.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Label {
    pub key: String,
    pub value: String,
}

/// Everything `docker inspect` shows about a container, in a form the UI can lay out.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ContainerDetails {
    pub id: String,
    pub name: String,
    /// The image reference the container was created from, e.g. `nginx:latest`.
    pub image: String,
    /// The ID of the image, `sha256:...`.
    pub image_id: String,
    pub state: ContainerState,
    pub health: Option<ContainerHealth>,
    /// Creation time in RFC 3339 format.
    pub created: String,
    pub command: Vec<String>,
    pub entrypoint: Vec<String>,
    pub restart_policy: RestartPolicy,
    pub ports: Vec<PortMapping>,
    pub env: Vec<EnvVar>,
    pub mounts: Vec<MountInfo>,
    pub networks: Vec<NetworkAttachment>,
    pub labels: Vec<Label>,
    pub compose_project: Option<String>,
    /// The complete inspect response as pretty printed JSON.
    pub raw: String,
}

impl ContainerDetails {
    fn from_inspect(inspect: ContainerInspectResponse) -> Result<Self> {
        let raw = serde_json::to_string_pretty(&inspect).map_err(bollard::errors::Error::from)?;
        let id = inspect.id.unwrap_or_default();
        let config = inspect.config.unwrap_or_default();
        let state = inspect.state.unwrap_or_default();
        let host = inspect.host_config.unwrap_or_default();
        let network = inspect.network_settings.unwrap_or_default();
        let labels = config.labels.unwrap_or_default();
        let compose_project = labels
            .get(COMPOSE_PROJECT_LABEL)
            .filter(|p| !p.is_empty())
            .cloned();

        // Command and entrypoint as shown by `docker inspect`: the entrypoint can be empty, and
        // the command is what the image or the user configured (`Path`/`Args` include the entrypoint).
        let mut env: Vec<EnvVar> = config
            .env
            .unwrap_or_default()
            .into_iter()
            .map(|entry| match entry.split_once('=') {
                Some((name, value)) => EnvVar {
                    name: name.to_owned(),
                    value: value.to_owned(),
                },
                None => EnvVar {
                    name: entry,
                    value: String::new(),
                },
            })
            .collect();
        env.sort_by(|a, b| a.name.cmp(&b.name));

        let mut mounts: Vec<MountInfo> = inspect
            .mounts
            .unwrap_or_default()
            .into_iter()
            .map(|m| MountInfo {
                kind: m.typ.map(|t| t.to_string()).unwrap_or_default(),
                name: m.name.filter(|n| !n.is_empty()),
                source: m.source.unwrap_or_default(),
                destination: m.destination.unwrap_or_default(),
                read_write: m.rw.unwrap_or(true),
            })
            .collect();
        mounts.sort_by(|a, b| a.destination.cmp(&b.destination));

        let mut networks: Vec<NetworkAttachment> = network
            .networks
            .unwrap_or_default()
            .into_iter()
            .map(|(name, e)| NetworkAttachment {
                name,
                network_id: e.network_id.unwrap_or_default(),
                ip_address: e.ip_address.unwrap_or_default(),
                gateway: e.gateway.unwrap_or_default(),
                mac_address: e.mac_address.unwrap_or_default(),
                aliases: e.aliases.unwrap_or_default(),
            })
            .collect();
        networks.sort_by(|a, b| a.name.cmp(&b.name));

        let mut labels: Vec<Label> = labels
            .into_iter()
            .map(|(key, value)| Label { key, value })
            .collect();
        labels.sort_by(|a, b| a.key.cmp(&b.key));

        let health = state.health.and_then(|h| h.status).and_then(|s| match s {
            HealthStatusEnum::STARTING => Some(ContainerHealth::Starting),
            HealthStatusEnum::HEALTHY => Some(ContainerHealth::Healthy),
            HealthStatusEnum::UNHEALTHY => Some(ContainerHealth::Unhealthy),
            _ => None,
        });
        let restart = host.restart_policy.unwrap_or_default();

        Ok(Self {
            name: inspect
                .name
                .map(|n| n.trim_start_matches('/').to_owned())
                .filter(|n| !n.is_empty())
                .unwrap_or_else(|| id.chars().take(12).collect()),
            id,
            image: config.image.unwrap_or_default(),
            image_id: inspect.image.unwrap_or_default(),
            state: match state.status {
                Some(ContainerStateStatusEnum::CREATED) => ContainerState::Created,
                Some(ContainerStateStatusEnum::RUNNING) => ContainerState::Running,
                Some(ContainerStateStatusEnum::PAUSED) => ContainerState::Paused,
                Some(ContainerStateStatusEnum::RESTARTING) => ContainerState::Restarting,
                Some(ContainerStateStatusEnum::EXITED) => ContainerState::Exited,
                Some(ContainerStateStatusEnum::REMOVING) => ContainerState::Removing,
                Some(ContainerStateStatusEnum::DEAD) => ContainerState::Dead,
                _ => ContainerState::Unknown,
            },
            health,
            created: inspect.created.map(|d| d.to_string()).unwrap_or_default(),
            command: config.cmd.unwrap_or_default(),
            entrypoint: config.entrypoint.unwrap_or_default(),
            restart_policy: RestartPolicy {
                name: match host_policy_name(restart.name) {
                    "" => "no",
                    name => name,
                }
                .to_owned(),
                max_retries: restart
                    .maximum_retry_count
                    .unwrap_or(0)
                    .clamp(0, i64::from(u32::MAX)) as u32,
            },
            ports: published_ports(network.ports.unwrap_or_default()),
            env,
            mounts,
            networks,
            labels,
            compose_project,
            raw,
        })
    }
}

fn host_policy_name(name: Option<RestartPolicyNameEnum>) -> &'static str {
    match name {
        Some(RestartPolicyNameEnum::NO) => "no",
        Some(RestartPolicyNameEnum::ALWAYS) => "always",
        Some(RestartPolicyNameEnum::UNLESS_STOPPED) => "unless-stopped",
        Some(RestartPolicyNameEnum::ON_FAILURE) => "on-failure",
        _ => "",
    }
}

/// The published ports of the network settings (`80/tcp` -> host bindings), like the list shows them.
fn published_ports(
    map: HashMap<String, Option<Vec<bollard::models::PortBinding>>>,
) -> Vec<PortMapping> {
    let mut seen = HashSet::new();
    let mut ports: Vec<PortMapping> = map
        .into_iter()
        .flat_map(|(key, bindings)| {
            let (port, protocol) = key.split_once('/').unwrap_or((&key, "tcp"));
            let private_port = port.parse::<u16>().ok();
            let protocol = protocol.to_owned();
            bindings
                .unwrap_or_default()
                .into_iter()
                .filter_map(move |b| {
                    let public_port = b.host_port?.parse::<u16>().ok()?;
                    Some(PortMapping {
                        ip: b.host_ip.filter(|ip| !ip.is_empty()),
                        private_port: private_port?,
                        public_port: Some(public_port),
                        protocol: protocol.clone(),
                    })
                })
        })
        .filter(|p| seen.insert((p.public_port, p.private_port, p.protocol.clone())))
        .collect();
    ports.sort_by_key(|p| (p.public_port, p.private_port));
    ports
}

/// Reads everything the engine knows about one container. `id` is an ID, a prefix or a name; a
/// container that does not exist fails with `ErrorKind::NotFound`.
pub async fn inspect_container(docker: &Docker, id: &str) -> Result<ContainerDetails> {
    ContainerDetails::from_inspect(docker.inspect_container(id, None).await?)
}

/// A lifecycle action on a container.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ContainerAction {
    Start,
    Stop,
    Restart,
    Pause,
    Unpause,
    Kill,
    /// Removes the container; `volumes` also removes its anonymous volumes.
    Remove {
        volumes: bool,
    },
}

/// The container an action is applied to; the name is only used to report.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ActionTarget {
    pub id: String,
    pub name: String,
}

/// Progress of [`run_action`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ActionEvent {
    /// The action is running for this container.
    Started { id: String },
    /// The action ended for this container; `error` is the engine's message when it failed.
    Finished { id: String, error: Option<String> },
}

/// Where an action is sent to: the engine operations behind [`ContainerAction`].
pub trait ContainerActions: Send + Sync {
    fn perform(&self, id: &str, action: ContainerAction)
    -> impl Future<Output = Result<()>> + Send;
}

impl ContainerActions for Docker {
    async fn perform(&self, id: &str, action: ContainerAction) -> Result<()> {
        match action {
            ContainerAction::Start => self.start_container(id, None).await?,
            ContainerAction::Stop => self.stop_container(id, None).await?,
            ContainerAction::Restart => self.restart_container(id, None).await?,
            ContainerAction::Pause => self.pause_container(id).await?,
            ContainerAction::Unpause => self.unpause_container(id).await?,
            ContainerAction::Kill => self.kill_container(id, None).await?,
            ContainerAction::Remove { volumes } => {
                let options = RemoveContainerOptionsBuilder::default().v(volumes).build();
                self.remove_container(id, Some(options)).await?;
            }
        }
        Ok(())
    }
}

/// How many containers of one request are handled at the same time.
const ACTION_CONCURRENCY: usize = 4;

/// The engine's own message, without the client's "Docker responded with status code ..." prefix.
fn engine_message(error: &crate::Error) -> String {
    match error {
        crate::Error::Docker(bollard::errors::Error::DockerResponseServerError {
            message, ..
        }) if !message.is_empty() => message.clone(),
        other => other.to_string(),
    }
}

/// Applies `action` to every target (a few at a time). `emit` gets `Started` for all targets first,
/// then one `Finished` per target as it ends.
///
/// One failing container does not stop the others. Returns the number of failures.
pub async fn run_action<A: ContainerActions>(
    actions: &A,
    targets: Vec<ActionTarget>,
    action: ContainerAction,
    mut emit: impl FnMut(ActionEvent) + Send,
) -> usize {
    let mut failed = 0;
    for target in &targets {
        emit(ActionEvent::Started {
            id: target.id.clone(),
        });
    }
    let mut results = futures_util::stream::iter(targets)
        .map(|target| async move {
            let result = actions.perform(&target.id, action).await;
            (target, result)
        })
        .buffer_unordered(ACTION_CONCURRENCY);
    while let Some((target, result)) = results.next().await {
        let error = result.err().map(|e| engine_message(&e));
        failed += usize::from(error.is_some());
        emit(ActionEvent::Finished {
            id: target.id,
            error,
        });
    }
    failed
}

/// What a container watch sends to the frontend.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ContainerWatchEvent {
    /// The complete container list; replaces what the frontend has.
    Snapshot { containers: Vec<Container> },
    /// The connection to the engine is lost; a retry follows.
    Reconnecting { message: String },
}

/// Where a watch reads from: the list and the change notifications of an engine.
pub trait ContainerSource: Send + Sync {
    fn list(&self) -> impl Future<Output = Result<Vec<Container>>> + Send;
    /// A stream with one item per event that changes a container, replaying events since `since`
    /// (Unix seconds) so that nothing between the list and the subscription is missed.
    fn changes(&self, since: i64) -> BoxStream<'static, Result<()>>;
}

impl ContainerSource for Docker {
    fn list(&self) -> impl Future<Output = Result<Vec<Container>>> + Send {
        list_containers(self)
    }

    fn changes(&self, since: i64) -> BoxStream<'static, Result<()>> {
        let filters = HashMap::from([("type", vec!["container"])]);
        let options = EventsOptionsBuilder::default()
            .since(&since.to_string())
            .filters(&filters)
            .build();
        self.events(Some(options))
            .filter_map(|event| async move {
                match event {
                    Ok(event) => event
                        .action
                        .as_deref()
                        .is_some_and(changes_list)
                        .then_some(Ok(())),
                    Err(error) => Some(Err(error.into())),
                }
            })
            .boxed()
    }
}

/// Whether a container event action changes what the list shows. Exec, attach and similar
/// actions (health checks run as `exec_*`) do not.
fn changes_list(action: &str) -> bool {
    // `health_status: healthy` carries the status after the colon.
    let action = action.split(':').next().unwrap_or(action);
    matches!(
        action,
        "create"
            | "start"
            | "die"
            | "destroy"
            | "stop"
            | "kill"
            | "pause"
            | "unpause"
            | "restart"
            | "rename"
            | "oom"
            | "update"
            | "health_status"
    )
}

/// Timing of a watch.
#[derive(Debug, Clone, Copy)]
pub struct WatchTiming {
    /// Events within this time of each other lead to one snapshot.
    pub debounce: Duration,
    /// The wait before the first reconnect; it doubles up to `max_backoff`.
    pub min_backoff: Duration,
    pub max_backoff: Duration,
}

impl Default for WatchTiming {
    fn default() -> Self {
        Self {
            debounce: Duration::from_millis(100),
            min_backoff: Duration::from_secs(1),
            max_backoff: Duration::from_secs(15),
        }
    }
}

fn unix_now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs() as i64)
}

/// Why one connection of a watch ended.
enum Ended {
    Cancelled,
    Lost(String),
}

/// Sends the container list to `emit` and keeps it current until `cancel` is notified.
///
/// A lost connection is reported as [`ContainerWatchEvent::Reconnecting`] and retried with a
/// growing backoff; the first snapshot after a reconnect resynchronizes the frontend.
pub async fn watch_containers<S: ContainerSource>(
    source: &S,
    cancel: &Notify,
    timing: WatchTiming,
    mut emit: impl FnMut(ContainerWatchEvent) + Send,
) {
    let mut backoff = timing.min_backoff;
    loop {
        let message = match watch_once(source, cancel, timing, &mut backoff, &mut emit).await {
            Ended::Cancelled => return,
            Ended::Lost(message) => message,
        };
        emit(ContainerWatchEvent::Reconnecting { message });
        tokio::select! {
            () = cancel.notified() => return,
            () = tokio::time::sleep(backoff) => {}
        }
        backoff = (backoff * 2).min(timing.max_backoff);
    }
}

async fn watch_once<S: ContainerSource>(
    source: &S,
    cancel: &Notify,
    timing: WatchTiming,
    backoff: &mut Duration,
    emit: &mut (impl FnMut(ContainerWatchEvent) + Send),
) -> Ended {
    let since = unix_now();
    let mut changes = source.changes(since);
    let mut connected = false;
    loop {
        let listed = tokio::select! {
            () = cancel.notified() => return Ended::Cancelled,
            listed = source.list() => listed,
        };
        match listed {
            Ok(containers) => {
                if !connected {
                    connected = true;
                    *backoff = timing.min_backoff;
                }
                emit(ContainerWatchEvent::Snapshot { containers });
            }
            Err(error) => return Ended::Lost(error.to_string()),
        }
        // Wait for a change, then absorb the burst that follows it.
        let first = tokio::select! {
            () = cancel.notified() => return Ended::Cancelled,
            next = changes.next() => next,
        };
        match first {
            Some(Ok(())) => {}
            Some(Err(error)) => return Ended::Lost(error.to_string()),
            None => return Ended::Lost("The event stream ended.".to_owned()),
        }
        loop {
            let next = tokio::select! {
                () = cancel.notified() => return Ended::Cancelled,
                next = tokio::time::timeout(timing.debounce, changes.next()) => next,
            };
            match next {
                Err(_elapsed) => break,
                Ok(Some(Ok(()))) => {}
                Ok(Some(Err(error))) => return Ended::Lost(error.to_string()),
                Ok(None) => return Ended::Lost("The event stream ended.".to_owned()),
            }
        }
    }
}

/// The running watches by id, so that a watch can be stopped from another command.
///
/// The frontend picks the id. Stopping an id that has not started yet is remembered, so a watch
/// that is closed right after it was requested never runs.
#[derive(Default)]
pub struct Watches {
    cancels: Mutex<HashMap<String, Arc<Notify>>>,
}

impl Watches {
    /// The cancel signal of the watch `id`; call [`Watches::finish`] when the watch ends.
    pub fn register(&self, id: &str) -> Arc<Notify> {
        let mut cancels = self.cancels.lock().expect("watches lock");
        Arc::clone(cancels.entry(id.to_owned()).or_default())
    }

    /// Stops the watch `id`.
    pub fn cancel(&self, id: &str) {
        self.register(id).notify_one();
    }

    /// Forgets the watch `id`.
    pub fn finish(&self, id: &str) {
        self.cancels.lock().expect("watches lock").remove(id);
    }
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use bollard::models::{ContainerSummaryHealth, PortSummary};
    use tokio::sync::mpsc;

    use super::*;
    use crate::Error;

    fn summary(id: &str, name: &str) -> ContainerSummary {
        ContainerSummary {
            id: Some(id.to_owned()),
            names: Some(vec![format!("/{name}")]),
            image: Some("nginx:latest".to_owned()),
            state: Some(ContainerSummaryStateEnum::RUNNING),
            status: Some("Up 2 hours".to_owned()),
            created: Some(1_700_000_000),
            ..Default::default()
        }
    }

    fn container(name: &str) -> Container {
        Container::from_summary(summary(&format!("id-{name}"), name)).unwrap()
    }

    #[test]
    fn maps_a_summary() {
        let mut s = summary("abc", "web");
        s.labels = Some(HashMap::from([(
            COMPOSE_PROJECT_LABEL.to_owned(),
            "shop".to_owned(),
        )]));
        s.health = Some(ContainerSummaryHealth {
            status: Some(ContainerSummaryHealthStatusEnum::UNHEALTHY),
            ..Default::default()
        });
        let c = Container::from_summary(s).unwrap();
        assert_eq!(c.name, "web");
        assert_eq!(c.state, ContainerState::Running);
        assert_eq!(c.health, Some(ContainerHealth::Unhealthy));
        assert_eq!(c.compose_project.as_deref(), Some("shop"));
        assert_eq!(c.created, 1_700_000_000);
    }

    #[test]
    fn falls_back_to_the_status_text_for_health_and_the_id_for_the_name() {
        let mut s = summary("0123456789abcdef", "x");
        s.names = None;
        s.status = Some("Up 1 minute (healthy)".to_owned());
        let c = Container::from_summary(s).unwrap();
        assert_eq!(c.name, "0123456789ab");
        assert_eq!(c.health, Some(ContainerHealth::Healthy));
        assert_eq!(c.compose_project, None);
    }

    #[test]
    fn keeps_only_published_ports_once() {
        let port = |ip: &str, private, public| PortSummary {
            ip: Some(ip.to_owned()),
            private_port: private,
            public_port: public,
            typ: Some(PortSummaryTypeEnum::TCP),
        };
        let mut s = summary("a", "web");
        s.ports = Some(vec![
            port("0.0.0.0", 80, Some(8080)),
            port("::", 80, Some(8080)),
            port("", 443, None),
        ]);
        let c = Container::from_summary(s).unwrap();
        assert_eq!(c.ports.len(), 1);
        assert_eq!(c.ports[0].public_port, Some(8080));
    }

    #[test]
    fn a_summary_without_id_is_skipped() {
        let mut s = summary("a", "web");
        s.id = None;
        assert!(Container::from_summary(s).is_none());
    }

    #[test]
    fn only_state_changing_actions_refresh_the_list() {
        for action in [
            "create",
            "start",
            "die",
            "destroy",
            "health_status: healthy",
        ] {
            assert!(changes_list(action), "{action}");
        }
        for action in ["exec_create: sh", "exec_start: sh", "attach", "resize"] {
            assert!(!changes_list(action), "{action}");
        }
    }

    /// A scripted engine: each call of `changes` hands out the next stream; `list` the next result.
    struct Fake {
        lists: Mutex<VecDeque<Result<Vec<Container>>>>,
        streams: Mutex<VecDeque<Vec<Result<()>>>>,
        changes_calls: AtomicUsize,
    }

    impl Fake {
        fn new(lists: Vec<Result<Vec<Container>>>, streams: Vec<Vec<Result<()>>>) -> Self {
            Self {
                lists: Mutex::new(lists.into()),
                streams: Mutex::new(streams.into()),
                changes_calls: AtomicUsize::new(0),
            }
        }
    }

    impl ContainerSource for Fake {
        async fn list(&self) -> Result<Vec<Container>> {
            // The last scripted result repeats.
            let mut lists = self.lists.lock().unwrap();
            if lists.len() > 1 {
                lists.pop_front().unwrap()
            } else {
                match lists.front().unwrap() {
                    Ok(v) => Ok(v.clone()),
                    Err(_) => Err(Error::InvalidAddress("down".to_owned())),
                }
            }
        }

        fn changes(&self, _since: i64) -> BoxStream<'static, Result<()>> {
            self.changes_calls.fetch_add(1, Ordering::SeqCst);
            let items = self.streams.lock().unwrap().pop_front().unwrap_or_default();
            // After the scripted items the stream stays open until the watch is cancelled.
            futures_util::stream::iter(items)
                .chain(futures_util::stream::pending())
                .boxed()
        }
    }

    const FAST: WatchTiming = WatchTiming {
        debounce: Duration::from_millis(20),
        min_backoff: Duration::from_millis(5),
        max_backoff: Duration::from_millis(20),
    };

    /// Runs a watch and collects its events until `until` of them arrived, then cancels it.
    async fn collect(fake: Fake, until: usize) -> Vec<ContainerWatchEvent> {
        let cancel = Arc::new(Notify::new());
        let (tx, mut rx) = mpsc::unbounded_channel();
        let task = {
            let cancel = Arc::clone(&cancel);
            tokio::spawn(async move {
                watch_containers(&fake, &cancel, FAST, |e| {
                    let _ = tx.send(e);
                })
                .await;
            })
        };
        let mut events = Vec::new();
        while events.len() < until {
            let event = tokio::time::timeout(Duration::from_secs(5), rx.recv())
                .await
                .expect("watch stalled")
                .expect("watch ended early");
            events.push(event);
        }
        cancel.notify_one();
        task.await.unwrap();
        events
    }

    fn snapshot(names: &[&str]) -> ContainerWatchEvent {
        ContainerWatchEvent::Snapshot {
            containers: names.iter().map(|n| container(n)).collect(),
        }
    }

    #[tokio::test]
    async fn sends_a_snapshot_then_one_per_burst_of_events() {
        let fake = Fake::new(
            vec![
                Ok(vec![container("a")]),
                Ok(vec![container("a"), container("b")]),
            ],
            vec![vec![Ok(()), Ok(()), Ok(())]],
        );
        let events = collect(fake, 2).await;
        assert_eq!(events, vec![snapshot(&["a"]), snapshot(&["a", "b"])]);
    }

    #[tokio::test]
    async fn reconnects_after_the_stream_ends_and_resends_the_list() {
        let fake = Fake::new(
            vec![Ok(vec![container("a")])],
            vec![vec![Err(Error::InvalidAddress("gone".to_owned()))], vec![]],
        );
        let events = collect(fake, 3).await;
        assert_eq!(events[0], snapshot(&["a"]));
        assert!(matches!(
            &events[1],
            ContainerWatchEvent::Reconnecting { message } if message.contains("gone")
        ));
        assert_eq!(events[2], snapshot(&["a"]));
    }

    #[tokio::test]
    async fn retries_while_the_engine_is_down() {
        let fake = Fake::new(
            vec![
                Err(Error::InvalidAddress("down".to_owned())),
                Err(Error::InvalidAddress("down".to_owned())),
                Ok(vec![container("a")]),
            ],
            vec![],
        );
        let events = collect(fake, 3).await;
        assert!(matches!(
            events[0],
            ContainerWatchEvent::Reconnecting { .. }
        ));
        assert!(matches!(
            events[1],
            ContainerWatchEvent::Reconnecting { .. }
        ));
        assert_eq!(events[2], snapshot(&["a"]));
    }

    #[tokio::test]
    async fn watches_can_be_cancelled_before_they_start() {
        let watches = Watches::default();
        watches.cancel("w1");
        let cancel = watches.register("w1");
        let fake = Fake::new(vec![Ok(vec![])], vec![]);
        // The stored cancel ends the watch without waiting for any event.
        tokio::time::timeout(
            Duration::from_secs(5),
            watch_containers(&fake, &cancel, FAST, |_| {}),
        )
        .await
        .expect("a cancelled watch ends");
        watches.finish("w1");
        assert!(watches.cancels.lock().unwrap().is_empty());
    }

    #[test]
    fn events_serialize_with_a_type_tag() {
        let json = serde_json::to_value(snapshot(&["a"])).unwrap();
        assert_eq!(json["type"], "snapshot");
        assert_eq!(json["containers"][0]["name"], "a");
        assert_eq!(json["containers"][0]["state"], "running");
        assert!(json["containers"][0]["composeProject"].is_null());
    }

    /// An engine that fails for the ids listed in `failing` and records what it was asked.
    struct Recorder {
        failing: Vec<&'static str>,
        calls: Mutex<Vec<(String, ContainerAction)>>,
    }

    impl ContainerActions for Recorder {
        async fn perform(&self, id: &str, action: ContainerAction) -> Result<()> {
            self.calls.lock().unwrap().push((id.to_owned(), action));
            if self.failing.contains(&id) {
                Err(bollard::errors::Error::DockerResponseServerError {
                    status_code: 409,
                    message: format!("container {id} is running"),
                }
                .into())
            } else {
                Ok(())
            }
        }
    }

    fn target(id: &str) -> ActionTarget {
        ActionTarget {
            id: id.to_owned(),
            name: format!("name-{id}"),
        }
    }

    #[tokio::test]
    async fn an_action_reports_progress_and_the_engine_message_per_container() {
        let engine = Recorder {
            failing: vec!["b"],
            calls: Mutex::default(),
        };
        let mut events = Vec::new();
        let failed = run_action(
            &engine,
            vec![target("a"), target("b"), target("c")],
            ContainerAction::Remove { volumes: true },
            |e| events.push(e),
        )
        .await;
        assert_eq!(failed, 1);
        assert_eq!(events.len(), 6);
        for id in ["a", "b", "c"] {
            assert!(events.contains(&ActionEvent::Started { id: id.to_owned() }));
        }
        // Started comes before any Finished.
        assert!(
            events[..3]
                .iter()
                .all(|e| matches!(e, ActionEvent::Started { .. }))
        );
        assert!(events.contains(&ActionEvent::Finished {
            id: "b".to_owned(),
            error: Some("container b is running".to_owned()),
        }));
        assert!(events.contains(&ActionEvent::Finished {
            id: "a".to_owned(),
            error: None,
        }));
        let calls = engine.calls.lock().unwrap();
        assert_eq!(calls.len(), 3, "a failure does not stop the others");
        assert!(
            calls
                .iter()
                .all(|(_, a)| *a == ContainerAction::Remove { volumes: true })
        );
    }

    #[tokio::test]
    async fn no_targets_means_no_events() {
        let engine = Recorder {
            failing: vec![],
            calls: Mutex::default(),
        };
        let mut count = 0;
        let failed = run_action(&engine, vec![], ContainerAction::Stop, |_| count += 1).await;
        assert_eq!((failed, count), (0, 0));
    }

    #[test]
    fn actions_and_events_use_a_type_tag() {
        let action: ContainerAction =
            serde_json::from_str(r#"{"type":"remove","volumes":true}"#).unwrap();
        assert_eq!(action, ContainerAction::Remove { volumes: true });
        let action: ContainerAction = serde_json::from_str(r#"{"type":"kill"}"#).unwrap();
        assert_eq!(action, ContainerAction::Kill);
        let json = serde_json::to_value(ActionEvent::Finished {
            id: "a".to_owned(),
            error: None,
        })
        .unwrap();
        assert_eq!(json["type"], "finished");
        assert!(json["error"].is_null());
    }

    #[test]
    fn a_non_engine_error_keeps_its_text() {
        let error = Error::InvalidAddress("x".to_owned());
        assert_eq!(engine_message(&error), error.to_string());
    }

    fn inspect_json() -> ContainerInspectResponse {
        serde_json::from_value(serde_json::json!({
            "Id": "abc123",
            "Name": "/web",
            "Created": "2024-01-02T03:04:05.123456789Z",
            "Image": "sha256:feed",
            "State": {"Status": "running", "Health": {"Status": "healthy"}},
            "HostConfig": {"RestartPolicy": {"Name": "on-failure", "MaximumRetryCount": 3}},
            "Config": {
                "Image": "nginx:latest",
                "Cmd": ["nginx", "-g", "daemon off;"],
                "Entrypoint": ["/docker-entrypoint.sh"],
                "Env": ["PATH=/usr/bin", "TOKEN=a=b", "EMPTY"],
                "Labels": {"com.docker.compose.project": "shop", "a": "1"}
            },
            "Mounts": [
                {"Type": "volume", "Name": "data", "Source": "/var/lib/docker/volumes/data/_data",
                 "Destination": "/data", "RW": true},
                {"Type": "bind", "Source": "/etc/conf", "Destination": "/conf", "RW": false}
            ],
            "NetworkSettings": {
                "Ports": {
                    "80/tcp": [{"HostIp": "0.0.0.0", "HostPort": "8080"}, {"HostIp": "::", "HostPort": "8080"}],
                    "443/tcp": null
                },
                "Networks": {
                    "shop_default": {"NetworkID": "net1", "IPAddress": "172.18.0.2", "Gateway": "172.18.0.1",
                                     "MacAddress": "02:42", "Aliases": ["web"]},
                    "bridge": {"NetworkID": "net0"}
                }
            }
        }))
        .unwrap()
    }

    #[test]
    fn maps_an_inspect_response() {
        let d = ContainerDetails::from_inspect(inspect_json()).unwrap();
        assert_eq!((d.id.as_str(), d.name.as_str()), ("abc123", "web"));
        assert_eq!(
            (d.image.as_str(), d.image_id.as_str()),
            ("nginx:latest", "sha256:feed")
        );
        assert_eq!(d.state, ContainerState::Running);
        assert_eq!(d.health, Some(ContainerHealth::Healthy));
        assert!(
            d.created.starts_with("2024-01-02T03:04:05"),
            "{}",
            d.created
        );
        assert_eq!(d.command, ["nginx", "-g", "daemon off;"]);
        assert_eq!(d.entrypoint, ["/docker-entrypoint.sh"]);
        assert_eq!(d.restart_policy.name, "on-failure");
        assert_eq!(d.restart_policy.max_retries, 3);
        assert_eq!(d.compose_project.as_deref(), Some("shop"));
        assert_eq!(d.labels[0].key, "a");
        // The first `=` splits; a value may contain more.
        let env: Vec<_> = d
            .env
            .iter()
            .map(|e| (e.name.as_str(), e.value.as_str()))
            .collect();
        assert_eq!(env, [("EMPTY", ""), ("PATH", "/usr/bin"), ("TOKEN", "a=b")]);
        assert_eq!(d.mounts[0].destination, "/conf");
        assert!(!d.mounts[0].read_write);
        assert_eq!(d.mounts[1].name.as_deref(), Some("data"));
        assert_eq!(d.mounts[1].kind, "volume");
        let nets: Vec<_> = d.networks.iter().map(|n| n.name.as_str()).collect();
        assert_eq!(nets, ["bridge", "shop_default"]);
        assert_eq!(d.networks[1].ip_address, "172.18.0.2");
        assert_eq!(d.networks[1].aliases, ["web"]);
        // IPv4 and IPv6 bindings count once; an exposed but unpublished port is left out.
        assert_eq!(d.ports.len(), 1);
        assert_eq!(
            (d.ports[0].public_port, d.ports[0].private_port),
            (Some(8080), 80)
        );
        let raw: serde_json::Value = serde_json::from_str(&d.raw).unwrap();
        assert_eq!(raw["Id"], "abc123");
    }

    #[test]
    fn an_empty_inspect_response_has_defaults() {
        let d = ContainerDetails::from_inspect(ContainerInspectResponse {
            id: Some("0123456789abcdef".to_owned()),
            ..Default::default()
        })
        .unwrap();
        assert_eq!(d.name, "0123456789ab");
        assert_eq!(d.state, ContainerState::Unknown);
        assert_eq!(d.restart_policy.name, "no");
        assert_eq!(d.health, None);
        assert!(d.env.is_empty() && d.mounts.is_empty() && d.networks.is_empty());
    }
}
