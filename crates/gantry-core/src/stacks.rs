//! Compose stacks: containers grouped by the labels Docker Compose puts on them.
//!
//! A stack is every container with the same `com.docker.compose.project` label. Containers
//! without that label are not part of any stack. The working directory and the configuration
//! files come from the `com.docker.compose.project.*` labels.

use std::collections::{BTreeMap, HashMap};

use bollard::Docker;
use bollard::models::ContainerSummary;
use bollard::query_parameters::ListContainersOptionsBuilder;
use serde::Serialize;
use specta::Type;

use crate::containers::COMPOSE_PROJECT_LABEL;
use crate::{Container, ContainerState, Result};

const COMPOSE_SERVICE_LABEL: &str = "com.docker.compose.service";
const COMPOSE_WORKING_DIR_LABEL: &str = "com.docker.compose.project.working_dir";
const COMPOSE_CONFIG_FILES_LABEL: &str = "com.docker.compose.project.config_files";

/// A service of a stack with the containers that run it (several when scaled).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct StackService {
    pub name: String,
    pub containers: Vec<Container>,
}

/// A Compose project.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Stack {
    pub name: String,
    /// The directory `docker compose` was run in, when the labels say so.
    pub working_dir: Option<String>,
    /// The Compose files of the project, in the order they were merged.
    pub config_files: Vec<String>,
    /// The number of containers that are up (running, paused or restarting).
    pub running: u32,
    /// The number of containers of the stack, in any state.
    pub total: u32,
    /// Sorted by name; containers without a service label are listed under their own name.
    pub services: Vec<StackService>,
}

/// The Compose labels of one container.
struct ComposeLabels {
    project: String,
    service: Option<String>,
    working_dir: Option<String>,
    config_files: Vec<String>,
}

impl ComposeLabels {
    fn of(labels: &HashMap<String, String>) -> Option<Self> {
        let non_empty = |key: &str| labels.get(key).filter(|v| !v.is_empty()).cloned();
        Some(Self {
            project: non_empty(COMPOSE_PROJECT_LABEL)?,
            service: non_empty(COMPOSE_SERVICE_LABEL),
            working_dir: non_empty(COMPOSE_WORKING_DIR_LABEL),
            config_files: non_empty(COMPOSE_CONFIG_FILES_LABEL)
                .map(|files| {
                    files
                        .split(',')
                        .map(str::trim)
                        .filter(|f| !f.is_empty())
                        .map(str::to_owned)
                        .collect()
                })
                .unwrap_or_default(),
        })
    }
}

fn is_up(state: ContainerState) -> bool {
    matches!(
        state,
        ContainerState::Running | ContainerState::Paused | ContainerState::Restarting
    )
}

/// Groups container summaries into stacks, sorted by name. Summaries without the project label
/// are skipped.
pub fn stacks_of(summaries: Vec<ContainerSummary>) -> Vec<Stack> {
    struct Builder {
        working_dir: Option<String>,
        config_files: Vec<String>,
        services: BTreeMap<String, Vec<Container>>,
    }
    let mut builders: BTreeMap<String, Builder> = BTreeMap::new();
    for summary in summaries {
        let Some(labels) = summary.labels.as_ref().and_then(ComposeLabels::of) else {
            continue;
        };
        let Some(container) = Container::from_summary(summary) else {
            continue;
        };
        let builder = builders.entry(labels.project).or_insert_with(|| Builder {
            working_dir: None,
            config_files: Vec::new(),
            services: BTreeMap::new(),
        });
        if builder.working_dir.is_none() {
            builder.working_dir = labels.working_dir;
        }
        if builder.config_files.is_empty() {
            builder.config_files = labels.config_files;
        }
        let service = labels.service.unwrap_or_else(|| container.name.clone());
        builder.services.entry(service).or_default().push(container);
    }
    builders
        .into_iter()
        .map(|(name, builder)| {
            let services: Vec<StackService> = builder
                .services
                .into_iter()
                .map(|(name, mut containers)| {
                    containers.sort_by(|a, b| a.name.cmp(&b.name));
                    StackService { name, containers }
                })
                .collect();
            let all = services.iter().flat_map(|s| &s.containers);
            Stack {
                name,
                working_dir: builder.working_dir,
                config_files: builder.config_files,
                running: all.clone().filter(|c| is_up(c.state)).count() as u32,
                total: all.count() as u32,
                services,
            }
        })
        .collect()
}

/// Lists the Compose stacks of the engine (containers in any state).
pub async fn list_stacks(docker: &Docker) -> Result<Vec<Stack>> {
    let options = ListContainersOptionsBuilder::default().all(true).build();
    Ok(stacks_of(docker.list_containers(Some(options)).await?))
}

#[cfg(test)]
mod tests {
    use bollard::models::ContainerSummaryStateEnum;

    use super::*;

    fn summary(
        name: &str,
        state: ContainerSummaryStateEnum,
        labels: &[(&str, &str)],
    ) -> ContainerSummary {
        ContainerSummary {
            id: Some(format!("id-{name}")),
            names: Some(vec![format!("/{name}")]),
            state: Some(state),
            labels: Some(
                labels
                    .iter()
                    .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
                    .collect(),
            ),
            ..Default::default()
        }
    }

    fn compose<'a>(project: &'a str, service: &'a str) -> Vec<(&'a str, &'a str)> {
        vec![
            (COMPOSE_PROJECT_LABEL, project),
            (COMPOSE_SERVICE_LABEL, service),
            (COMPOSE_WORKING_DIR_LABEL, "/srv/shop"),
            (
                COMPOSE_CONFIG_FILES_LABEL,
                "/srv/shop/compose.yml, /srv/shop/override.yml",
            ),
        ]
    }

    #[test]
    fn groups_by_project_with_services_and_counts() {
        use ContainerSummaryStateEnum::{EXITED, RUNNING};
        let stacks = stacks_of(vec![
            summary("shop-web-2", RUNNING, &compose("shop", "web")),
            summary("shop-web-1", RUNNING, &compose("shop", "web")),
            summary("shop-db-1", EXITED, &compose("shop", "db")),
            summary("blog-app-1", RUNNING, &compose("blog", "app")),
        ]);
        let names: Vec<_> = stacks.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(names, ["blog", "shop"]);
        let shop = &stacks[1];
        assert_eq!((shop.running, shop.total), (2, 3));
        assert_eq!(shop.working_dir.as_deref(), Some("/srv/shop"));
        assert_eq!(
            shop.config_files,
            ["/srv/shop/compose.yml", "/srv/shop/override.yml"]
        );
        let services: Vec<_> = shop.services.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(services, ["db", "web"]);
        let web: Vec<_> = shop.services[1]
            .containers
            .iter()
            .map(|c| c.name.as_str())
            .collect();
        assert_eq!(web, ["shop-web-1", "shop-web-2"]);
    }

    #[test]
    fn ignores_containers_without_compose_labels() {
        use ContainerSummaryStateEnum::RUNNING;
        let stacks = stacks_of(vec![
            summary("plain", RUNNING, &[]),
            summary("empty", RUNNING, &[(COMPOSE_PROJECT_LABEL, "")]),
            summary("other", RUNNING, &[("com.example", "x")]),
        ]);
        assert!(stacks.is_empty());
    }

    #[test]
    fn tolerates_missing_optional_labels() {
        use ContainerSummaryStateEnum::PAUSED;
        let stacks = stacks_of(vec![summary(
            "solo",
            PAUSED,
            &[(COMPOSE_PROJECT_LABEL, "p")],
        )]);
        let stack = &stacks[0];
        assert_eq!(stack.working_dir, None);
        assert!(stack.config_files.is_empty());
        assert_eq!(stack.services[0].name, "solo");
        assert_eq!((stack.running, stack.total), (1, 1));
    }
}
