//! Images: the list with the containers that use each image, pull with per-layer progress, remove
//! and prune.

use std::collections::HashMap;

use bollard::Docker;
use bollard::models::{ContainerSummary, CreateImageInfo, ImageSummary};
use bollard::query_parameters::{
    CreateImageOptionsBuilder, ListContainersOptionsBuilder, ListImagesOptionsBuilder,
    PruneImagesOptionsBuilder, RemoveImageOptionsBuilder,
};
use futures_util::{Stream, StreamExt};
use serde::Serialize;
use specta::Type;
use tokio::sync::Notify;

use crate::{Error, Result};

/// What the engine shows for an image without a repository or a tag.
const NONE: &str = "<none>";

/// One row of the image list: an image under one of its tags, or an untagged (dangling) image.
// Byte counts are `f64` (exact up to 2^53): the IPC types forbid 64-bit integers.
#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Image {
    /// The full image ID, e.g. `sha256:…`.
    pub id: String,
    /// `repository:tag`; absent for a dangling image.
    pub reference: Option<String>,
    pub repository: Option<String>,
    pub tag: Option<String>,
    /// Size in bytes, including layers shared with other images.
    pub size: f64,
    /// Creation time in seconds since the Unix epoch.
    pub created: u32,
    /// The number of containers (in any state) created from the image.
    pub containers: u32,
    /// True for an image that has no tag; `docker image prune` removes it.
    pub dangling: bool,
}

impl Image {
    /// What the engine addresses the row with: its reference, or the ID for a dangling image.
    pub fn target(&self) -> &str {
        self.reference.as_deref().unwrap_or(&self.id)
    }
}

/// Splits `repo:tag` at the tag colon (a colon in the registry host, `host:5000/app`, is not one).
fn split_tag(tag: &str) -> (String, Option<String>) {
    match tag.rsplit_once(':') {
        Some((repository, tag)) if !tag.contains('/') => {
            (repository.to_owned(), Some(tag.to_owned()))
        }
        _ => (tag.to_owned(), None),
    }
}

/// The rows of the image list, newest first. `in_use` counts the containers per image ID.
pub fn images_of(summaries: Vec<ImageSummary>, in_use: &HashMap<String, u32>) -> Vec<Image> {
    let mut images = Vec::new();
    for summary in summaries {
        let containers = in_use.get(&summary.id).copied().unwrap_or(0);
        let created = summary.created.clamp(0, i64::from(u32::MAX)) as u32;
        let tags: Vec<String> = summary
            .repo_tags
            .into_iter()
            .filter(|t| !t.starts_with(NONE))
            .collect();
        let row = |reference: Option<String>| {
            let (repository, tag) = match reference.as_deref().map(split_tag) {
                Some((repository, tag)) => (Some(repository), tag),
                None => (None, None),
            };
            Image {
                id: summary.id.clone(),
                dangling: reference.is_none(),
                reference,
                repository,
                tag,
                size: summary.size.max(0) as f64,
                created,
                containers,
            }
        };
        if tags.is_empty() {
            images.push(row(None));
        } else {
            images.extend(tags.into_iter().map(|t| row(Some(t))));
        }
    }
    images.sort_by(|a, b| {
        b.created
            .cmp(&a.created)
            .then_with(|| a.reference.cmp(&b.reference))
    });
    images
}

/// The number of containers per image ID.
fn usage_of(containers: Vec<ContainerSummary>) -> HashMap<String, u32> {
    let mut usage = HashMap::new();
    for image_id in containers.into_iter().filter_map(|c| c.image_id) {
        *usage.entry(image_id).or_insert(0) += 1;
    }
    usage
}

/// Lists the images of the engine with the number of containers that use each.
pub async fn list_images(docker: &Docker) -> Result<Vec<Image>> {
    let options = ListContainersOptionsBuilder::default().all(true).build();
    let (images, containers) = tokio::try_join!(
        async {
            Ok::<_, Error>(
                docker
                    .list_images(Some(ListImagesOptionsBuilder::default().build()))
                    .await?,
            )
        },
        async { Ok::<_, Error>(docker.list_containers(Some(options)).await?) },
    )?;
    Ok(images_of(images, &usage_of(containers)))
}

/// Splits an image reference into what the engine's pull call takes: the name and the tag or
/// digest. A reference without either pulls `latest`, like the CLI (the API alone pulls every tag).
pub fn split_reference(reference: &str) -> Result<(String, String)> {
    let reference = reference.trim();
    if reference.is_empty() || reference.contains(char::is_whitespace) {
        return Err(Error::InvalidInput(
            "an image reference has no spaces and is not empty".to_owned(),
        ));
    }
    if let Some((name, digest)) = reference.split_once('@') {
        if name.is_empty() || digest.is_empty() {
            return Err(Error::InvalidInput(format!(
                "`{reference}` is not an image reference"
            )));
        }
        return Ok((name.to_owned(), digest.to_owned()));
    }
    let (name, tag) = split_tag(reference);
    if name.is_empty() || tag.as_deref() == Some("") {
        return Err(Error::InvalidInput(format!(
            "`{reference}` is not an image reference"
        )));
    }
    Ok((name, tag.unwrap_or_else(|| "latest".to_owned())))
}

/// Progress of a pull.
#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum PullEvent {
    /// A status line of the pull (`Pulling from library/nginx`, `Digest: …`, `Status: …`).
    Status { message: String },
    /// The state of one layer; `current` and `total` are bytes and only known while it transfers.
    Layer {
        id: String,
        status: String,
        current: Option<f64>,
        total: Option<f64>,
    },
}

/// Maps the engine's progress messages to events. A message with an error ends the pull. Resolves
/// with `false` when `cancel` ended it before the engine finished.
async fn forward_pull(
    mut progress: impl Stream<Item = std::result::Result<CreateImageInfo, bollard::errors::Error>>
    + Unpin,
    cancel: &Notify,
    mut emit: impl FnMut(PullEvent),
) -> Result<bool> {
    loop {
        let next = tokio::select! {
            () = cancel.notified() => return Ok(false),
            next = progress.next() => next,
        };
        let Some(info) = next else { return Ok(true) };
        let info = info?;
        if let Some(detail) = info.error_detail {
            return Err(pull_error(detail.message.unwrap_or_default()));
        }
        let Some(status) = info.status else { continue };
        match info.id {
            Some(id) => {
                let detail = info.progress_detail;
                emit(PullEvent::Layer {
                    id,
                    status,
                    current: detail.as_ref().and_then(|d| d.current).map(|n| n as f64),
                    total: detail.as_ref().and_then(|d| d.total).map(|n| n as f64),
                });
            }
            None => emit(PullEvent::Status { message: status }),
        }
    }
}

fn pull_error(message: String) -> Error {
    Error::Docker(bollard::errors::Error::DockerResponseServerError {
        status_code: 500,
        message,
    })
}

/// Pulls `reference` and reports the progress per layer to `emit` until the pull ends or `cancel`
/// is notified. Resolves with `true` when the pull finished and `false` when it was cancelled.
pub async fn pull_image(
    docker: &Docker,
    reference: &str,
    cancel: &Notify,
    emit: impl FnMut(PullEvent),
) -> Result<bool> {
    let (name, tag) = split_reference(reference)?;
    let options = CreateImageOptionsBuilder::default()
        .from_image(&name)
        .tag(&tag)
        .build();
    let progress = docker.create_image(Some(options), None, None);
    forward_pull(Box::pin(progress), cancel, emit).await
}

/// What removing an image did.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RemoveOutcome {
    /// The tags that were removed from the image.
    pub untagged: Vec<String>,
    /// The IDs of the layers that were deleted.
    pub deleted: Vec<String>,
}

/// Removes an image by reference or ID. A reference removes only that tag while other tags point to
/// the image. `force` also removes an image that is used by a stopped container or has several tags.
pub async fn remove_image(docker: &Docker, target: &str, force: bool) -> Result<RemoveOutcome> {
    let options = RemoveImageOptionsBuilder::default().force(force).build();
    let items = docker.remove_image(target, Some(options), None).await?;
    let mut outcome = RemoveOutcome {
        untagged: Vec::new(),
        deleted: Vec::new(),
    };
    for item in items {
        outcome.untagged.extend(item.untagged);
        outcome.deleted.extend(item.deleted);
    }
    Ok(outcome)
}

/// What a prune removed.
#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PruneOutcome {
    /// The number of images (tags or layers) the engine deleted or untagged.
    pub removed: u32,
    /// The disk space that was freed, in bytes.
    pub reclaimed: f64,
}

/// Removes images that no container uses: only the dangling ones, or with `all` every unused image.
pub async fn prune_images(docker: &Docker, all: bool) -> Result<PruneOutcome> {
    let filters = HashMap::from([("dangling", vec![if all { "false" } else { "true" }])]);
    let options = PruneImagesOptionsBuilder::default()
        .filters(&filters)
        .build();
    let response = docker.prune_images(Some(options)).await?;
    Ok(PruneOutcome {
        removed: response
            .images_deleted
            .map_or(0, |items| items.len() as u32),
        reclaimed: response.space_reclaimed.unwrap_or(0).max(0) as f64,
    })
}

#[cfg(test)]
mod tests {
    use bollard::models::{ErrorDetail, ProgressDetail};
    use futures_util::stream;

    use super::*;

    fn summary(id: &str, tags: &[&str], created: i64) -> ImageSummary {
        ImageSummary {
            id: id.to_owned(),
            repo_tags: tags.iter().map(|t| (*t).to_owned()).collect(),
            created,
            size: 1000,
            ..Default::default()
        }
    }

    #[test]
    fn one_row_per_tag_with_the_container_count_and_newest_first() {
        let usage = HashMap::from([("sha256:a".to_owned(), 2)]);
        let images = images_of(
            vec![
                summary("sha256:old", &["alpine:3.19"], 100),
                summary("sha256:a", &["nginx:latest", "localhost:5000/web:v1"], 300),
            ],
            &usage,
        );
        let refs: Vec<_> = images.iter().map(|i| i.reference.as_deref()).collect();
        assert_eq!(
            refs,
            [
                Some("localhost:5000/web:v1"),
                Some("nginx:latest"),
                Some("alpine:3.19")
            ]
        );
        assert_eq!(images[0].repository.as_deref(), Some("localhost:5000/web"));
        assert_eq!(images[0].tag.as_deref(), Some("v1"));
        assert_eq!((images[0].containers, images[2].containers), (2, 0));
        assert!(images.iter().all(|i| !i.dangling));
    }

    #[test]
    fn an_image_without_tags_is_dangling_and_addressed_by_id() {
        let images = images_of(
            vec![
                summary("sha256:d1", &[], 1),
                summary("sha256:d2", &["<none>:<none>"], 2),
            ],
            &HashMap::new(),
        );
        assert_eq!(images.len(), 2);
        for image in &images {
            assert!(image.dangling);
            assert_eq!(
                (image.repository.as_deref(), image.tag.as_deref()),
                (None, None)
            );
            assert_eq!(image.target(), image.id);
        }
    }

    #[test]
    fn counts_the_containers_per_image_id() {
        let container = |image_id: Option<&str>| ContainerSummary {
            image_id: image_id.map(str::to_owned),
            ..Default::default()
        };
        let usage = usage_of(vec![
            container(Some("sha256:a")),
            container(Some("sha256:a")),
            container(Some("sha256:b")),
            container(None),
        ]);
        assert_eq!(usage["sha256:a"], 2);
        assert_eq!(usage["sha256:b"], 1);
        assert_eq!(usage.len(), 2);
    }

    #[test]
    fn splits_references_like_the_cli() {
        let split = |r| split_reference(r).unwrap();
        assert_eq!(split("nginx"), ("nginx".to_owned(), "latest".to_owned()));
        assert_eq!(split("nginx:1.27"), ("nginx".to_owned(), "1.27".to_owned()));
        assert_eq!(
            split(" localhost:5000/app "),
            ("localhost:5000/app".to_owned(), "latest".to_owned())
        );
        assert_eq!(
            split("localhost:5000/app:2"),
            ("localhost:5000/app".to_owned(), "2".to_owned())
        );
        assert_eq!(
            split("nginx@sha256:abc"),
            ("nginx".to_owned(), "sha256:abc".to_owned())
        );
    }

    #[test]
    fn rejects_malformed_references() {
        for bad in ["", "  ", "a b", "nginx:", ":tag", "@sha256:abc", "nginx@"] {
            assert!(split_reference(bad).is_err(), "{bad:?}");
        }
    }

    fn info(id: Option<&str>, status: &str, progress: Option<(i64, i64)>) -> CreateImageInfo {
        CreateImageInfo {
            id: id.map(str::to_owned),
            status: Some(status.to_owned()),
            progress_detail: progress.map(|(current, total)| ProgressDetail {
                current: Some(current),
                total: Some(total),
            }),
            ..Default::default()
        }
    }

    async fn pull(
        items: Vec<std::result::Result<CreateImageInfo, bollard::errors::Error>>,
    ) -> (Vec<PullEvent>, Result<bool>) {
        let mut events = Vec::new();
        let cancel = Notify::new();
        let result = forward_pull(stream::iter(items), &cancel, |e| events.push(e)).await;
        (events, result)
    }

    #[tokio::test]
    async fn reports_status_lines_and_the_progress_of_each_layer() {
        let (events, result) = pull(vec![
            Ok(info(None, "Pulling from library/nginx", None)),
            Ok(info(Some("abc"), "Pulling fs layer", None)),
            Ok(info(Some("abc"), "Downloading", Some((50, 200)))),
            Ok(info(Some("abc"), "Pull complete", None)),
            Ok(CreateImageInfo::default()),
            Ok(info(None, "Status: Downloaded newer image", None)),
        ])
        .await;
        assert!(result.unwrap());
        assert_eq!(events.len(), 5);
        assert_eq!(
            events[0],
            PullEvent::Status {
                message: "Pulling from library/nginx".to_owned()
            }
        );
        assert_eq!(
            events[2],
            PullEvent::Layer {
                id: "abc".to_owned(),
                status: "Downloading".to_owned(),
                current: Some(50.0),
                total: Some(200.0)
            }
        );
        assert!(matches!(
            &events[3],
            PullEvent::Layer {
                current: None,
                total: None,
                ..
            }
        ));
    }

    #[tokio::test]
    async fn an_error_message_of_the_engine_ends_the_pull() {
        let failure = CreateImageInfo {
            error_detail: Some(ErrorDetail {
                code: None,
                message: Some("manifest unknown".to_owned()),
            }),
            ..Default::default()
        };
        let (events, result) = pull(vec![
            Ok(info(None, "Pulling from library/x", None)),
            Ok(failure),
            Ok(info(None, "never seen", None)),
        ])
        .await;
        assert_eq!(events.len(), 1);
        let error = result.unwrap_err();
        assert!(error.to_string().contains("manifest unknown"), "{error}");
    }

    #[tokio::test]
    async fn cancel_ends_an_open_pull() {
        let cancel = Notify::new();
        cancel.notify_one();
        let result = forward_pull(stream::pending(), &cancel, |_| {}).await;
        assert!(!result.unwrap(), "a cancelled pull is not a finished one");
    }
}
