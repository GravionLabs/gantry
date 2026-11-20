use serde::{Deserialize, Serialize};
use specta::Type;

use crate::{Error, Result};

/// How Gantry reaches a Docker engine.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum EndpointKind {
    /// A Unix socket, e.g. `unix:///var/run/docker.sock`.
    Unix,
    /// A Windows named pipe, e.g. `npipe:////./pipe/docker_engine`.
    NamedPipe,
    /// Plain TCP, e.g. `tcp://127.0.0.1:2375`.
    Tcp,
    /// An SSH remote, e.g. `ssh://user@host`.
    Ssh,
}

/// A Docker engine the user can connect to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Endpoint {
    pub name: String,
    pub kind: EndpointKind,
    /// The address in Docker's `DOCKER_HOST` notation.
    pub address: String,
}

impl Endpoint {
    /// Builds an endpoint from an address in `DOCKER_HOST` notation.
    pub fn parse(name: impl Into<String>, address: &str) -> Result<Self> {
        let kind = match address.split_once("://").map(|(scheme, _)| scheme) {
            Some("unix") => EndpointKind::Unix,
            Some("npipe") => EndpointKind::NamedPipe,
            Some("tcp" | "http") => EndpointKind::Tcp,
            Some("ssh") => EndpointKind::Ssh,
            _ => return Err(Error::InvalidAddress(address.to_owned())),
        };
        Ok(Self {
            name: name.into(),
            kind,
            address: address.to_owned(),
        })
    }

    /// The default local engine of the current platform.
    pub fn local_default() -> Self {
        let address = if cfg!(windows) {
            "npipe:////./pipe/docker_engine"
        } else {
            "unix:///var/run/docker.sock"
        };
        Self::parse("local", address).expect("the default address is valid")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_known_schemes() {
        let cases = [
            ("unix:///var/run/docker.sock", EndpointKind::Unix),
            ("npipe:////./pipe/docker_engine", EndpointKind::NamedPipe),
            ("tcp://127.0.0.1:2375", EndpointKind::Tcp),
            ("ssh://deploy@build-01", EndpointKind::Ssh),
        ];
        for (address, kind) in cases {
            assert_eq!(
                Endpoint::parse("x", address).unwrap().kind,
                kind,
                "{address}"
            );
        }
    }

    #[test]
    fn rejects_unknown_scheme() {
        assert!(matches!(
            Endpoint::parse("x", "ftp://host"),
            Err(Error::InvalidAddress(_))
        ));
        assert!(Endpoint::parse("x", "/var/run/docker.sock").is_err());
    }

    #[test]
    fn serializes_camel_case() {
        let json =
            serde_json::to_value(Endpoint::parse("pipe", "npipe:////./pipe/x").unwrap()).unwrap();
        assert_eq!(json["kind"], "namedPipe");
    }
}
