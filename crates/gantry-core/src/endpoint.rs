use std::path::PathBuf;

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

/// Client certificates for a TLS-secured TCP endpoint (Docker's `ca.pem`, `cert.pem`, `key.pem`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TlsFiles {
    pub ca: String,
    pub cert: String,
    pub key: String,
}

impl TlsFiles {
    /// The three files below `dir`, using Docker's file names.
    pub fn in_dir(dir: &std::path::Path) -> Self {
        let file = |name: &str| dir.join(name).to_string_lossy().into_owned();
        Self {
            ca: file("ca.pem"),
            cert: file("cert.pem"),
            key: file("key.pem"),
        }
    }

    pub(crate) fn paths(&self) -> (PathBuf, PathBuf, PathBuf) {
        (
            PathBuf::from(&self.ca),
            PathBuf::from(&self.cert),
            PathBuf::from(&self.key),
        )
    }
}

/// A Docker engine the user can connect to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Endpoint {
    pub name: String,
    pub kind: EndpointKind,
    /// The address in Docker's `DOCKER_HOST` notation.
    pub address: String,
    /// Client certificates; set for TLS endpoints only.
    pub tls: Option<TlsFiles>,
    /// The context asks to skip server certificate verification. Gantry still verifies.
    pub skip_tls_verify: bool,
    /// Imported from a Docker context: edited with `docker context`, not in Gantry.
    pub read_only: bool,
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
            tls: None,
            skip_tls_verify: false,
            read_only: false,
        })
    }

    /// Builds a manual endpoint the user typed in: TCP, TCP with TLS or SSH.
    ///
    /// The kind follows the address scheme. TLS files are accepted for TCP only and need all three
    /// paths. Unix sockets and named pipes are found by detection, not entered by hand.
    pub fn manual(name: &str, address: &str, tls: Option<TlsFiles>) -> Result<Self> {
        let name = name.trim();
        if name.is_empty() {
            return Err(Error::InvalidAddress("the name is empty".to_owned()));
        }
        let address = address.trim();
        let mut endpoint = Self::parse(name, address)?;
        let host = address.split_once("://").map_or("", |(_, rest)| rest);
        if !matches!(endpoint.kind, EndpointKind::Tcp | EndpointKind::Ssh) || host.is_empty() {
            return Err(Error::InvalidAddress(format!(
                "{address} (use tcp://host:port or ssh://user@host)"
            )));
        }
        if let Some(files) = tls {
            if endpoint.kind != EndpointKind::Tcp {
                return Err(Error::InvalidAddress(
                    "TLS applies to TCP endpoints only".to_owned(),
                ));
            }
            if [&files.ca, &files.cert, &files.key]
                .iter()
                .any(|path| path.trim().is_empty())
            {
                return Err(Error::InvalidAddress(
                    "TLS needs the CA, certificate and key files".to_owned(),
                ));
            }
            endpoint.tls = Some(files);
        }
        Ok(endpoint)
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

    fn files() -> TlsFiles {
        TlsFiles::in_dir(std::path::Path::new("/certs"))
    }

    #[test]
    fn manual_endpoint_takes_its_kind_from_the_address() {
        let tcp = Endpoint::manual(" build ", " tcp://10.0.0.5:2375 ", None).unwrap();
        assert_eq!((tcp.name.as_str(), tcp.kind), ("build", EndpointKind::Tcp));
        assert_eq!(tcp.address, "tcp://10.0.0.5:2375");
        assert!(tcp.tls.is_none() && !tcp.read_only);
        let tls = Endpoint::manual("secure", "tcp://host:2376", Some(files())).unwrap();
        assert_eq!(tls.tls, Some(files()));
        let ssh = Endpoint::manual("remote", "ssh://deploy@host", None).unwrap();
        assert_eq!(ssh.kind, EndpointKind::Ssh);
    }

    #[test]
    fn manual_endpoint_rejects_bad_input() {
        let empty = TlsFiles {
            ca: String::new(),
            ..files()
        };
        let cases = [
            Endpoint::manual("", "tcp://h:1", None),
            Endpoint::manual("x", "tcp://", None),
            Endpoint::manual("x", "unix:///var/run/docker.sock", None),
            Endpoint::manual("x", "host:2375", None),
            Endpoint::manual("x", "ssh://h", Some(files())),
            Endpoint::manual("x", "tcp://h:1", Some(empty)),
        ];
        for case in cases {
            assert!(matches!(case, Err(Error::InvalidAddress(_))), "{case:?}");
        }
    }

    #[test]
    fn serializes_camel_case() {
        let json =
            serde_json::to_value(Endpoint::parse("pipe", "npipe:////./pipe/x").unwrap()).unwrap();
        assert_eq!(json["kind"], "namedPipe");
    }
}
