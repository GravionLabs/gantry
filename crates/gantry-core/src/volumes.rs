//! Volumes: the list with the size and the containers that use each volume, create, remove and
//! prune.

use std::collections::HashMap;

use bollard::Docker;
use bollard::models::{ContainerSummary, Volume as EngineVolume, VolumeCreateRequest};
use bollard::query_parameters::{
    DataUsageOptionsBuilder, ListContainersOptionsBuilder, ListVolumesOptionsBuilder,
    PruneVolumesOptionsBuilder, RemoveVolumeOptionsBuilder,
};
use serde::Serialize;
use specta::Type;

use crate::{Error, Label, Result};

/// One row of the volume list.
// Byte counts are `f64` (exact up to 2^53): the IPC types forbid 64-bit integers.
#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Volume {
    pub name: String,
    pub driver: String,
    pub mountpoint: String,
    /// Disk space in bytes as `system df` reports it; absent when the engine does not know it
    /// (a driver that cannot measure, or an engine that does not report volume usage).
    pub size: Option<f64>,
    /// Creation time as the engine reports it (RFC 3339).
    pub created: Option<String>,
    pub labels: Vec<Label>,
    /// The names of the containers (in any state) that mount the volume.
    pub containers: Vec<String>,
}

/// The names of the containers per volume name.
fn usage_of(containers: Vec<ContainerSummary>) -> HashMap<String, Vec<String>> {
    let mut usage: HashMap<String, Vec<String>> = HashMap::new();
    for container in containers {
        let name = container
            .names
            .and_then(|names| names.into_iter().next())
            .map(|n| n.trim_start_matches('/').to_owned())
            .or_else(|| container.id.clone())
            .unwrap_or_default();
        let mut seen: Vec<String> = Vec::new();
        for mount in container.mounts.unwrap_or_default() {
            if mount.typ.as_deref() != Some("volume") {
                continue;
            }
            let Some(volume) = mount.name else { continue };
            if seen.contains(&volume) {
                continue;
            }
            usage.entry(volume.clone()).or_default().push(name.clone());
            seen.push(volume);
        }
    }
    for names in usage.values_mut() {
        names.sort();
    }
    usage
}

/// The size per volume name out of the `system df` volume items; unmeasured volumes (`-1`) are
/// left out. Items without a name or a size are skipped.
fn sizes_of(items: Vec<serde_json::Value>) -> HashMap<String, f64> {
    items
        .iter()
        .filter_map(|item| {
            let name = item.get("Name")?.as_str()?;
            let size = item.get("UsageData")?.get("Size")?.as_i64()?;
            (size >= 0).then(|| (name.to_owned(), size as f64))
        })
        .collect()
}

/// The rows of the volume list ordered by name.
fn volumes_of(
    volumes: Vec<EngineVolume>,
    sizes: &HashMap<String, f64>,
    usage: &HashMap<String, Vec<String>>,
) -> Vec<Volume> {
    let mut rows: Vec<Volume> = volumes
        .into_iter()
        .map(|volume| {
            let mut labels: Vec<Label> = volume
                .labels
                .into_iter()
                .map(|(key, value)| Label { key, value })
                .collect();
            labels.sort_by(|a, b| a.key.cmp(&b.key));
            Volume {
                size: sizes
                    .get(&volume.name)
                    .copied()
                    // The list itself carries a size on some engines.
                    .or_else(|| {
                        volume
                            .usage_data
                            .as_ref()
                            .map(|u| u.size)
                            .filter(|s| *s >= 0)
                            .map(|s| s as f64)
                    }),
                created: volume.created_at,
                containers: usage.get(&volume.name).cloned().unwrap_or_default(),
                name: volume.name,
                driver: volume.driver,
                mountpoint: volume.mountpoint,
                labels,
            }
        })
        .collect();
    rows.sort_by(|a, b| a.name.cmp(&b.name));
    rows
}

/// Lists the volumes of the engine with their size and the containers that use them.
pub async fn list_volumes(docker: &Docker) -> Result<Vec<Volume>> {
    let containers = ListContainersOptionsBuilder::default().all(true).build();
    let df = DataUsageOptionsBuilder::default()
        ._type(vec!["volume".to_owned()])
        .verbose(true)
        .build();
    let (list, containers, usage) = tokio::join!(
        docker.list_volumes(Some(ListVolumesOptionsBuilder::default().build())),
        docker.list_containers(Some(containers)),
        docker.df(Some(df)),
    );
    let volumes = list?.volumes.unwrap_or_default();
    // The size is a nicety: a failing or old `system df` leaves it out instead of the list.
    let sizes = usage
        .ok()
        .and_then(|u| u.volume_usage)
        .and_then(|u| u.items)
        .map(sizes_of)
        .unwrap_or_default();
    Ok(volumes_of(volumes, &sizes, &usage_of(containers?)))
}

/// What creating a volume takes.
#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct VolumeSpec {
    pub name: String,
    /// The volume driver; empty for the engine's default (`local`).
    pub driver: String,
    pub labels: Vec<Label>,
}

fn request_of(spec: VolumeSpec) -> Result<VolumeCreateRequest> {
    let name = spec.name.trim();
    if name.is_empty() || name.contains(char::is_whitespace) || name.contains('/') {
        return Err(Error::InvalidInput(
            "a volume name is not empty and has no spaces or slashes".to_owned(),
        ));
    }
    let mut labels = HashMap::new();
    for label in spec.labels {
        let key = label.key.trim();
        if key.is_empty() {
            return Err(Error::InvalidInput("a label needs a key".to_owned()));
        }
        labels.insert(key.to_owned(), label.value);
    }
    let driver = spec.driver.trim();
    Ok(VolumeCreateRequest {
        name: Some(name.to_owned()),
        driver: (!driver.is_empty()).then(|| driver.to_owned()),
        labels: Some(labels),
        ..Default::default()
    })
}

/// Creates a volume.
pub async fn create_volume(docker: &Docker, spec: VolumeSpec) -> Result<()> {
    docker.create_volume(request_of(spec)?).await?;
    Ok(())
}

/// Removes a volume. `force` also succeeds when the volume does not exist.
pub async fn remove_volume(docker: &Docker, name: &str, force: bool) -> Result<()> {
    let options = RemoveVolumeOptionsBuilder::default().force(force).build();
    docker.remove_volume(name, Some(options)).await?;
    Ok(())
}

/// What a prune removed.
#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct VolumePruneOutcome {
    /// The names of the volumes the engine deleted.
    pub removed: Vec<String>,
    /// The disk space that was freed, in bytes.
    pub reclaimed: f64,
}

/// Removes every volume no container uses, named ones included (the engine's default prunes only
/// anonymous volumes).
pub async fn prune_volumes(docker: &Docker) -> Result<VolumePruneOutcome> {
    let filters = HashMap::from([("all", vec!["true"])]);
    let options = PruneVolumesOptionsBuilder::default()
        .filters(&filters)
        .build();
    let response = docker.prune_volumes(Some(options)).await?;
    Ok(VolumePruneOutcome {
        removed: response.volumes_deleted.unwrap_or_default(),
        reclaimed: response.space_reclaimed.unwrap_or(0).max(0) as f64,
    })
}

#[cfg(test)]
mod tests {
    use bollard::models::{MountPoint, VolumeUsageData};
    use serde_json::json;

    use super::*;

    fn volume(name: &str) -> EngineVolume {
        EngineVolume {
            name: name.to_owned(),
            driver: "local".to_owned(),
            mountpoint: format!("/var/lib/docker/volumes/{name}/_data"),
            ..Default::default()
        }
    }

    fn container(name: &str, mounts: &[(&str, &str)]) -> ContainerSummary {
        ContainerSummary {
            names: Some(vec![format!("/{name}")]),
            mounts: Some(
                mounts
                    .iter()
                    .map(|(typ, volume)| MountPoint {
                        typ: Some((*typ).to_owned()),
                        name: Some((*volume).to_owned()),
                        ..Default::default()
                    })
                    .collect(),
            ),
            ..Default::default()
        }
    }

    #[test]
    fn names_the_containers_per_volume_and_ignores_other_mounts() {
        let usage = usage_of(vec![
            container("web", &[("volume", "data")]),
            container(
                "db",
                &[("volume", "data"), ("volume", "data"), ("bind", "host")],
            ),
        ]);
        assert_eq!(usage["data"], ["db", "web"]);
        assert!(!usage.contains_key("host"));
    }

    #[test]
    fn reads_sizes_from_the_df_items_and_skips_unmeasured_ones() {
        let sizes = sizes_of(vec![
            json!({"Name": "a", "Driver": "local", "Mountpoint": "/a", "Labels": {}, "Options": {},
                   "UsageData": {"Size": 2048, "RefCount": 1}}),
            json!({"Name": "b", "Driver": "local", "Mountpoint": "/b", "Labels": {}, "Options": {},
                   "UsageData": {"Size": -1, "RefCount": 0}}),
            json!({"unexpected": true}),
        ]);
        assert_eq!(sizes.len(), 1);
        assert_eq!(sizes["a"], 2048.0);
    }

    #[test]
    fn rows_are_sorted_by_name_with_size_labels_and_users() {
        let mut labelled = volume("b");
        labelled.labels = HashMap::from([
            ("z".to_owned(), "1".to_owned()),
            ("a".to_owned(), "2".to_owned()),
        ]);
        let mut listed_size = volume("c");
        listed_size.usage_data = Some(VolumeUsageData {
            size: 7,
            ref_count: 0,
        });
        let rows = volumes_of(
            vec![labelled, volume("a"), listed_size],
            &HashMap::from([("b".to_owned(), 10.0)]),
            &HashMap::from([("a".to_owned(), vec!["web".to_owned()])]),
        );
        let names: Vec<_> = rows.iter().map(|v| v.name.as_str()).collect();
        assert_eq!(names, ["a", "b", "c"]);
        assert_eq!(rows[0].containers, ["web"]);
        assert_eq!(
            (rows[0].size, rows[1].size, rows[2].size),
            (None, Some(10.0), Some(7.0))
        );
        assert_eq!(rows[1].labels[0].key, "a");
    }

    fn spec(name: &str, driver: &str, labels: &[(&str, &str)]) -> VolumeSpec {
        VolumeSpec {
            name: name.to_owned(),
            driver: driver.to_owned(),
            labels: labels
                .iter()
                .map(|(key, value)| Label {
                    key: (*key).to_owned(),
                    value: (*value).to_owned(),
                })
                .collect(),
        }
    }

    #[test]
    fn builds_the_create_request_with_driver_and_labels() {
        let request = request_of(spec(" data ", "", &[("team", "x")])).unwrap();
        assert_eq!(request.name.as_deref(), Some("data"));
        assert_eq!(request.driver, None);
        assert_eq!(request.labels.unwrap()["team"], "x");
        let request = request_of(spec("data", " local ", &[])).unwrap();
        assert_eq!(request.driver.as_deref(), Some("local"));
    }

    #[test]
    fn rejects_bad_names_and_labels() {
        for bad in [
            spec("", "", &[]),
            spec("a b", "", &[]),
            spec("a/b", "", &[]),
            spec("a", "", &[(" ", "v")]),
        ] {
            assert!(request_of(bad).is_err());
        }
    }
}
