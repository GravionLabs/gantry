//! Docker CLI contexts as read-only endpoints.
//!
//! Contexts live in `<config>/contexts/meta/<sha256(name)>/meta.json`; their TLS material in
//! `<config>/contexts/tls/<sha256(name)>/docker/{ca,cert,key}.pem`. `<config>` is `DOCKER_CONFIG`,
//! else `~/.docker`. Gantry never writes them: they are edited with `docker context`.

use std::{
    env, fs,
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use specta::Type;

use crate::{Endpoint, endpoint::TlsFiles};

/// The name of the implicit context that always exists.
pub const DEFAULT_CONTEXT: &str = "default";

/// The imported contexts, the current one and what was skipped.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ContextList {
    /// `default` first, then the contexts sorted by name. All are read-only.
    pub contexts: Vec<Endpoint>,
    /// The name of the current context (not necessarily present in `contexts`).
    pub current: String,
    /// One line per context that was skipped because it is malformed.
    pub warnings: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct Meta {
    name: String,
    endpoints: Endpoints,
}

#[derive(Deserialize)]
struct Endpoints {
    docker: Option<DockerEndpoint>,
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct DockerEndpoint {
    host: String,
    #[serde(default, rename = "SkipTLSVerify")]
    skip_tls_verify: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CliConfig {
    current_context: Option<String>,
}

/// The Docker CLI configuration directory: `DOCKER_CONFIG`, else `~/.docker`.
pub fn docker_config_dir() -> Option<PathBuf> {
    if let Some(dir) = env::var_os("DOCKER_CONFIG").filter(|dir| !dir.is_empty()) {
        return Some(PathBuf::from(dir));
    }
    let home = env::var_os("HOME").or_else(|| env::var_os("USERPROFILE"))?;
    Some(PathBuf::from(home).join(".docker"))
}

/// Imports the contexts of the Docker CLI configuration found through the environment.
pub fn import_contexts() -> ContextList {
    let env_context = env::var("DOCKER_CONTEXT").ok();
    match docker_config_dir() {
        Some(dir) => read_contexts(&dir, env_context.as_deref()),
        None => ContextList {
            contexts: vec![default_context()],
            current: env_context
                .filter(|name| !name.is_empty())
                .unwrap_or_else(|| DEFAULT_CONTEXT.to_owned()),
            warnings: vec!["Docker configuration directory not found".to_owned()],
        },
    }
}

/// Reads the contexts below `config_dir`; `env_context` is the value of `DOCKER_CONTEXT`.
pub fn read_contexts(config_dir: &Path, env_context: Option<&str>) -> ContextList {
    let mut warnings = Vec::new();
    let mut found = Vec::new();
    let meta_dir = config_dir.join("contexts").join("meta");
    if let Ok(entries) = fs::read_dir(&meta_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            match read_context(config_dir, &path.join("meta.json")) {
                Ok(endpoint) => found.push(endpoint),
                Err(reason) => warnings.push(format!(
                    "skipped Docker context {}: {reason}",
                    entry.file_name().to_string_lossy()
                )),
            }
        }
    }
    found.retain(|endpoint| endpoint.name != DEFAULT_CONTEXT);
    found.sort_by(|a, b| a.name.cmp(&b.name));
    warnings.sort();
    let mut contexts = vec![default_context()];
    contexts.extend(found);
    ContextList {
        contexts,
        current: current_context(config_dir, env_context),
        warnings,
    }
}

/// `DOCKER_CONTEXT`, else `currentContext` of `config.json`, else `default`.
pub fn current_context(config_dir: &Path, env_context: Option<&str>) -> String {
    env_context
        .filter(|name| !name.is_empty())
        .map(str::to_owned)
        .or_else(|| {
            let text = fs::read_to_string(config_dir.join("config.json")).ok()?;
            serde_json::from_str::<CliConfig>(&text)
                .ok()?
                .current_context
                .filter(|name| !name.is_empty())
        })
        .unwrap_or_else(|| DEFAULT_CONTEXT.to_owned())
}

fn default_context() -> Endpoint {
    let mut endpoint = Endpoint::local_default();
    endpoint.name = DEFAULT_CONTEXT.to_owned();
    endpoint.read_only = true;
    endpoint
}

fn read_context(config_dir: &Path, meta_path: &Path) -> Result<Endpoint, String> {
    let text = fs::read_to_string(meta_path).map_err(|error| format!("meta.json: {error}"))?;
    let meta: Meta =
        serde_json::from_str(&text).map_err(|error| format!("invalid meta.json: {error}"))?;
    if meta.name.is_empty() {
        return Err("empty name".to_owned());
    }
    let docker = meta
        .endpoints
        .docker
        .ok_or_else(|| "no docker endpoint".to_owned())?;
    let mut endpoint =
        Endpoint::parse(&meta.name, &docker.host).map_err(|error| error.to_string())?;
    endpoint.read_only = true;
    endpoint.skip_tls_verify = docker.skip_tls_verify;

    let digest = hex_sha256(&meta.name);
    let tls_dir = config_dir
        .join("contexts")
        .join("tls")
        .join(digest)
        .join("docker");
    if tls_dir.is_dir() {
        let files = TlsFiles::in_dir(&tls_dir);
        let (ca, cert, key) = files.paths();
        if ca.is_file() && cert.is_file() && key.is_file() {
            endpoint.tls = Some(files);
        } else {
            return Err("incomplete TLS material (ca.pem, cert.pem, key.pem)".to_owned());
        }
    }
    Ok(endpoint)
}

fn hex_sha256(text: &str) -> String {
    Sha256::digest(text.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::EndpointKind;

    fn write_context(root: &Path, name: &str, meta: &str, tls: bool) {
        let digest = hex_sha256(name);
        let dir = root.join("contexts/meta").join(&digest);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("meta.json"), meta).unwrap();
        if tls {
            let tls_dir = root.join("contexts/tls").join(digest).join("docker");
            fs::create_dir_all(&tls_dir).unwrap();
            for file in ["ca.pem", "cert.pem", "key.pem"] {
                fs::write(tls_dir.join(file), "pem").unwrap();
            }
        }
    }

    fn meta(name: &str, host: &str, skip: bool) -> String {
        format!(
            r#"{{"Name":"{name}","Metadata":{{}},"Endpoints":{{"docker":{{"Host":"{host}","SkipTLSVerify":{skip}}}}}}}"#
        )
    }

    #[test]
    fn imports_contexts_read_only_with_default_first() {
        let root = tempfile::tempdir().unwrap();
        write_context(
            root.path(),
            "zeta",
            &meta("zeta", "ssh://me@zeta", false),
            false,
        );
        write_context(
            root.path(),
            "alpha",
            &meta("alpha", "tcp://10.0.0.5:2376", true),
            true,
        );
        let list = read_contexts(root.path(), None);
        let names: Vec<_> = list.contexts.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, ["default", "alpha", "zeta"]);
        assert!(list.contexts.iter().all(|c| c.read_only));
        assert!(list.warnings.is_empty());
        let alpha = &list.contexts[1];
        assert_eq!(alpha.kind, EndpointKind::Tcp);
        assert!(alpha.skip_tls_verify);
        let tls = alpha.tls.as_ref().unwrap();
        assert!(tls.ca.ends_with("ca.pem") && tls.key.contains(&hex_sha256("alpha")));
        assert!(list.contexts[2].tls.is_none());
    }

    #[test]
    fn malformed_contexts_are_skipped_with_a_warning() {
        let root = tempfile::tempdir().unwrap();
        write_context(
            root.path(),
            "good",
            &meta("good", "unix:///x.sock", false),
            false,
        );
        write_context(root.path(), "broken", "{ not json", false);
        write_context(
            root.path(),
            "nohost",
            r#"{"Name":"nohost","Endpoints":{}}"#,
            false,
        );
        write_context(
            root.path(),
            "badscheme",
            &meta("badscheme", "ftp://h", false),
            false,
        );
        write_context(
            root.path(),
            "partial",
            &meta("partial", "tcp://h:2376", false),
            true,
        );
        fs::remove_file(
            root.path()
                .join("contexts/tls")
                .join(hex_sha256("partial"))
                .join("docker/key.pem"),
        )
        .unwrap();
        let list = read_contexts(root.path(), None);
        let names: Vec<_> = list.contexts.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, ["default", "good"]);
        assert_eq!(list.warnings.len(), 4, "{:?}", list.warnings);
    }

    #[test]
    fn missing_config_dir_yields_only_default() {
        let root = tempfile::tempdir().unwrap();
        let list = read_contexts(&root.path().join("absent"), None);
        assert_eq!(list.contexts.len(), 1);
        assert_eq!(list.current, "default");
    }

    #[test]
    fn current_context_prefers_env_then_config_then_default() {
        let root = tempfile::tempdir().unwrap();
        assert_eq!(current_context(root.path(), None), "default");
        fs::write(
            root.path().join("config.json"),
            r#"{"currentContext":"prod"}"#,
        )
        .unwrap();
        assert_eq!(current_context(root.path(), None), "prod");
        assert_eq!(current_context(root.path(), Some("")), "prod");
        assert_eq!(current_context(root.path(), Some("dev")), "dev");
        fs::write(root.path().join("config.json"), "garbage").unwrap();
        assert_eq!(current_context(root.path(), None), "default");
    }
}
