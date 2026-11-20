//! Detection of the Docker engines available on this machine.
//!
//! Detection only looks and connects; it never starts or modifies a runtime (ADR 0001). The
//! places to look come from a [`DetectEnv`], so tests run against fixture directories.

use std::{
    collections::HashSet,
    env, fs,
    future::Future,
    path::{Path, PathBuf},
    time::Duration,
};

use serde::Serialize;
use specta::Type;
use tokio::task::JoinSet;

use crate::{Endpoint, EngineInfo, ErrorKind, Result};

/// How long one candidate may take before it counts as not running.
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(3);

const PERMISSION_HINT: &str = "Permission denied: add your user to the `docker` group \
    (then sign in again) or use rootless Docker.";

/// The operating system family detection looks for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Os {
    Linux,
    MacOs,
    Windows,
}

impl Os {
    /// The operating system this build runs on.
    pub fn current() -> Self {
        if cfg!(windows) {
            Self::Windows
        } else if cfg!(target_os = "macos") {
            Self::MacOs
        } else {
            Self::Linux
        }
    }
}

/// Everything detection reads from its surroundings.
#[derive(Debug, Clone)]
pub struct DetectEnv {
    pub os: Os,
    /// The value of `DOCKER_HOST`.
    pub docker_host: Option<String>,
    /// The home directory of the user.
    pub home: Option<PathBuf>,
    /// The value of `XDG_RUNTIME_DIR`.
    pub xdg_runtime_dir: Option<PathBuf>,
    /// The system-wide socket, `/var/run/docker.sock`.
    pub system_socket: PathBuf,
}

impl DetectEnv {
    /// The environment of this process.
    pub fn from_process() -> Self {
        let non_empty = |name: &str| env::var_os(name).filter(|value| !value.is_empty());
        Self {
            os: Os::current(),
            docker_host: non_empty("DOCKER_HOST").and_then(|value| value.into_string().ok()),
            home: non_empty(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from),
            xdg_runtime_dir: non_empty("XDG_RUNTIME_DIR").map(PathBuf::from),
            system_socket: PathBuf::from("/var/run/docker.sock"),
        }
    }
}

/// Whether a detected engine can be used.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum EngineStatus {
    /// The engine answered.
    Reachable { info: EngineInfo },
    /// Nothing listens there (no socket, connection refused, timeout).
    NotRunning,
    /// The socket exists but the user may not use it.
    #[serde(rename_all = "camelCase")]
    PermissionDenied { hint: String },
}

/// A candidate with the result of probing it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DetectedEngine {
    /// Where the candidate comes from, e.g. `Colima (default)`. Also the endpoint name.
    pub source: String,
    pub endpoint: Endpoint,
    pub status: EngineStatus,
}

fn unix_endpoint(name: &str, path: &Path) -> Endpoint {
    Endpoint::parse(name, &format!("unix://{}", path.display())).expect("unix address is valid")
}

fn pipe_endpoint(name: &str, pipe: &str) -> Endpoint {
    Endpoint::parse(name, &format!("npipe:////./pipe/{pipe}")).expect("pipe address is valid")
}

/// The places an engine may listen, in order of precedence. Nothing is probed here.
///
/// Candidates that point to the same socket (symlinks) appear once, under the first name.
pub fn candidates(env: &DetectEnv) -> Vec<Endpoint> {
    let mut found = Vec::new();

    if let Some(endpoint) = env
        .docker_host
        .as_deref()
        .filter(|host| !host.is_empty())
        .and_then(|host| Endpoint::parse("DOCKER_HOST", host).ok())
    {
        found.push(endpoint);
    }

    if env.os == Os::Windows {
        found.push(pipe_endpoint("Docker (named pipe)", "docker_engine"));
        found.push(pipe_endpoint("Docker Desktop", "dockerDesktopLinuxEngine"));
    } else {
        found.push(unix_endpoint("Docker", &env.system_socket));
        if let Some(dir) = &env.xdg_runtime_dir {
            found.push(unix_endpoint("Rootless Docker", &dir.join("docker.sock")));
        }
        if let Some(home) = &env.home {
            let desktop = match env.os {
                Os::MacOs => home.join(".docker/run/docker.sock"),
                _ => home.join(".docker/desktop/docker.sock"),
            };
            found.push(unix_endpoint("Docker Desktop", &desktop));
            for profile in colima_profiles(&home.join(".colima")) {
                found.push(unix_endpoint(
                    &format!("Colima ({profile})"),
                    &home.join(".colima").join(&profile).join("docker.sock"),
                ));
            }
            found.push(unix_endpoint(
                "OrbStack",
                &home.join(".orbstack/run/docker.sock"),
            ));
        }
    }

    dedupe(found)
}

/// The profile directories of Colima, sorted. Names starting with `_` are internal.
fn colima_profiles(colima_dir: &Path) -> Vec<String> {
    let Ok(entries) = fs::read_dir(colima_dir) else {
        return Vec::new();
    };
    let mut profiles: Vec<String> = entries
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.path().is_dir())
        .filter_map(|entry| entry.file_name().into_string().ok())
        .filter(|name| !name.starts_with('_') && !name.starts_with('.'))
        .collect();
    profiles.sort();
    profiles
}

/// Drops endpoints that resolve to a socket already listed.
fn dedupe(endpoints: Vec<Endpoint>) -> Vec<Endpoint> {
    let mut seen = HashSet::new();
    endpoints
        .into_iter()
        .filter(|endpoint| {
            let key = match endpoint.address.strip_prefix("unix://") {
                Some(path) => fs::canonicalize(path)
                    .map(|real| real.display().to_string())
                    .unwrap_or_else(|_| path.to_owned()),
                None => endpoint.address.clone(),
            };
            seen.insert(key)
        })
        .collect()
}

/// Translates the outcome of a probe into a status.
pub fn status_of(result: Result<EngineInfo>) -> EngineStatus {
    match result {
        Ok(info) => EngineStatus::Reachable { info },
        Err(error) if error.kind() == ErrorKind::PermissionDenied => {
            EngineStatus::PermissionDenied {
                hint: PERMISSION_HINT.to_owned(),
            }
        }
        Err(_) => EngineStatus::NotRunning,
    }
}

/// Detects the engines of this machine.
pub async fn detect() -> Vec<DetectedEngine> {
    detect_with(
        &DetectEnv::from_process(),
        DEFAULT_TIMEOUT,
        |endpoint| async move { crate::ping(&endpoint).await },
    )
    .await
}

/// Probes every candidate of `env` in parallel; a probe that takes longer than `timeout` counts
/// as not running. The result keeps the order of [`candidates`].
pub async fn detect_with<P, F>(env: &DetectEnv, timeout: Duration, probe: P) -> Vec<DetectedEngine>
where
    P: Fn(Endpoint) -> F,
    F: Future<Output = Result<EngineInfo>> + Send + 'static,
{
    let mut tasks = JoinSet::new();
    let list = candidates(env);
    for (index, endpoint) in list.iter().cloned().enumerate() {
        let attempt = probe(endpoint);
        tasks.spawn(async move {
            let status = match tokio::time::timeout(timeout, attempt).await {
                Ok(result) => status_of(result),
                Err(_) => EngineStatus::NotRunning,
            };
            (index, status)
        });
    }
    let mut statuses = vec![EngineStatus::NotRunning; list.len()];
    while let Some(done) = tasks.join_next().await {
        if let Ok((index, status)) = done {
            statuses[index] = status;
        }
    }
    list.into_iter()
        .zip(statuses)
        .map(|(endpoint, status)| DetectedEngine {
            source: endpoint.name.clone(),
            endpoint,
            status,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use std::{io, time::Instant};

    use bollard::errors::Error as BollardError;

    use super::*;
    use crate::Error;

    fn env(os: Os, home: &Path) -> DetectEnv {
        DetectEnv {
            os,
            docker_host: None,
            home: Some(home.to_path_buf()),
            xdg_runtime_dir: None,
            system_socket: home.join("var-run-docker.sock"),
        }
    }

    fn fixture(name: &str) -> PathBuf {
        let dir = env::temp_dir().join(format!("gantry-detect-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn addresses(env: &DetectEnv) -> Vec<String> {
        candidates(env).into_iter().map(|e| e.address).collect()
    }

    fn info() -> EngineInfo {
        EngineInfo {
            version: Some("28.1.1".into()),
            api_version: Some("1.49".into()),
            os: Some("linux".into()),
            arch: Some("amd64".into()),
        }
    }

    #[test]
    fn docker_host_comes_first() {
        let home = fixture("host");
        let mut env = env(Os::Linux, &home);
        env.docker_host = Some("tcp://10.0.0.5:2375".into());
        let list = candidates(&env);
        assert_eq!(list[0].address, "tcp://10.0.0.5:2375");
        assert_eq!(list[0].name, "DOCKER_HOST");
    }

    #[test]
    fn invalid_or_empty_docker_host_is_ignored() {
        let home = fixture("badhost");
        let mut env = env(Os::Linux, &home);
        for value in ["", "not-an-address"] {
            env.docker_host = Some(value.into());
            assert!(candidates(&env).iter().all(|e| e.name != "DOCKER_HOST"));
        }
    }

    #[test]
    fn lists_the_system_socket() {
        let home = fixture("system");
        let env = env(Os::Linux, &home);
        assert!(addresses(&env).contains(&format!("unix://{}", env.system_socket.display())));
    }

    #[test]
    fn rootless_socket_needs_xdg_runtime_dir() {
        let home = fixture("rootless");
        let mut env = env(Os::Linux, &home);
        assert!(candidates(&env).iter().all(|e| e.name != "Rootless Docker"));
        env.xdg_runtime_dir = Some(PathBuf::from("/run/user/1000"));
        assert!(addresses(&env).contains(&"unix:///run/user/1000/docker.sock".to_owned()));
    }

    #[test]
    fn docker_desktop_path_depends_on_the_platform() {
        let home = fixture("desktop");
        let linux = addresses(&env(Os::Linux, &home));
        assert!(linux.contains(&format!(
            "unix://{}/.docker/desktop/docker.sock",
            home.display()
        )));
        let mac = addresses(&env(Os::MacOs, &home));
        assert!(mac.contains(&format!(
            "unix://{}/.docker/run/docker.sock",
            home.display()
        )));
        assert!(!mac.iter().any(|a| a.contains(".docker/desktop")));
    }

    #[test]
    fn lists_every_colima_profile() {
        let home = fixture("colima");
        for profile in ["default", "work", "_lima", ".hidden"] {
            fs::create_dir_all(home.join(".colima").join(profile)).unwrap();
        }
        fs::write(home.join(".colima/stray-file"), "").unwrap();
        let list = candidates(&env(Os::MacOs, &home));
        let colima: Vec<_> = list
            .iter()
            .filter(|e| e.name.starts_with("Colima"))
            .map(|e| (e.name.as_str(), e.address.as_str()))
            .collect();
        let base = home.display();
        assert_eq!(
            colima,
            [
                (
                    "Colima (default)",
                    format!("unix://{base}/.colima/default/docker.sock").as_str()
                ),
                (
                    "Colima (work)",
                    format!("unix://{base}/.colima/work/docker.sock").as_str()
                ),
            ]
        );
    }

    #[test]
    fn without_colima_directory_there_are_no_profiles() {
        let home = fixture("nocolima");
        assert!(
            candidates(&env(Os::Linux, &home))
                .iter()
                .all(|e| !e.name.starts_with("Colima"))
        );
    }

    #[test]
    fn lists_orbstack() {
        let home = fixture("orbstack");
        assert!(addresses(&env(Os::MacOs, &home)).contains(&format!(
            "unix://{}/.orbstack/run/docker.sock",
            home.display()
        )));
    }

    #[test]
    fn windows_lists_both_named_pipes_and_no_sockets() {
        let home = fixture("windows");
        let list = addresses(&env(Os::Windows, &home));
        assert_eq!(
            list,
            [
                "npipe:////./pipe/docker_engine",
                "npipe:////./pipe/dockerDesktopLinuxEngine"
            ]
        );
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_to_the_same_socket_are_listed_once() {
        use std::os::unix::{fs::symlink, net::UnixListener};

        let home = fixture("symlink");
        let real = home.join("real.sock");
        let _listener = UnixListener::bind(&real).unwrap();
        let mut env = env(Os::Linux, &home);
        env.system_socket = real.clone();
        fs::create_dir_all(home.join(".docker/desktop")).unwrap();
        symlink(&real, home.join(".docker/desktop/docker.sock")).unwrap();
        fs::create_dir_all(home.join(".orbstack/run")).unwrap();
        symlink(&real, home.join(".orbstack/run/docker.sock")).unwrap();

        let list = candidates(&env);
        assert_eq!(list.len(), 1, "{list:?}");
        assert_eq!(list[0].name, "Docker");
    }

    #[test]
    fn maps_probe_results_to_statuses() {
        assert_eq!(
            status_of(Ok(info())),
            EngineStatus::Reachable { info: info() }
        );
        let denied = Error::Docker(BollardError::IOError {
            err: io::Error::from(io::ErrorKind::PermissionDenied),
        });
        match status_of(Err(denied)) {
            EngineStatus::PermissionDenied { hint } => {
                assert!(
                    hint.contains("`docker` group") && hint.contains("rootless"),
                    "{hint}"
                );
            }
            other => panic!("{other:?}"),
        }
        let refused = Error::Docker(BollardError::IOError {
            err: io::Error::from(io::ErrorKind::ConnectionRefused),
        });
        assert_eq!(status_of(Err(refused)), EngineStatus::NotRunning);
        assert_eq!(
            status_of(Err(Error::InvalidAddress("x".into()))),
            EngineStatus::NotRunning
        );
    }

    #[tokio::test]
    async fn probes_run_in_parallel_with_a_timeout() {
        let home = fixture("parallel");
        let mut env = env(Os::Linux, &home);
        env.docker_host = Some("tcp://127.0.0.1:1".into());
        let total = candidates(&env).len();
        assert!(total >= 3);

        let started = Instant::now();
        let found = detect_with(&env, Duration::from_millis(200), |endpoint| async move {
            match endpoint.name.as_str() {
                "DOCKER_HOST" => Ok(EngineInfo {
                    version: Some("28".into()),
                    api_version: None,
                    os: None,
                    arch: None,
                }),
                "Docker" => Ok(info()),
                _ => {
                    tokio::time::sleep(Duration::from_secs(30)).await;
                    Ok(info())
                }
            }
        })
        .await;

        assert!(started.elapsed() < Duration::from_secs(5));
        assert_eq!(found.len(), total);
        assert_eq!(found[0].source, "DOCKER_HOST");
        assert!(matches!(found[0].status, EngineStatus::Reachable { .. }));
        assert!(matches!(found[1].status, EngineStatus::Reachable { .. }));
        assert!(
            found[2..]
                .iter()
                .all(|e| e.status == EngineStatus::NotRunning)
        );
    }

    #[tokio::test]
    async fn a_missing_socket_is_not_running() {
        let home = fixture("missing");
        let found = detect_with(
            &env(Os::Linux, &home),
            DEFAULT_TIMEOUT,
            |endpoint| async move { crate::ping(&endpoint).await },
        )
        .await;
        assert!(!found.is_empty());
        assert!(found.iter().all(|e| e.status == EngineStatus::NotRunning));
    }

    #[test]
    fn serializes_the_status_with_a_state_tag() {
        let json = serde_json::to_value(EngineStatus::NotRunning).unwrap();
        assert_eq!(json["state"], "notRunning");
        let json = serde_json::to_value(EngineStatus::Reachable { info: info() }).unwrap();
        assert_eq!(json["state"], "reachable");
        assert_eq!(json["info"]["apiVersion"], "1.49");
        let json =
            serde_json::to_value(EngineStatus::PermissionDenied { hint: "h".into() }).unwrap();
        assert_eq!(json["state"], "permissionDenied");
        assert_eq!(json["hint"], "h");
    }
}
