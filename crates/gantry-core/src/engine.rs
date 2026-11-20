use bollard::{API_DEFAULT_VERSION, Docker};
use serde::Serialize;
use specta::Type;

use crate::{Endpoint, EndpointKind, Error, Result};

const TIMEOUT_SECS: u64 = 10;

/// Version information of a connected engine.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
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
        // SSH support is delivered by its own PBI (bollard `ssh` feature or an `ssh -L` tunnel).
        EndpointKind::Ssh => {
            return Err(Error::InvalidAddress(format!(
                "{address} (SSH is not supported yet)"
            )));
        }
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
