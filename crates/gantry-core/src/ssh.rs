//! SSH transport: the Docker Engine API over `ssh <host> docker system dial-stdio`.
//!
//! The system `ssh` does the work (config, aliases, keys, jump hosts, agent), so Gantry stores no
//! secrets. `BatchMode=yes` keeps `ssh` from ever prompting, so an unknown host key or a failed
//! login ends with an error instead of a hung process. See ADR 0003.

use std::io;
use std::pin::Pin;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};
use std::time::Duration;

use bollard::errors::Error as BollardError;
use bollard::{API_DEFAULT_VERSION, BollardRequest, Docker};
use hyper::Uri;
use hyper_util::client::legacy::Client;
use hyper_util::client::legacy::connect::{Connected, Connection};
use hyper_util::rt::{TokioExecutor, TokioIo};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, BufReader, ReadBuf};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};

use crate::error::SshFailure;
use crate::{Error, ErrorKind, Result};

const CONNECT_TIMEOUT_SECS: u32 = 10;
/// How long to wait for `ssh` to finish writing its error message after a failed request.
const STDERR_GRACE: Duration = Duration::from_secs(2);
const MAX_STDERR_BYTES: usize = 4096;

/// The parts of an `ssh://[user@]host[:port]` address.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SshTarget {
    pub user: Option<String>,
    pub host: String,
    pub port: Option<u16>,
}

impl SshTarget {
    /// Parses `ssh://[user@]host[:port]`; `host` may be an alias from `~/.ssh/config` or `[ipv6]`.
    pub fn parse(address: &str) -> Result<Self> {
        let invalid = || Error::InvalidAddress(address.to_owned());
        let rest = address.strip_prefix("ssh://").ok_or_else(invalid)?;
        let authority = rest.strip_suffix('/').unwrap_or(rest);
        if authority.is_empty() || authority.contains(['/', '?', '#', ' ']) {
            return Err(invalid());
        }
        let (user, hostport) = match authority.rsplit_once('@') {
            Some((user, hostport)) => (Some(user), hostport),
            None => (None, authority),
        };
        let (host, port) = if let Some(bracketed) = hostport.strip_prefix('[') {
            let (host, after) = bracketed.split_once(']').ok_or_else(invalid)?;
            match after {
                "" => (host, None),
                _ => (host, Some(after.strip_prefix(':').ok_or_else(invalid)?)),
            }
        } else {
            match hostport.split_once(':') {
                Some((host, port)) => (host, Some(port)),
                None => (hostport, None),
            }
        };
        let port = port
            .map(|port| port.parse::<u16>().map_err(|_| invalid()))
            .transpose()?;
        // A leading dash would be read by ssh as an option.
        if host.is_empty()
            || host.starts_with('-')
            || user.is_some_and(|u| u.is_empty() || u.starts_with('-'))
        {
            return Err(invalid());
        }
        Ok(Self {
            user: user.map(str::to_owned),
            host: host.to_owned(),
            port,
        })
    }

    /// The arguments for `ssh`.
    pub fn args(&self) -> Vec<String> {
        let mut args = vec![
            "-o".into(),
            "BatchMode=yes".into(),
            "-o".into(),
            format!("ConnectTimeout={CONNECT_TIMEOUT_SECS}"),
            "-o".into(),
            "ClearAllForwardings=yes".into(),
            "-T".into(),
        ];
        if let Some(user) = &self.user {
            args.extend(["-l".into(), user.clone()]);
        }
        if let Some(port) = self.port {
            args.extend(["-p".into(), port.to_string()]);
        }
        args.extend(["--".into(), self.host.clone()]);
        args.extend(["docker", "system", "dial-stdio"].map(String::from));
        args
    }
}

/// Maps the error output of `ssh` (or the remote shell) to an error the UI can act on.
pub(crate) fn classify_stderr(stderr: &str) -> SshFailure {
    let text = stderr.trim();
    let lower = text.to_lowercase();
    let (kind, hint) = if lower.contains("host key verification failed")
        || lower.contains("remote host identification has changed")
    {
        (
            ErrorKind::HostKey,
            "the host key is unknown or has changed; connect once with `ssh` in a terminal to verify and trust it",
        )
    } else if lower.contains("permission denied")
        || lower.contains("too many authentication failures")
    {
        (
            ErrorKind::Authentication,
            "authentication failed; check the key or agent for this host in ~/.ssh/config",
        )
    } else if lower.contains("could not resolve hostname")
        || lower.contains("connection refused")
        || lower.contains("timed out")
        || lower.contains("no route to host")
        || lower.contains("network is unreachable")
        || lower.contains("connection closed")
        || lower.contains("connection reset")
    {
        (
            ErrorKind::Unreachable,
            "the host cannot be reached over SSH",
        )
    } else if lower.contains("command not found")
        || lower.contains("not recognized")
        || lower.contains("unknown command")
        || lower.contains("is not a docker command")
    {
        (
            ErrorKind::Engine,
            "the remote host needs a Docker CLI that supports `docker system dial-stdio`",
        )
    } else {
        (ErrorKind::Engine, "the SSH connection failed")
    };
    let message = if text.is_empty() {
        hint.to_owned()
    } else {
        format!("{hint}: {text}")
    };
    SshFailure { kind, message }
}

/// The stdin and stdout of a running `ssh` as one duplex stream. The child is killed on drop.
struct SshStream {
    _child: Child,
    stdin: ChildStdin,
    stdout: ChildStdout,
}

impl AsyncRead for SshStream {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        Pin::new(&mut self.stdout).poll_read(cx, buf)
    }
}

impl AsyncWrite for SshStream {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.stdin).poll_write(cx, buf)
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.stdin).poll_flush(cx)
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.stdin).poll_shutdown(cx)
    }
}

/// [`SshStream`] for hyper.
struct SshIo(TokioIo<SshStream>);

impl hyper::rt::Read for SshIo {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: hyper::rt::ReadBufCursor<'_>,
    ) -> Poll<io::Result<()>> {
        Pin::new(&mut self.0).poll_read(cx, buf)
    }
}

impl hyper::rt::Write for SshIo {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.0).poll_write(cx, buf)
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.0).poll_flush(cx)
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.0).poll_shutdown(cx)
    }
}

impl Connection for SshIo {
    fn connected(&self) -> Connected {
        Connected::new()
    }
}

/// The error output of the latest `ssh` process, delivered once the process closed its stderr.
type StderrReceiver = tokio::sync::watch::Receiver<Option<String>>;

#[derive(Clone)]
struct SshConnector {
    args: Arc<Vec<String>>,
    program: Arc<String>,
    latest: Arc<Mutex<Option<StderrReceiver>>>,
}

impl SshConnector {
    fn spawn(&self) -> io::Result<SshIo> {
        let mut command = Command::new(self.program.as_str());
        command
            .args(self.args.iter())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        #[cfg(windows)]
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        let mut child = command.spawn().map_err(|error| {
            if error.kind() == io::ErrorKind::NotFound {
                io::Error::new(
                    io::ErrorKind::NotFound,
                    "the `ssh` client was not found; install OpenSSH and make sure it is on the PATH",
                )
            } else {
                error
            }
        })?;
        let piped = |what| io::Error::other(format!("ssh {what} is not piped"));
        let stdin = child.stdin.take().ok_or_else(|| piped("stdin"))?;
        let stdout = child.stdout.take().ok_or_else(|| piped("stdout"))?;
        let stderr = child.stderr.take().ok_or_else(|| piped("stderr"))?;

        let (sender, receiver) = tokio::sync::watch::channel(None);
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            let mut text = String::new();
            while let Ok(Some(line)) = lines.next_line().await {
                if text.len() < MAX_STDERR_BYTES {
                    text.push_str(&line);
                    text.push('\n');
                }
            }
            let _ = sender.send(Some(text));
        });
        *self.latest.lock().expect("stderr lock") = Some(receiver);
        Ok(SshIo(TokioIo::new(SshStream {
            _child: child,
            stdin,
            stdout,
        })))
    }
}

impl tower_service::Service<Uri> for SshConnector {
    type Response = SshIo;
    type Error = io::Error;
    type Future = std::future::Ready<io::Result<SshIo>>;

    fn poll_ready(&mut self, _: &mut Context<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }

    fn call(&mut self, _: Uri) -> Self::Future {
        std::future::ready(self.spawn())
    }
}

/// Builds a client whose connections are `ssh` processes. The body type is inferred from use.
fn build_client<B>(connector: SshConnector) -> Client<SshConnector, B>
where
    B: hyper::body::Body + Send + 'static + Unpin,
    B::Data: Send,
    B::Error: Into<Box<dyn std::error::Error + Send + Sync>>,
{
    Client::builder(TokioExecutor::new())
        // One idle connection is kept: one `ssh` process serves the endpoint while it is active.
        .pool_max_idle_per_host(1)
        .build(connector)
}

/// Opens a client for an `ssh://` address. Connecting is lazy: `ssh` starts on the first request
/// and stays up (pooled) until the returned [`Docker`] and all its clones are dropped.
pub(crate) fn connect(address: &str, timeout_secs: u64) -> Result<Docker> {
    connect_with_program(address, "ssh", timeout_secs)
}

pub(crate) fn connect_with_program(
    address: &str,
    program: &str,
    timeout_secs: u64,
) -> Result<Docker> {
    let target = SshTarget::parse(address)?;
    let connector = SshConnector {
        args: Arc::new(target.args()),
        program: Arc::new(program.to_owned()),
        latest: Arc::default(),
    };
    let latest = Arc::clone(&connector.latest);
    let client = Arc::new(build_client(connector));

    let transport = move |request: BollardRequest| {
        let client = Arc::clone(&client);
        let latest = Arc::clone(&latest);
        async move {
            match client.request(request).await {
                Ok(response) => Ok(response),
                Err(error) => Err(explain(error, &latest).await),
            }
        }
    };
    Ok(Docker::connect_with_custom_transport(
        transport,
        Some("http://docker"),
        timeout_secs,
        API_DEFAULT_VERSION,
    )?)
}

/// Replaces a bare transport error with what `ssh` said, when it said something.
async fn explain(
    error: hyper_util::client::legacy::Error,
    latest: &Mutex<Option<StderrReceiver>>,
) -> BollardError {
    let receiver = latest.lock().expect("stderr lock").clone();
    if let Some(mut receiver) = receiver {
        let done = tokio::time::timeout(STDERR_GRACE, receiver.wait_for(Option::is_some)).await;
        if let Ok(Ok(text)) = done {
            let stderr = text.clone().unwrap_or_default();
            if !stderr.trim().is_empty() || error.is_connect() {
                return BollardError::IOError {
                    err: io::Error::other(classify_stderr(&stderr)),
                };
            }
        }
    }
    if error.is_connect() {
        // `ssh` could not even start.
        let reason = std::error::Error::source(&error)
            .map_or_else(|| error.to_string(), ToString::to_string);
        return BollardError::IOError {
            err: io::Error::other(SshFailure {
                kind: ErrorKind::Unreachable,
                message: reason,
            }),
        };
    }
    BollardError::from(error)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(address: &str) -> SshTarget {
        SshTarget::parse(address).unwrap()
    }

    #[test]
    fn parses_user_host_and_port() {
        assert_eq!(
            parse("ssh://deploy@build-01:2222"),
            SshTarget {
                user: Some("deploy".into()),
                host: "build-01".into(),
                port: Some(2222)
            }
        );
        assert_eq!(parse("ssh://alias").user, None);
        assert_eq!(parse("ssh://alias/").host, "alias");
        let v6 = parse("ssh://me@[::1]:22");
        assert_eq!((v6.host.as_str(), v6.port), ("::1", Some(22)));
        assert_eq!(parse("ssh://[fe80::1]").port, None);
    }

    #[test]
    fn rejects_malformed_addresses() {
        for address in [
            "ssh://",
            "ssh://@host",
            "ssh://host:notaport",
            "ssh://host:70000",
            "ssh://-oProxyCommand=x",
            "ssh://-l@host",
            "ssh://host/path",
            "ssh://[::1",
            "tcp://host",
        ] {
            assert!(
                matches!(SshTarget::parse(address), Err(Error::InvalidAddress(_))),
                "{address}"
            );
        }
    }

    #[test]
    fn args_never_prompt_and_end_with_the_remote_command() {
        let args = parse("ssh://deploy@build:2222").args();
        assert!(args.windows(2).any(|w| w == ["-o", "BatchMode=yes"]));
        assert!(args.windows(2).any(|w| w == ["-l", "deploy"]));
        assert!(args.windows(2).any(|w| w == ["-p", "2222"]));
        let tail: Vec<_> = args
            .iter()
            .rev()
            .take(5)
            .rev()
            .map(String::as_str)
            .collect();
        assert_eq!(tail, ["--", "build", "docker", "system", "dial-stdio"]);
    }

    #[test]
    fn classifies_ssh_errors() {
        let cases = [
            ("Host key verification failed.", ErrorKind::HostKey),
            (
                "@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@",
                ErrorKind::HostKey,
            ),
            (
                "me@h: Permission denied (publickey,password).",
                ErrorKind::Authentication,
            ),
            (
                "ssh: Could not resolve hostname nope: Name or service not known",
                ErrorKind::Unreachable,
            ),
            (
                "ssh: connect to host h port 22: Connection refused",
                ErrorKind::Unreachable,
            ),
            ("bash: docker: command not found", ErrorKind::Engine),
            ("", ErrorKind::Engine),
        ];
        for (stderr, kind) in cases {
            assert_eq!(classify_stderr(stderr).kind, kind, "{stderr}");
        }
        assert!(
            classify_stderr("Host key verification failed.")
                .message
                .contains("`ssh` in a terminal")
        );
    }

    #[tokio::test]
    async fn missing_ssh_client_is_reported() {
        let docker = connect_with_program("ssh://host", "gantry-no-such-ssh-binary", 5).unwrap();
        let error: Error = docker.version().await.unwrap_err().into();
        assert_eq!(error.kind(), ErrorKind::Unreachable);
        assert!(error.to_string().contains("OpenSSH"), "{error}");
    }

    /// A stand-in `ssh` that fails like the real one with an unknown host key.
    #[cfg(unix)]
    #[tokio::test]
    async fn failed_login_surfaces_the_ssh_message() {
        let dir = std::env::temp_dir().join(format!("gantry-fake-ssh-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let script = dir.join("ssh");
        std::fs::write(
            &script,
            "#!/bin/sh\necho 'Host key verification failed.' >&2\nexit 255\n",
        )
        .unwrap();
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let docker = connect_with_program("ssh://host", script.to_str().unwrap(), 10).unwrap();
        let error: Error = docker.version().await.unwrap_err().into();
        std::fs::remove_dir_all(&dir).ok();
        assert_eq!(error.kind(), ErrorKind::HostKey, "{error}");
        assert!(error.to_string().contains("Host key verification failed"));
    }

    /// A stand-in `ssh` that answers HTTP requests on stdio like `docker system dial-stdio`, and
    /// records every start in a file, so the test can tell that one process served both requests.
    #[cfg(unix)]
    #[tokio::test]
    async fn serves_requests_over_stdio_and_reuses_the_process() {
        let dir = std::env::temp_dir().join(format!("gantry-fake-engine-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let starts = dir.join("starts");
        let script = dir.join("ssh");
        let body = r#"{"Version":"27.0.0","ApiVersion":"1.46"}"#;
        std::fs::write(
            &script,
            format!(
                "#!/usr/bin/env python3\nimport sys\nopen({starts:?}, 'a').write('x')\n\
                 while True:\n  line = sys.stdin.buffer.readline()\n  if not line: break\n\
                 \x20 if line in (b'\\r\\n', b'\\n'):\n    sys.stdout.buffer.write(b'HTTP/1.1 200 OK\\r\\nContent-Type: application/json\\r\\nContent-Length: {len}\\r\\n\\r\\n{body}')\n    sys.stdout.buffer.flush()\n",
                starts = starts.to_str().unwrap(),
                len = body.len(),
                body = body,
            ),
        )
        .unwrap();
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let docker = connect_with_program("ssh://host", script.to_str().unwrap(), 10).unwrap();
        for _ in 0..2 {
            let version = docker.version().await.unwrap();
            assert_eq!(version.version.as_deref(), Some("27.0.0"));
        }
        let started = std::fs::read_to_string(&starts).unwrap();
        drop(docker);
        std::fs::remove_dir_all(&dir).ok();
        assert_eq!(started, "x", "the ssh process is reused");
    }

    /// Needs the ssh client, a reachable sshd with Docker and a key for it in the agent:
    /// `GANTRY_TEST_SSH=ssh://user@host cargo test -p gantry-core -- --ignored ssh_roundtrip`.
    #[tokio::test]
    #[ignore = "needs an sshd with a Docker CLI (set GANTRY_TEST_SSH)"]
    async fn ssh_roundtrip() {
        let address = std::env::var("GANTRY_TEST_SSH").expect("GANTRY_TEST_SSH");
        let docker = connect(&address, 20).unwrap();
        let version = docker.version().await.unwrap();
        assert!(version.version.is_some());
        // The pooled connection serves the next request too.
        docker.ping().await.unwrap();
    }
}
