use bollard::{API_DEFAULT_VERSION, Docker};
use serde::Serialize;
use specta::Type;

use crate::{Endpoint, EndpointKind, Result};

const TIMEOUT_SECS: u64 = 10;

/// Version information of a connected engine.
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct EngineInfo {
    pub version: Option<String>,
    pub api_version: Option<String>,
    pub os: Option<String>,
    pub arch: Option<String>,
}

/// Opens a client for the endpoint. Connecting is lazy: errors show up on the first request.
pub fn connect(endpoint: &Endpoint) -> Result<Docker> {
    let address = endpoint.address.as_str();
    let docker = match endpoint.kind {
        EndpointKind::Unix | EndpointKind::NamedPipe => {
            Docker::connect_with_local(address, TIMEOUT_SECS, API_DEFAULT_VERSION)?
        }
        EndpointKind::Tcp => Docker::connect_with_http(address, TIMEOUT_SECS, API_DEFAULT_VERSION)?,
        EndpointKind::Ssh => crate::ssh::connect(address, TIMEOUT_SECS)?,
    };
    Ok(docker)
}

/// Connects and reads the engine version.
pub async fn ping(endpoint: &Endpoint) -> Result<EngineInfo> {
    let version = connect(endpoint)?.version().await?;
    Ok(EngineInfo {
        version: version.version,
        api_version: version.api_version,
        os: version.os,
        arch: version.arch,
    })
}

/// The connections of the active endpoint. An SSH connection is one `ssh` process that is reused
/// until the endpoint is switched or [`Connections::close_all`] runs (call it when the app exits).
#[derive(Default)]
pub struct Connections {
    active: std::sync::Mutex<Option<(String, Docker)>>,
}

impl Connections {
    /// Makes the endpoint the active one and returns its client. The same endpoint reuses its
    /// connection; any other previous endpoint is closed.
    pub fn activate(&self, endpoint: &Endpoint) -> Result<Docker> {
        let mut active = self.active.lock().expect("connections lock");
        if let Some((address, docker)) = active.as_ref()
            && *address == endpoint.address
        {
            return Ok(docker.clone());
        }
        // Drop the old client first so its `ssh` process ends before a new one starts.
        *active = None;
        let docker = connect(endpoint)?;
        *active = Some((endpoint.address.clone(), docker.clone()));
        Ok(docker)
    }

    /// The client of the active endpoint, if any.
    pub fn current(&self) -> Option<Docker> {
        let active = self.active.lock().expect("connections lock");
        active.as_ref().map(|(_, docker)| docker.clone())
    }

    /// Closes the active connection.
    pub fn close_all(&self) {
        *self.active.lock().expect("connections lock") = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn reuses_the_client_for_the_same_endpoint_and_closes_on_switch() {
        let connections = Connections::default();
        let a = Endpoint::parse("a", "ssh://host-a").unwrap();
        let b = Endpoint::parse("b", "ssh://host-b").unwrap();
        connections.activate(&a).unwrap();
        connections.activate(&a).unwrap();
        assert!(connections.current().is_some());
        connections.activate(&b).unwrap();
        let active = connections.active.lock().unwrap();
        assert_eq!(active.as_ref().unwrap().0, "ssh://host-b");
        drop(active);
        connections.close_all();
        assert!(connections.current().is_none());
    }
}
