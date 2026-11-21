//! Compose stack actions through the `docker compose` CLI (ADR 0001: Compose is not reimplemented).
//!
//! The CLI is called with `-p <project>`, the Compose files of the stack and `--project-directory`,
//! and it is pointed at the engine of the endpoint with `DOCKER_HOST` (plus the TLS variables for a
//! TLS endpoint). The output is streamed line by line.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use specta::Type;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::Notify;

use crate::logs::LogStream;
use crate::{Endpoint, Error, ErrorKind, Result};

/// How long `docker compose version` may take.
const VERSION_TIMEOUT: Duration = Duration::from_secs(10);

/// A Compose action on a stack.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ComposeAction {
    /// `docker compose up -d`.
    Up,
    /// `docker compose down`; with `volumes` also `-v`, which the UI asks for explicitly.
    Down { volumes: bool },
    /// `docker compose restart`.
    Restart,
    /// `docker compose pull`.
    Pull,
}

/// What the CLI needs to know about a stack: the project name and where its files are.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ComposeProject {
    pub name: String,
    pub working_dir: Option<String>,
    pub config_files: Vec<String>,
}

/// A `docker` invocation: arguments and the environment that points it at an engine.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ComposeCommand {
    pub program: String,
    pub args: Vec<String>,
    /// Variables to set.
    pub env: Vec<(String, String)>,
    /// Variables to remove, so that the environment of Gantry cannot redirect the command.
    pub env_remove: Vec<&'static str>,
}

fn invalid(message: impl Into<String>) -> Error {
    Error::Compose {
        kind: ErrorKind::InvalidInput,
        message: message.into(),
    }
}

/// The variables that select the engine and its TLS material for the CLI.
type EndpointEnv = (Vec<(String, String)>, Vec<&'static str>);

fn endpoint_env(endpoint: &Endpoint) -> Result<EndpointEnv> {
    let mut env = vec![("DOCKER_HOST".to_owned(), endpoint.address.clone())];
    // `DOCKER_CONTEXT` together with `DOCKER_HOST` is an error of the CLI, and a leftover
    // `DOCKER_CONFIG` or TLS variable must not change the endpoint.
    let mut remove = vec!["DOCKER_CONTEXT"];
    match &endpoint.tls {
        Some(tls) => {
            let (ca, cert, key) = tls.paths();
            let dir = ca.parent().map(Path::to_path_buf).unwrap_or_default();
            let standard = |path: &PathBuf, name: &str| {
                path.file_name().is_some_and(|f| f == name) && path.parent() == Some(dir.as_path())
            };
            if !(standard(&ca, "ca.pem")
                && standard(&cert, "cert.pem")
                && standard(&key, "key.pem"))
            {
                return Err(invalid(
                    "Compose needs the TLS files ca.pem, cert.pem and key.pem in one directory",
                ));
            }
            env.push(("DOCKER_TLS_VERIFY".to_owned(), "1".to_owned()));
            env.push((
                "DOCKER_CERT_PATH".to_owned(),
                dir.to_string_lossy().into_owned(),
            ));
        }
        None => {
            remove.push("DOCKER_TLS_VERIFY");
            remove.push("DOCKER_CERT_PATH");
        }
    }
    Ok((env, remove))
}

/// Builds the `docker compose` command that performs `action` on `project` at `endpoint`.
///
/// Fails when the project has no working directory or no Compose files (a stack started on another
/// machine), because the CLI cannot reproduce it without them.
pub fn build_command(
    endpoint: &Endpoint,
    project: &ComposeProject,
    action: ComposeAction,
) -> Result<ComposeCommand> {
    if project.name.trim().is_empty() {
        return Err(invalid("the stack has no name"));
    }
    let Some(dir) = project.working_dir.as_deref().filter(|d| !d.is_empty()) else {
        return Err(invalid(
            "the stack does not say in which directory it was started",
        ));
    };
    if project.config_files.is_empty() {
        return Err(invalid(
            "the stack does not say which Compose files it uses",
        ));
    }
    let mut args: Vec<String> = ["compose", "--ansi", "never", "-p", &project.name]
        .map(str::to_owned)
        .into();
    for file in &project.config_files {
        args.push("-f".to_owned());
        args.push(file.clone());
    }
    args.push("--project-directory".to_owned());
    args.push(dir.to_owned());
    match action {
        ComposeAction::Up => args.extend(["up".to_owned(), "-d".to_owned()]),
        ComposeAction::Down { volumes: false } => args.push("down".to_owned()),
        ComposeAction::Down { volumes: true } => {
            args.extend(["down".to_owned(), "-v".to_owned()]);
        }
        ComposeAction::Restart => args.push("restart".to_owned()),
        ComposeAction::Pull => args.push("pull".to_owned()),
    }
    let (env, env_remove) = endpoint_env(endpoint)?;
    Ok(ComposeCommand {
        program: "docker".to_owned(),
        args,
        env,
        env_remove,
    })
}

/// Whether the actions can be used, and if not, why.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ComposeAvailability {
    pub available: bool,
    /// The version of the Compose plugin, when it is installed.
    pub version: Option<String>,
    /// A message for the user when `available` is false.
    pub reason: Option<String>,
}

/// The outcome of `docker compose version --short`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PluginProbe {
    Version(String),
    /// The `docker` command does not exist.
    NoDocker,
    /// `docker` exists but has no `compose` command (or it failed).
    NoPlugin,
}

/// The Compose files of `project` that do not exist on this machine.
pub fn missing_files(project: &ComposeProject, exists: impl Fn(&str) -> bool) -> Vec<String> {
    project
        .config_files
        .iter()
        .filter(|f| !exists(f))
        .cloned()
        .collect()
}

/// Decides the availability from the probe of the plugin and the files of the project.
pub fn availability_of(
    probe: &PluginProbe,
    project: &ComposeProject,
    exists: impl Fn(&str) -> bool,
) -> ComposeAvailability {
    let unavailable = |version: Option<String>, reason: String| ComposeAvailability {
        available: false,
        version,
        reason: Some(reason),
    };
    let version = match probe {
        PluginProbe::Version(v) => v.clone(),
        PluginProbe::NoDocker => {
            return unavailable(
                None,
                "The docker command was not found. Install the Docker CLI with the Compose plugin \
                 to run Compose actions."
                    .to_owned(),
            );
        }
        PluginProbe::NoPlugin => {
            return unavailable(
                None,
                "The Docker Compose plugin is not installed (`docker compose` fails). Install it \
                 to run Compose actions."
                    .to_owned(),
            );
        }
    };
    let have = Some(version);
    if project.config_files.is_empty() || project.working_dir.as_deref().is_none_or(str::is_empty) {
        return unavailable(
            have,
            "This stack does not say where its Compose files are, so it cannot be managed from \
             here."
                .to_owned(),
        );
    }
    let missing = missing_files(project, exists);
    if !missing.is_empty() {
        return unavailable(
            have,
            format!(
                "The Compose files are not on this machine (the stack may have been started \
                 elsewhere): {}",
                missing.join(", ")
            ),
        );
    }
    ComposeAvailability {
        available: true,
        version: have,
        reason: None,
    }
}

/// Probes the Compose plugin with `docker compose version --short`.
pub async fn probe_plugin() -> PluginProbe {
    let mut command = Command::new("docker");
    command
        .args(["compose", "version", "--short"])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    match tokio::time::timeout(VERSION_TIMEOUT, command.output()).await {
        Ok(Ok(output)) if output.status.success() => {
            PluginProbe::Version(String::from_utf8_lossy(&output.stdout).trim().to_owned())
        }
        Ok(Err(e)) if e.kind() == std::io::ErrorKind::NotFound => PluginProbe::NoDocker,
        _ => PluginProbe::NoPlugin,
    }
}

/// Whether the actions can be used for `project` on this machine.
pub async fn check_compose(project: &ComposeProject) -> ComposeAvailability {
    availability_of(&probe_plugin().await, project, |f| Path::new(f).exists())
}

/// What a running action sends to the frontend.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ComposeEvent {
    /// One line of output, without its line break.
    Line { stream: LogStream, text: String },
    /// The command ended. `code` is missing when it was stopped or killed by a signal.
    Finished { success: bool, code: Option<i32> },
}

/// Runs `command`, sends its output to `emit` and ends with a `Finished` event. Stops the process
/// when `cancel` is notified. Fails when the process cannot be started.
pub async fn run_command(
    command: &ComposeCommand,
    cancel: &Notify,
    mut emit: impl FnMut(ComposeEvent) + Send,
) -> Result<()> {
    let mut process = Command::new(&command.program);
    process
        .args(&command.args)
        .envs(command.env.iter().map(|(k, v)| (k, v)))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    for name in &command.env_remove {
        process.env_remove(name);
    }
    let mut child = process.spawn().map_err(|e| Error::Compose {
        kind: ErrorKind::Engine,
        message: if e.kind() == std::io::ErrorKind::NotFound {
            "The docker command was not found.".to_owned()
        } else {
            format!("Cannot start docker: {e}")
        },
    })?;
    let mut stdout = BufReader::new(child.stdout.take().expect("piped stdout")).lines();
    let mut stderr = BufReader::new(child.stderr.take().expect("piped stderr")).lines();
    let (mut out_open, mut err_open) = (true, true);
    while out_open || err_open {
        tokio::select! {
            line = stdout.next_line(), if out_open => match line {
                Ok(Some(text)) => emit(ComposeEvent::Line { stream: LogStream::Stdout, text }),
                _ => out_open = false,
            },
            line = stderr.next_line(), if err_open => match line {
                Ok(Some(text)) => emit(ComposeEvent::Line { stream: LogStream::Stderr, text }),
                _ => err_open = false,
            },
            () = cancel.notified() => {
                let _ = child.kill().await;
                emit(ComposeEvent::Finished { success: false, code: None });
                return Ok(());
            }
        }
    }
    let status = child.wait().await.map_err(|e| Error::Compose {
        kind: ErrorKind::Engine,
        message: format!("Cannot wait for docker: {e}"),
    })?;
    emit(ComposeEvent::Finished {
        success: status.success(),
        code: status.code(),
    });
    Ok(())
}

/// Performs `action` on `project` at `endpoint` and streams the output of the CLI.
pub async fn run_compose(
    endpoint: &Endpoint,
    project: &ComposeProject,
    action: ComposeAction,
    cancel: &Notify,
    emit: impl FnMut(ComposeEvent) + Send,
) -> Result<()> {
    let command = build_command(endpoint, project, action)?;
    run_command(&command, cancel, emit).await
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;
    use crate::TlsFiles;

    fn project() -> ComposeProject {
        ComposeProject {
            name: "shop".to_owned(),
            working_dir: Some("/srv/shop".to_owned()),
            config_files: vec![
                "/srv/shop/compose.yml".to_owned(),
                "/srv/shop/o.yml".to_owned(),
            ],
        }
    }

    fn local() -> Endpoint {
        Endpoint::parse("local", "unix:///var/run/docker.sock").unwrap()
    }

    fn args(action: ComposeAction) -> Vec<String> {
        build_command(&local(), &project(), action).unwrap().args
    }

    #[test]
    fn up_runs_detached_with_project_files_and_directory() {
        assert_eq!(
            args(ComposeAction::Up),
            [
                "compose",
                "--ansi",
                "never",
                "-p",
                "shop",
                "-f",
                "/srv/shop/compose.yml",
                "-f",
                "/srv/shop/o.yml",
                "--project-directory",
                "/srv/shop",
                "up",
                "-d"
            ]
        );
    }

    #[test]
    fn down_removes_volumes_only_when_asked() {
        assert_eq!(
            args(ComposeAction::Down { volumes: false }).last().unwrap(),
            "down"
        );
        assert!(!args(ComposeAction::Down { volumes: false }).contains(&"-v".to_owned()));
        let with = args(ComposeAction::Down { volumes: true });
        assert_eq!(&with[with.len() - 2..], ["down", "-v"]);
    }

    #[test]
    fn restart_and_pull_are_plain_subcommands() {
        assert_eq!(args(ComposeAction::Restart).last().unwrap(), "restart");
        assert_eq!(args(ComposeAction::Pull).last().unwrap(), "pull");
    }

    #[test]
    fn the_endpoint_is_selected_with_docker_host() {
        let ssh = Endpoint::parse("box", "ssh://me@box").unwrap();
        let command = build_command(&ssh, &project(), ComposeAction::Up).unwrap();
        assert_eq!(command.program, "docker");
        assert_eq!(
            command.env,
            [("DOCKER_HOST".to_owned(), "ssh://me@box".to_owned())]
        );
        assert!(command.env_remove.contains(&"DOCKER_CONTEXT"));
        assert!(command.env_remove.contains(&"DOCKER_TLS_VERIFY"));
    }

    #[test]
    fn tls_endpoints_set_the_certificate_variables() {
        let mut endpoint = Endpoint::parse("tls", "tcp://host:2376").unwrap();
        endpoint.tls = Some(TlsFiles::in_dir(Path::new("/certs")));
        let command = build_command(&endpoint, &project(), ComposeAction::Up).unwrap();
        assert!(
            command
                .env
                .contains(&("DOCKER_TLS_VERIFY".to_owned(), "1".to_owned()))
        );
        assert!(
            command
                .env
                .contains(&("DOCKER_CERT_PATH".to_owned(), "/certs".to_owned()))
        );
        assert!(!command.env_remove.contains(&"DOCKER_TLS_VERIFY"));
    }

    #[test]
    fn tls_files_outside_one_directory_are_refused() {
        let mut endpoint = Endpoint::parse("tls", "tcp://host:2376").unwrap();
        endpoint.tls = Some(TlsFiles {
            ca: "/a/ca.pem".to_owned(),
            cert: "/b/cert.pem".to_owned(),
            key: "/a/key.pem".to_owned(),
        });
        let error = build_command(&endpoint, &project(), ComposeAction::Up).unwrap_err();
        assert_eq!(error.kind(), ErrorKind::InvalidInput);
    }

    #[test]
    fn a_stack_without_files_or_directory_cannot_be_built() {
        let mut no_files = project();
        no_files.config_files.clear();
        let mut no_dir = project();
        no_dir.working_dir = None;
        let mut no_name = project();
        no_name.name = " ".to_owned();
        for p in [no_files, no_dir, no_name] {
            assert!(build_command(&local(), &p, ComposeAction::Up).is_err());
        }
    }

    #[test]
    fn availability_needs_the_plugin_and_the_files() {
        let ok = PluginProbe::Version("2.29.1".to_owned());
        let all = availability_of(&ok, &project(), |_| true);
        assert!(all.available && all.reason.is_none());
        assert_eq!(all.version.as_deref(), Some("2.29.1"));

        let no_plugin = availability_of(&PluginProbe::NoPlugin, &project(), |_| true);
        assert!(!no_plugin.available);
        assert!(no_plugin.reason.unwrap().contains("Compose plugin"));

        let no_docker = availability_of(&PluginProbe::NoDocker, &project(), |_| true);
        assert!(no_docker.reason.unwrap().contains("docker command"));

        let elsewhere = availability_of(&ok, &project(), |f| f.ends_with("o.yml"));
        assert!(!elsewhere.available);
        let reason = elsewhere.reason.unwrap();
        assert!(reason.contains("/srv/shop/compose.yml") && !reason.contains("o.yml"));
        assert_eq!(elsewhere.version.as_deref(), Some("2.29.1"));

        let mut unlabeled = project();
        unlabeled.config_files.clear();
        assert!(!availability_of(&ok, &unlabeled, |_| true).available);
    }

    #[test]
    fn events_serialize_with_a_type_tag() {
        let json = serde_json::to_value(ComposeEvent::Finished {
            success: true,
            code: Some(0),
        })
        .unwrap();
        assert_eq!(json["type"], "finished");
        let action: ComposeAction =
            serde_json::from_str(r#"{"type":"down","volumes":true}"#).unwrap();
        assert_eq!(action, ComposeAction::Down { volumes: true });
    }

    fn sh(script: &str) -> ComposeCommand {
        ComposeCommand {
            program: "sh".to_owned(),
            args: vec!["-c".to_owned(), script.to_owned()],
            env: vec![("GANTRY_TEST".to_owned(), "yes".to_owned())],
            env_remove: vec!["GANTRY_REMOVED"],
        }
    }

    async fn collect(command: &ComposeCommand, cancel: &Notify) -> Vec<ComposeEvent> {
        let mut events = Vec::new();
        run_command(command, cancel, |e| events.push(e))
            .await
            .unwrap();
        events
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn output_is_streamed_and_the_exit_code_reported() {
        let events = collect(
            &sh("echo out; echo err >&2; echo \"$GANTRY_TEST\"; exit 3"),
            &Notify::new(),
        )
        .await;
        let line = |stream, text: &str| ComposeEvent::Line {
            stream,
            text: text.to_owned(),
        };
        assert!(events.contains(&line(LogStream::Stdout, "out")));
        assert!(events.contains(&line(LogStream::Stderr, "err")));
        assert!(events.contains(&line(LogStream::Stdout, "yes")));
        assert_eq!(
            events.last(),
            Some(&ComposeEvent::Finished {
                success: false,
                code: Some(3)
            })
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_cancelled_run_is_killed() {
        let cancel = Arc::new(Notify::new());
        let stopper = Arc::clone(&cancel);
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(100)).await;
            stopper.notify_one();
        });
        let events =
            tokio::time::timeout(Duration::from_secs(10), collect(&sh("sleep 30"), &cancel))
                .await
                .expect("cancel ends the run");
        assert_eq!(
            events,
            [ComposeEvent::Finished {
                success: false,
                code: None
            }]
        );
    }

    #[tokio::test]
    async fn a_missing_program_is_an_error() {
        let command = ComposeCommand {
            program: "gantry-no-such-program".to_owned(),
            args: vec![],
            env: vec![],
            env_remove: vec![],
        };
        let error = run_command(&command, &Notify::new(), |_| {})
            .await
            .unwrap_err();
        assert!(error.to_string().contains("not found"), "{error}");
    }
}
