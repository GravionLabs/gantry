//! System overview and cleanup: engine information, disk usage per category from `system df`,
//! and a guided prune of containers, images, volumes and the build cache.

use bollard::Docker;
use bollard::models::{SystemDataUsageResponse, SystemInfo};
use bollard::query_parameters::{
    DataUsageOptionsBuilder, PruneBuildOptionsBuilder, PruneContainersOptionsBuilder,
};
use serde::{Deserialize, Serialize};
use specta::Type;

use crate::{Container, ContainerState, Image, Result, Volume};

/// What the engine reports about itself.
// Byte counts are `f64` (exact up to 2^53): the IPC types forbid 64-bit integers.
#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct EngineDetails {
    pub version: Option<String>,
    pub api_version: Option<String>,
    /// The operating system of the host, e.g. `Ubuntu 24.04 LTS`; falls back to `linux`.
    pub os: Option<String>,
    pub arch: Option<String>,
    pub cpus: Option<u32>,
    /// Total memory of the host in bytes.
    pub memory: Option<f64>,
    pub storage_driver: Option<String>,
}

/// The kinds of data a cleanup can remove.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum CleanupCategory {
    /// Stopped containers.
    Containers,
    /// Dangling images (no tag, no container).
    Images,
    /// Volumes no container uses, named ones included.
    Volumes,
    /// Build cache records no build uses.
    BuildCache,
}

/// The categories in the order the UI shows them.
const CATEGORIES: [CleanupCategory; 4] = [
    CleanupCategory::Containers,
    CleanupCategory::Images,
    CleanupCategory::Volumes,
    CleanupCategory::BuildCache,
];

/// The disk usage of one category as `system df` reports it. A value the engine does not report
/// (an engine older than API 1.52 reports a different shape) is `None`.
#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DiskUsage {
    pub category: CleanupCategory,
    pub total_count: Option<u32>,
    pub active_count: Option<u32>,
    /// Disk space in use, in bytes.
    pub size: Option<f64>,
    /// Disk space a cleanup of the category frees, in bytes.
    pub reclaimable: Option<f64>,
}

/// Engine information and disk usage at a glance.
#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SystemOverview {
    pub engine: EngineDetails,
    pub usage: Vec<DiskUsage>,
}

fn count(value: Option<i64>) -> Option<u32> {
    value.map(|v| v.clamp(0, i64::from(u32::MAX)) as u32)
}

fn bytes(value: Option<i64>) -> Option<f64> {
    value.map(|v| v.max(0) as f64)
}

/// The engine details out of `info`, with the API version of `version`.
fn engine_of(info: SystemInfo, api_version: Option<String>) -> EngineDetails {
    let non_empty = |s: Option<String>| s.filter(|s| !s.is_empty());
    EngineDetails {
        version: non_empty(info.server_version),
        api_version,
        os: non_empty(info.operating_system).or_else(|| non_empty(info.os_type)),
        arch: non_empty(info.architecture),
        cpus: count(info.ncpu).filter(|n| *n > 0),
        memory: bytes(info.mem_total).filter(|m| *m > 0.0),
        storage_driver: non_empty(info.driver),
    }
}

/// The disk usage of the four categories out of `system df`.
fn usage_of(df: SystemDataUsageResponse) -> Vec<DiskUsage> {
    let row = |category, total, active, size, reclaimable| DiskUsage {
        category,
        total_count: count(total),
        active_count: count(active),
        size: bytes(size),
        reclaimable: bytes(reclaimable),
    };
    let containers = df.container_usage.unwrap_or_default();
    let images = df.image_usage.unwrap_or_default();
    let volumes = df.volume_usage.unwrap_or_default();
    let cache = df.build_cache_usage.unwrap_or_default();
    vec![
        row(
            CleanupCategory::Containers,
            containers.total_count,
            containers.active_count,
            containers.total_size,
            containers.reclaimable,
        ),
        row(
            CleanupCategory::Images,
            images.total_count,
            images.active_count,
            images.total_size,
            images.reclaimable,
        ),
        row(
            CleanupCategory::Volumes,
            volumes.total_count,
            volumes.active_count,
            volumes.total_size,
            volumes.reclaimable,
        ),
        row(
            CleanupCategory::BuildCache,
            cache.total_count,
            cache.active_count,
            cache.total_size,
            cache.reclaimable,
        ),
    ]
}

async fn disk_usage(docker: &Docker) -> Result<Vec<DiskUsage>> {
    let options = DataUsageOptionsBuilder::default().build();
    Ok(usage_of(docker.df(Some(options)).await?))
}

/// Reads the engine information and the disk usage. The disk usage is a nicety: an engine that
/// refuses `system df` leaves every number out instead of failing the overview.
pub async fn system_overview(docker: &Docker) -> Result<SystemOverview> {
    let (info, version, usage) = tokio::join!(docker.info(), docker.version(), disk_usage(docker));
    let engine = engine_of(info?, version?.api_version);
    let usage = usage.unwrap_or_else(|_| {
        CATEGORIES
            .iter()
            .map(|category| DiskUsage {
                category: *category,
                total_count: None,
                active_count: None,
                size: None,
                reclaimable: None,
            })
            .collect()
    });
    Ok(SystemOverview { engine, usage })
}

/// What a cleanup of one category would remove.
#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CleanupPreview {
    pub category: CleanupCategory,
    /// How many items go. For the build cache this can exceed `names`, which it does not list.
    pub count: u32,
    /// The names (containers, volumes) or ids (images) that go.
    pub names: Vec<String>,
    /// The disk space freed, in bytes; absent when the engine does not tell. Layers shared with
    /// an image that stays are counted too, so it is an upper bound for images.
    pub reclaimable: Option<f64>,
}

/// The stopped containers a prune removes.
fn container_preview(containers: &[Container]) -> CleanupPreview {
    let names: Vec<String> = containers
        .iter()
        .filter(|c| {
            matches!(
                c.state,
                ContainerState::Created | ContainerState::Exited | ContainerState::Dead
            )
        })
        .map(|c| c.name.clone())
        .collect();
    CleanupPreview {
        category: CleanupCategory::Containers,
        count: names.len() as u32,
        names,
        reclaimable: None,
    }
}

/// The dangling images a prune removes.
fn image_preview(images: &[Image]) -> CleanupPreview {
    let dangling: Vec<&Image> = images
        .iter()
        .filter(|i| i.dangling && i.containers == 0)
        .collect();
    CleanupPreview {
        category: CleanupCategory::Images,
        count: dangling.len() as u32,
        names: dangling
            .iter()
            .map(|i| {
                i.id.trim_start_matches("sha256:")
                    .chars()
                    .take(12)
                    .collect()
            })
            .collect(),
        reclaimable: Some(dangling.iter().map(|i| i.size).sum()),
    }
}

/// The volumes no container uses.
fn volume_preview(volumes: &[Volume]) -> CleanupPreview {
    let unused: Vec<&Volume> = volumes.iter().filter(|v| v.containers.is_empty()).collect();
    let sizes: Vec<f64> = unused.iter().filter_map(|v| v.size).collect();
    CleanupPreview {
        category: CleanupCategory::Volumes,
        count: unused.len() as u32,
        names: unused.iter().map(|v| v.name.clone()).collect(),
        reclaimable: (!sizes.is_empty()).then(|| sizes.iter().sum()),
    }
}

/// The build cache records no build uses, from the `system df` numbers.
fn cache_preview(usage: &[DiskUsage]) -> CleanupPreview {
    let cache = usage
        .iter()
        .find(|u| u.category == CleanupCategory::BuildCache);
    let total = cache.and_then(|u| u.total_count).unwrap_or(0);
    let active = cache.and_then(|u| u.active_count).unwrap_or(0);
    CleanupPreview {
        category: CleanupCategory::BuildCache,
        count: total.saturating_sub(active),
        names: Vec::new(),
        reclaimable: cache.and_then(|u| u.reclaimable),
    }
}

/// Lists what a cleanup of `categories` removes, without removing anything. The result follows
/// the order of [`CATEGORIES`]; a category that is listed twice counts once.
pub async fn cleanup_preview(
    docker: &Docker,
    categories: &[CleanupCategory],
) -> Result<Vec<CleanupPreview>> {
    let wanted = |category| categories.contains(&category);
    let mut previews = Vec::new();
    for category in CATEGORIES.into_iter().filter(|c| wanted(*c)) {
        previews.push(match category {
            CleanupCategory::Containers => {
                container_preview(&crate::list_containers(docker).await?)
            }
            CleanupCategory::Images => image_preview(&crate::list_images(docker).await?),
            CleanupCategory::Volumes => volume_preview(&crate::list_volumes(docker).await?),
            CleanupCategory::BuildCache => cache_preview(&disk_usage(docker).await?),
        });
    }
    Ok(previews)
}

/// What a cleanup of one category removed.
#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CleanupOutcome {
    pub category: CleanupCategory,
    /// The number of items the engine deleted.
    pub removed: u32,
    /// The disk space that was freed, in bytes.
    pub reclaimed: f64,
}

/// The result of a cleanup: one entry per category that was removed and one per failure. A failing
/// category does not stop the ones after it, and the freed space of the others is not lost.
#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CleanupResult {
    pub outcomes: Vec<CleanupOutcome>,
    pub failures: Vec<CleanupFailure>,
}

/// A category that could not be cleaned.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CleanupFailure {
    pub category: CleanupCategory,
    pub message: String,
}

async fn clean(docker: &Docker, category: CleanupCategory) -> Result<CleanupOutcome> {
    let (removed, reclaimed) = match category {
        CleanupCategory::Containers => {
            let options = PruneContainersOptionsBuilder::default().build();
            let response = docker.prune_containers(Some(options)).await?;
            (
                response.containers_deleted.map_or(0, |v| v.len()),
                response.space_reclaimed,
            )
        }
        CleanupCategory::Images => {
            let outcome = crate::prune_images(docker, false).await?;
            (outcome.removed as usize, Some(outcome.reclaimed as i64))
        }
        CleanupCategory::Volumes => {
            let outcome = crate::prune_volumes(docker).await?;
            (outcome.removed.len(), Some(outcome.reclaimed as i64))
        }
        CleanupCategory::BuildCache => {
            let options = PruneBuildOptionsBuilder::default().all(true).build();
            let response = docker.prune_build(Some(options)).await?;
            (
                response.caches_deleted.map_or(0, |v| v.len()),
                response.space_reclaimed,
            )
        }
    };
    Ok(CleanupOutcome {
        category,
        removed: removed.min(u32::MAX as usize) as u32,
        reclaimed: reclaimed.unwrap_or(0).max(0) as f64,
    })
}

/// Removes what [`cleanup_preview`] lists for `categories` and reports the freed space.
pub async fn cleanup(docker: &Docker, categories: &[CleanupCategory]) -> CleanupResult {
    let mut result = CleanupResult {
        outcomes: Vec::new(),
        failures: Vec::new(),
    };
    for category in CATEGORIES.into_iter().filter(|c| categories.contains(c)) {
        match clean(docker, category).await {
            Ok(outcome) => result.outcomes.push(outcome),
            Err(error) => result.failures.push(CleanupFailure {
                category,
                message: error.to_string(),
            }),
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use bollard::models::{
        BuildCacheDiskUsage, ContainersDiskUsage, ImagesDiskUsage, VolumesDiskUsage,
    };

    use super::*;

    #[test]
    fn engine_details_come_from_info_and_skip_empty_values() {
        let engine = engine_of(
            SystemInfo {
                server_version: Some("28.1.1".to_owned()),
                operating_system: Some("Ubuntu 24.04 LTS".to_owned()),
                architecture: Some("x86_64".to_owned()),
                ncpu: Some(8),
                mem_total: Some(16_000_000_000),
                driver: Some("overlay2".to_owned()),
                ..Default::default()
            },
            Some("1.49".to_owned()),
        );
        assert_eq!(engine.version.as_deref(), Some("28.1.1"));
        assert_eq!(engine.api_version.as_deref(), Some("1.49"));
        assert_eq!(engine.os.as_deref(), Some("Ubuntu 24.04 LTS"));
        assert_eq!(engine.cpus, Some(8));
        assert_eq!(engine.memory, Some(16_000_000_000.0));
        assert_eq!(engine.storage_driver.as_deref(), Some("overlay2"));

        let bare = engine_of(
            SystemInfo {
                operating_system: Some(String::new()),
                os_type: Some("linux".to_owned()),
                ncpu: Some(0),
                ..Default::default()
            },
            None,
        );
        assert_eq!(bare.os.as_deref(), Some("linux"));
        assert_eq!(bare.cpus, None);
        assert_eq!(bare.memory, None);
        assert_eq!(bare.version, None);
    }

    #[test]
    fn disk_usage_has_one_row_per_category_in_order() {
        let usage = usage_of(SystemDataUsageResponse {
            image_usage: Some(ImagesDiskUsage {
                total_count: Some(4),
                active_count: Some(2),
                total_size: Some(1000),
                reclaimable: Some(400),
                ..Default::default()
            }),
            container_usage: Some(ContainersDiskUsage {
                total_count: Some(3),
                active_count: Some(1),
                total_size: Some(30),
                reclaimable: Some(20),
                ..Default::default()
            }),
            volume_usage: Some(VolumesDiskUsage {
                total_count: Some(2),
                active_count: Some(2),
                total_size: Some(500),
                reclaimable: Some(0),
                ..Default::default()
            }),
            build_cache_usage: Some(BuildCacheDiskUsage {
                total_count: Some(5),
                active_count: Some(0),
                total_size: Some(-1),
                reclaimable: Some(70),
                ..Default::default()
            }),
        });
        let order: Vec<_> = usage.iter().map(|u| u.category).collect();
        assert_eq!(order, CATEGORIES);
        assert_eq!(usage[0].size, Some(30.0));
        assert_eq!(usage[1].reclaimable, Some(400.0));
        assert_eq!(usage[1].total_count, Some(4));
        assert_eq!(usage[2].reclaimable, Some(0.0));
        assert_eq!(usage[3].size, Some(0.0), "a negative size counts as zero");
    }

    #[test]
    fn an_engine_without_usage_data_leaves_the_numbers_out() {
        let usage = usage_of(SystemDataUsageResponse::default());
        assert_eq!(usage.len(), 4);
        // The default of each category is all-`None`, which the view shows as unknown.
        assert!(
            usage
                .iter()
                .all(|u| u.size.is_none() && u.total_count.is_none())
        );
    }

    fn container(name: &str, state: ContainerState) -> Container {
        Container {
            id: format!("id-{name}"),
            name: name.to_owned(),
            image: "img".to_owned(),
            state,
            health: None,
            status: String::new(),
            ports: Vec::new(),
            created: 0,
            compose_project: None,
        }
    }

    #[test]
    fn the_container_preview_lists_only_stopped_containers() {
        let preview = container_preview(&[
            container("run", ContainerState::Running),
            container("done", ContainerState::Exited),
            container("new", ContainerState::Created),
            container("pause", ContainerState::Paused),
        ]);
        assert_eq!(preview.names, ["done", "new"]);
        assert_eq!(preview.count, 2);
    }

    fn image(id: &str, dangling: bool, containers: u32, size: f64) -> Image {
        Image {
            id: id.to_owned(),
            reference: (!dangling).then(|| "app:1".to_owned()),
            repository: None,
            tag: None,
            size,
            created: 0,
            containers,
            dangling,
        }
    }

    #[test]
    fn the_image_preview_lists_dangling_images_without_containers() {
        let preview = image_preview(&[
            image("sha256:aaaaaaaaaaaaaaaa", true, 0, 10.0),
            image("sha256:bbbbbbbbbbbbbbbb", true, 1, 5.0),
            image("sha256:cccccccccccccccc", false, 0, 7.0),
        ]);
        assert_eq!(preview.names, ["aaaaaaaaaaaa"]);
        assert_eq!(preview.reclaimable, Some(10.0));
    }

    fn volume(name: &str, size: Option<f64>, containers: &[&str]) -> Volume {
        Volume {
            name: name.to_owned(),
            driver: "local".to_owned(),
            mountpoint: String::new(),
            size,
            created: None,
            labels: Vec::new(),
            containers: containers.iter().map(|c| (*c).to_owned()).collect(),
        }
    }

    #[test]
    fn the_volume_preview_lists_unused_volumes_and_sums_known_sizes() {
        let preview = volume_preview(&[
            volume("a", Some(100.0), &[]),
            volume("b", None, &[]),
            volume("c", Some(50.0), &["web"]),
        ]);
        assert_eq!(preview.names, ["a", "b"]);
        assert_eq!(preview.reclaimable, Some(100.0));
        let none = volume_preview(&[volume("x", None, &[])]);
        assert_eq!(none.reclaimable, None);
    }

    #[test]
    fn the_cache_preview_counts_inactive_records() {
        let usage = usage_of(SystemDataUsageResponse {
            build_cache_usage: Some(BuildCacheDiskUsage {
                total_count: Some(5),
                active_count: Some(2),
                reclaimable: Some(70),
                ..Default::default()
            }),
            ..Default::default()
        });
        let preview = cache_preview(&usage);
        assert_eq!(preview.count, 3);
        assert_eq!(preview.reclaimable, Some(70.0));
        assert!(preview.names.is_empty());
    }
}
