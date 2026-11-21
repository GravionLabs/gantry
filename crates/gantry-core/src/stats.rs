//! Container resource stats: `docker stats` as a stream of computed samples.

use bollard::Docker;
use bollard::models::ContainerStatsResponse;
use bollard::query_parameters::StatsOptionsBuilder;
use futures_util::{Stream, StreamExt};
use serde::Serialize;
use specta::Type;
use tokio::sync::Notify;

use crate::Result;

/// One reading of a container's resource use, computed like `docker stats`.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
// Byte counts are `f64` (exact up to 2^53): the IPC types forbid 64-bit integers.
pub struct StatsSample {
    /// CPU use in percent of one core, so it exceeds 100 on a container using several cores.
    pub cpu_percent: f64,
    /// Memory in use in bytes, without the page cache that can be reclaimed.
    pub memory_usage: f64,
    /// Memory limit in bytes; 0 when the engine reports none.
    pub memory_limit: f64,
    /// Bytes received over all network interfaces since the container started.
    pub network_rx: f64,
    /// Bytes sent over all network interfaces since the container started.
    pub network_tx: f64,
    /// Bytes read from block devices since the container started.
    pub block_read: f64,
    /// Bytes written to block devices since the container started.
    pub block_write: f64,
}

/// What a stats stream sends to the frontend.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Type)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum StatsEvent {
    /// The latest reading; the engine sends about one per second.
    Sample { sample: StatsSample },
}

/// CPU use in percent, as `docker stats` computes it: the container's share of the host's CPU time
/// between the previous and the current reading, times the number of CPUs.
fn cpu_percent(stats: &ContainerStatsResponse) -> f64 {
    let (Some(cpu), Some(pre)) = (&stats.cpu_stats, &stats.precpu_stats) else {
        return 0.0;
    };
    let total = |c: &bollard::models::ContainerCpuStats| {
        c.cpu_usage
            .as_ref()
            .and_then(|u| u.total_usage)
            .unwrap_or(0)
    };
    let cpu_delta = total(cpu).saturating_sub(total(pre));
    let system_delta = cpu
        .system_cpu_usage
        .unwrap_or(0)
        .saturating_sub(pre.system_cpu_usage.unwrap_or(0));
    if cpu_delta == 0 || system_delta == 0 {
        return 0.0;
    }
    let online = cpu
        .online_cpus
        .filter(|n| *n > 0)
        .map(f64::from)
        .or_else(|| {
            let per_cpu = cpu.cpu_usage.as_ref()?.percpu_usage.as_ref()?.len();
            (per_cpu > 0).then_some(per_cpu as f64)
        })
        .unwrap_or(1.0);
    cpu_delta as f64 / system_delta as f64 * online * 100.0
}

/// Memory in use as `docker stats` shows it: the usage without the inactive file cache
/// (`inactive_file` on cgroup v2, `total_inactive_file` on v1).
fn memory_usage(stats: &ContainerStatsResponse) -> (u64, u64) {
    let Some(memory) = &stats.memory_stats else {
        return (0, 0);
    };
    let usage = memory.usage.unwrap_or(0);
    let cache = memory
        .stats
        .as_ref()
        .and_then(|s| {
            s.get("inactive_file")
                .or_else(|| s.get("total_inactive_file"))
        })
        .copied()
        .unwrap_or(0);
    let used = if cache < usage { usage - cache } else { usage };
    (used, memory.limit.unwrap_or(0))
}

fn network_bytes(stats: &ContainerStatsResponse) -> (u64, u64) {
    stats
        .networks
        .iter()
        .flat_map(|n| n.values())
        .fold((0, 0), |(rx, tx), n| {
            (
                rx.saturating_add(n.rx_bytes.unwrap_or(0)),
                tx.saturating_add(n.tx_bytes.unwrap_or(0)),
            )
        })
}

fn block_bytes(stats: &ContainerStatsResponse) -> (u64, u64) {
    let entries = stats
        .blkio_stats
        .iter()
        .flat_map(|b| b.io_service_bytes_recursive.iter().flatten());
    entries.fold((0, 0), |(read, write), entry| {
        let value = entry.value.unwrap_or(0);
        match entry.op.as_deref().map(str::to_ascii_lowercase).as_deref() {
            Some("read") => (read.saturating_add(value), write),
            Some("write") => (read, write.saturating_add(value)),
            _ => (read, write),
        }
    })
}

/// Computes the sample of one engine reading.
pub fn sample_of(stats: &ContainerStatsResponse) -> StatsSample {
    let (memory_usage, memory_limit) = memory_usage(stats);
    let (network_rx, network_tx) = network_bytes(stats);
    let (block_read, block_write) = block_bytes(stats);
    StatsSample {
        cpu_percent: cpu_percent(stats),
        memory_usage: memory_usage as f64,
        memory_limit: memory_limit as f64,
        network_rx: network_rx as f64,
        network_tx: network_tx as f64,
        block_read: block_read as f64,
        block_write: block_write as f64,
    }
}

/// Streams the stats of container `id` to `emit` until the container stops, `cancel` is notified
/// or the engine fails. A container that does not exist fails with `ErrorKind::NotFound`.
pub async fn stream_stats(
    docker: &Docker,
    id: &str,
    cancel: &Notify,
    emit: impl FnMut(StatsEvent) + Send,
) -> Result<()> {
    let options = StatsOptionsBuilder::default().stream(true).build();
    forward_stats(docker.stats(id, Some(options)), cancel, emit).await
}

async fn forward_stats(
    stats: impl Stream<Item = std::result::Result<ContainerStatsResponse, bollard::errors::Error>>,
    cancel: &Notify,
    mut emit: impl FnMut(StatsEvent) + Send,
) -> Result<()> {
    let mut stats = std::pin::pin!(stats);
    loop {
        let next = tokio::select! {
            () = cancel.notified() => return Ok(()),
            next = stats.next() => next,
        };
        match next {
            None => return Ok(()),
            Some(Err(error)) => return Err(error.into()),
            Some(Ok(reading)) => emit(StatsEvent::Sample {
                sample: sample_of(&reading),
            }),
        }
    }
}

#[cfg(test)]
mod tests {
    use futures_util::stream;

    use super::*;

    /// A reading recorded from `GET /containers/{id}/stats` on a cgroup v2 host (Docker 27).
    const V2: &str = r#"{
        "read": "2026-11-21T10:00:01.000000000Z",
        "cpu_stats": {
            "cpu_usage": {"total_usage": 1200000000, "usage_in_kernelmode": 200000000, "usage_in_usermode": 1000000000},
            "system_cpu_usage": 80000000000,
            "online_cpus": 4
        },
        "precpu_stats": {
            "cpu_usage": {"total_usage": 1000000000},
            "system_cpu_usage": 76000000000,
            "online_cpus": 4
        },
        "memory_stats": {
            "usage": 52428800,
            "limit": 1073741824,
            "stats": {"anon": 20000000, "inactive_file": 10485760, "file": 30000000}
        },
        "networks": {
            "eth0": {"rx_bytes": 1000, "tx_bytes": 500},
            "eth1": {"rx_bytes": 24, "tx_bytes": 12}
        },
        "blkio_stats": {
            "io_service_bytes_recursive": [
                {"major": 8, "minor": 0, "op": "read", "value": 4096},
                {"major": 8, "minor": 0, "op": "write", "value": 8192},
                {"major": 8, "minor": 16, "op": "Read", "value": 100},
                {"major": 8, "minor": 0, "op": "discard", "value": 7}
            ]
        }
    }"#;

    /// A reading recorded on a cgroup v1 host: cache under `total_inactive_file`, no `online_cpus`.
    const V1: &str = r#"{
        "cpu_stats": {
            "cpu_usage": {"total_usage": 500, "percpu_usage": [100, 100, 150, 150]},
            "system_cpu_usage": 2000
        },
        "precpu_stats": {
            "cpu_usage": {"total_usage": 100, "percpu_usage": [25, 25, 25, 25]},
            "system_cpu_usage": 1000
        },
        "memory_stats": {
            "usage": 1000,
            "limit": 0,
            "stats": {"total_inactive_file": 400}
        }
    }"#;

    fn reading(json: &str) -> ContainerStatsResponse {
        serde_json::from_str(json).expect("recorded sample parses")
    }

    #[test]
    fn computes_cpu_like_docker_stats() {
        // (200M / 4000M) * 4 cpus * 100 = 20 %
        let sample = sample_of(&reading(V2));
        assert!((sample.cpu_percent - 20.0).abs() < 1e-9, "{sample:?}");
    }

    #[test]
    fn counts_cpus_from_the_per_cpu_usage_without_online_cpus() {
        // (400 / 1000) * 4 * 100 = 160 %
        let sample = sample_of(&reading(V1));
        assert!((sample.cpu_percent - 160.0).abs() < 1e-9, "{sample:?}");
    }

    #[test]
    fn cpu_is_zero_without_a_previous_reading_or_progress() {
        let mut first = reading(V2);
        first.precpu_stats = None;
        assert_eq!(sample_of(&first).cpu_percent, 0.0);

        let mut idle = reading(V2);
        idle.precpu_stats = idle.cpu_stats.clone();
        assert_eq!(sample_of(&idle).cpu_percent, 0.0);

        let mut reset = reading(V2);
        reset.cpu_stats.as_mut().unwrap().system_cpu_usage = Some(1);
        assert_eq!(sample_of(&reset).cpu_percent, 0.0);
    }

    #[test]
    fn memory_leaves_out_the_inactive_file_cache() {
        let v2 = sample_of(&reading(V2));
        assert_eq!(v2.memory_usage, (52_428_800 - 10_485_760) as f64);
        assert_eq!(v2.memory_limit, 1_073_741_824.0);

        let v1 = sample_of(&reading(V1));
        assert_eq!(v1.memory_usage, 600.0);
        assert_eq!(v1.memory_limit, 0.0);
    }

    #[test]
    fn sums_network_and_block_io() {
        let sample = sample_of(&reading(V2));
        assert_eq!((sample.network_rx, sample.network_tx), (1024.0, 512.0));
        assert_eq!((sample.block_read, sample.block_write), (4196.0, 8192.0));
    }

    #[test]
    fn a_reading_without_data_is_all_zero() {
        let sample = sample_of(&reading("{}"));
        assert_eq!(
            sample,
            StatsSample {
                cpu_percent: 0.0,
                memory_usage: 0.0,
                memory_limit: 0.0,
                network_rx: 0.0,
                network_tx: 0.0,
                block_read: 0.0,
                block_write: 0.0,
            }
        );
    }

    #[tokio::test]
    async fn forwards_every_reading_until_the_stream_ends() {
        let mut samples = Vec::new();
        let cancel = Notify::new();
        let items = vec![Ok(reading(V2)), Ok(reading(V1))];
        forward_stats(
            stream::iter(items),
            &cancel,
            |StatsEvent::Sample { sample }| {
                samples.push(sample);
            },
        )
        .await
        .unwrap();
        assert_eq!(samples.len(), 2);
        assert_eq!(samples[1].memory_usage, 600.0);
    }

    #[tokio::test]
    async fn an_engine_error_ends_the_stream() {
        let items = vec![
            Ok(reading(V2)),
            Err(bollard::errors::Error::DockerContainerWaitError {
                error: "boom".into(),
                code: 1,
            }),
        ];
        let mut count = 0;
        let cancel = Notify::new();
        let result = forward_stats(stream::iter(items), &cancel, |_| count += 1).await;
        assert!(result.is_err());
        assert_eq!(count, 1);
    }

    #[tokio::test]
    async fn cancel_ends_an_open_stream() {
        let cancel = Notify::new();
        cancel.notify_one();
        forward_stats(stream::pending(), &cancel, |_| {})
            .await
            .unwrap();
    }
}
