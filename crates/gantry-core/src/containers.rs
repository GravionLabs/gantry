//! The container list and its live updates from the engine's `/events` stream.
//!
//! The list is event driven: [`watch_containers`] sends a full snapshot first, then a new snapshot
//! after every event that changes a container (events are coalesced), and reconnects with a backoff
//! when the stream ends, for example after an engine restart.

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use bollard::Docker;
use bollard::models::{
    ContainerSummary, ContainerSummaryHealthStatusEnum, ContainerSummaryStateEnum,
    PortSummaryTypeEnum,
};
use bollard::query_parameters::{EventsOptionsBuilder, ListContainersOptionsBuilder};
use futures_util::StreamExt;
use futures_util::stream::BoxStream;
use serde::Serialize;
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
}
