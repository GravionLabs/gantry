//! Networks: the list with the subnets and the containers on each network, create, remove, prune,
//! connect and disconnect.

use std::collections::HashMap;

use bollard::Docker;
use bollard::models::{
    ContainerSummary, Ipam, IpamConfig, Network as EngineNetwork, NetworkConnectRequest,
    NetworkCreateRequest, NetworkDisconnectRequest,
};
use bollard::query_parameters::{
    ListContainersOptionsBuilder, ListNetworksOptionsBuilder, PruneNetworksOptionsBuilder,
};
use serde::Serialize;
use specta::Type;

use crate::{Error, Result};

/// The networks every engine creates; they cannot be removed.
const BUILTIN: [&str; 3] = ["bridge", "host", "none"];

/// One row of the network list.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Network {
    pub id: String,
    pub name: String,
    pub driver: String,
    pub scope: String,
    /// The subnets of the address pool (IPv4 and IPv6); empty for `host` and `none`.
    pub subnets: Vec<String>,
    /// The names of the containers (in any state) that are connected to the network.
    pub containers: Vec<String>,
    /// `bridge`, `host` and `none`: the engine does not remove them.
    pub builtin: bool,
}

/// The container names per network, keyed by network id and by network name.
fn usage_of(containers: Vec<ContainerSummary>) -> HashMap<String, Vec<String>> {
    let mut usage: HashMap<String, Vec<String>> = HashMap::new();
    for container in containers {
        let name = container
            .names
            .and_then(|names| names.into_iter().next())
            .map(|n| n.trim_start_matches('/').to_owned())
            .or_else(|| container.id.clone())
            .unwrap_or_default();
        let networks = container
            .network_settings
            .and_then(|s| s.networks)
            .unwrap_or_default();
        for (network, endpoint) in networks {
            usage.entry(network).or_default().push(name.clone());
            if let Some(id) = endpoint.network_id.filter(|id| !id.is_empty()) {
                usage.entry(id).or_default().push(name.clone());
            }
        }
    }
    for names in usage.values_mut() {
        names.sort();
        names.dedup();
    }
    usage
}

/// The rows of the network list ordered by name.
fn networks_of(networks: Vec<EngineNetwork>, usage: &HashMap<String, Vec<String>>) -> Vec<Network> {
    let mut rows: Vec<Network> = networks
        .into_iter()
        .map(|network| {
            let id = network.id.unwrap_or_default();
            let name = network.name.unwrap_or_default();
            let mut containers = usage.get(&id).cloned().unwrap_or_default();
            for extra in usage.get(&name).into_iter().flatten() {
                if !containers.contains(extra) {
                    containers.push(extra.clone());
                }
            }
            containers.sort();
            let subnets = network
                .ipam
                .and_then(|ipam| ipam.config)
                .unwrap_or_default()
                .into_iter()
                .filter_map(|config| config.subnet)
                .collect();
            Network {
                builtin: BUILTIN.contains(&name.as_str()),
                id,
                name,
                driver: network.driver.unwrap_or_default(),
                scope: network.scope.unwrap_or_default(),
                subnets,
                containers,
            }
        })
        .collect();
    rows.sort_by(|a, b| a.name.cmp(&b.name));
    rows
}

/// Lists the networks of the engine with their subnets and the containers on them.
pub async fn list_networks(docker: &Docker) -> Result<Vec<Network>> {
    let containers = ListContainersOptionsBuilder::default().all(true).build();
    let (list, containers) = tokio::join!(
        docker.list_networks(Some(ListNetworksOptionsBuilder::default().build())),
        docker.list_containers(Some(containers)),
    );
    Ok(networks_of(list?, &usage_of(containers?)))
}

/// What creating a network takes: a bridge network with an optional subnet.
#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct NetworkSpec {
    pub name: String,
    /// The subnet in CIDR notation; empty for the engine's choice.
    pub subnet: String,
}

fn request_of(spec: NetworkSpec) -> Result<NetworkCreateRequest> {
    let name = spec.name.trim();
    if name.is_empty() || name.contains(char::is_whitespace) || name.contains('/') {
        return Err(Error::InvalidInput(
            "a network name is not empty and has no spaces or slashes".to_owned(),
        ));
    }
    let subnet = spec.subnet.trim();
    if !subnet.is_empty() && !is_cidr(subnet) {
        return Err(Error::InvalidInput(format!(
            "the subnet {subnet} is not an address range such as 172.30.0.0/16"
        )));
    }
    Ok(NetworkCreateRequest {
        name: name.to_owned(),
        driver: Some("bridge".to_owned()),
        ipam: (!subnet.is_empty()).then(|| Ipam {
            config: Some(vec![IpamConfig {
                subnet: Some(subnet.to_owned()),
                ..Default::default()
            }]),
            ..Default::default()
        }),
        ..Default::default()
    })
}

/// Whether `text` is an IPv4 or IPv6 address with a prefix length.
fn is_cidr(text: &str) -> bool {
    let Some((address, prefix)) = text.split_once('/') else {
        return false;
    };
    let Ok(prefix) = prefix.parse::<u8>() else {
        return false;
    };
    match address.parse::<std::net::IpAddr>() {
        Ok(std::net::IpAddr::V4(_)) => prefix <= 32,
        Ok(std::net::IpAddr::V6(_)) => prefix <= 128,
        Err(_) => false,
    }
}

/// Creates a bridge network.
pub async fn create_network(docker: &Docker, spec: NetworkSpec) -> Result<()> {
    docker.create_network(request_of(spec)?).await?;
    Ok(())
}

/// Removes a network by name or id.
pub async fn remove_network(docker: &Docker, name: &str) -> Result<()> {
    docker.remove_network(name).await?;
    Ok(())
}

/// What a prune removed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct NetworkPruneOutcome {
    /// The names of the networks the engine deleted.
    pub removed: Vec<String>,
}

/// Removes every network no container uses (the built-in ones stay).
pub async fn prune_networks(docker: &Docker) -> Result<NetworkPruneOutcome> {
    let options = PruneNetworksOptionsBuilder::default().build();
    let response = docker.prune_networks(Some(options)).await?;
    Ok(NetworkPruneOutcome {
        removed: response.networks_deleted.unwrap_or_default(),
    })
}

/// Connects a container (name or id) to a network.
pub async fn connect_network(docker: &Docker, network: &str, container: &str) -> Result<()> {
    let request = NetworkConnectRequest {
        container: container.to_owned(),
        endpoint_config: None,
    };
    docker.connect_network(network, request).await?;
    Ok(())
}

/// Disconnects a container (name or id) from a network. `force` also disconnects a container
/// the engine considers gone.
pub async fn disconnect_network(
    docker: &Docker,
    network: &str,
    container: &str,
    force: bool,
) -> Result<()> {
    let request = NetworkDisconnectRequest {
        container: container.to_owned(),
        force: Some(force),
    };
    docker.disconnect_network(network, request).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use bollard::models::{ContainerSummaryNetworkSettings, EndpointSettings};

    use super::*;

    fn container(name: &str, networks: &[(&str, &str)]) -> ContainerSummary {
        ContainerSummary {
            names: Some(vec![format!("/{name}")]),
            network_settings: Some(ContainerSummaryNetworkSettings {
                networks: Some(
                    networks
                        .iter()
                        .map(|(network, id)| {
                            (
                                (*network).to_owned(),
                                EndpointSettings {
                                    network_id: Some((*id).to_owned()),
                                    ..Default::default()
                                },
                            )
                        })
                        .collect(),
                ),
            }),
            ..Default::default()
        }
    }

    fn network(name: &str, subnet: Option<&str>) -> EngineNetwork {
        EngineNetwork {
            id: Some(format!("id-{name}")),
            name: Some(name.to_owned()),
            driver: Some("bridge".to_owned()),
            scope: Some("local".to_owned()),
            ipam: Some(Ipam {
                config: Some(
                    subnet
                        .map(|s| {
                            vec![IpamConfig {
                                subnet: Some(s.to_owned()),
                                ..Default::default()
                            }]
                        })
                        .unwrap_or_default(),
                ),
                ..Default::default()
            }),
            ..Default::default()
        }
    }

    #[test]
    fn names_the_containers_per_network_once() {
        let usage = usage_of(vec![
            container("web", &[("app", "id-app")]),
            container("db", &[("app", "id-app"), ("bridge", "id-bridge")]),
        ]);
        assert_eq!(usage["app"], ["db", "web"]);
        assert_eq!(usage["id-app"], ["db", "web"]);
        assert_eq!(usage["id-bridge"], ["db"]);
    }

    #[test]
    fn rows_are_sorted_with_subnets_users_and_the_builtin_flag() {
        let usage = HashMap::from([("id-app".to_owned(), vec!["web".to_owned()])]);
        let rows = networks_of(
            vec![
                network("bridge", Some("172.17.0.0/16")),
                network("app", Some("10.0.0.0/24")),
                network("host", None),
            ],
            &usage,
        );
        let names: Vec<_> = rows.iter().map(|n| n.name.as_str()).collect();
        assert_eq!(names, ["app", "bridge", "host"]);
        assert_eq!(rows[0].subnets, ["10.0.0.0/24"]);
        assert_eq!(rows[0].containers, ["web"]);
        assert_eq!(rows[0].scope, "local");
        assert!(!rows[0].builtin);
        assert!(rows[1].builtin && rows[2].builtin);
        assert!(rows[2].subnets.is_empty());
    }

    fn spec(name: &str, subnet: &str) -> NetworkSpec {
        NetworkSpec {
            name: name.to_owned(),
            subnet: subnet.to_owned(),
        }
    }

    #[test]
    fn builds_a_bridge_request_with_an_optional_subnet() {
        let request = request_of(spec(" app ", "")).unwrap();
        assert_eq!(request.name, "app");
        assert_eq!(request.driver.as_deref(), Some("bridge"));
        assert!(request.ipam.is_none());
        let request = request_of(spec("app", " 172.30.0.0/16 ")).unwrap();
        let config = request.ipam.unwrap().config.unwrap();
        assert_eq!(config[0].subnet.as_deref(), Some("172.30.0.0/16"));
        assert!(request_of(spec("app", "fd00::/64")).is_ok());
    }

    #[test]
    fn rejects_bad_names_and_subnets() {
        for bad in [
            spec("", ""),
            spec("a b", ""),
            spec("a/b", ""),
            spec("a", "10.0.0.0"),
            spec("a", "10.0.0.0/33"),
            spec("a", "nope/8"),
            spec("a", "fd00::/129"),
        ] {
            assert!(request_of(bad).is_err());
        }
    }
}
