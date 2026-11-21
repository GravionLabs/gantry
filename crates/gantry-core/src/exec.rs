//! Interactive exec: `docker exec -it` as a stream of output plus input and resize controls.

use std::collections::HashMap;
use std::future::Future;
use std::sync::{Arc, Mutex};

use bollard::Docker;
use bollard::container::LogOutput;
use bollard::exec::{StartExecOptions, StartExecResults};
use bollard::models::ExecConfig;
use bollard::query_parameters::ResizeExecOptionsBuilder;
use futures_util::{Stream, StreamExt};
use serde::{Deserialize, Serialize};
use specta::Type;
use tokio::io::{AsyncWrite, AsyncWriteExt};
use tokio::sync::{Notify, mpsc};

use crate::{Error, Result};

/// What an exec session is started with.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ExecOptions {
    /// The program and its arguments, for example `["/bin/sh"]`.
    pub command: Vec<String>,
    /// The user to run as (`name`, `uid` or `uid:gid`); the container's user when unset.
    pub user: Option<String>,
    /// Initial size of the terminal in columns.
    pub cols: u16,
    /// Initial size of the terminal in rows.
    pub rows: u16,
}

impl ExecOptions {
    fn validate(&self) -> Result<()> {
        if self.command.first().is_none_or(|c| c.trim().is_empty()) {
            return Err(Error::InvalidInput("the command is empty".to_owned()));
        }
        if self.user.as_deref().is_some_and(|u| u.trim().is_empty()) {
            return Err(Error::InvalidInput("the user is empty".to_owned()));
        }
        Ok(())
    }

    fn config(&self) -> ExecConfig {
        ExecConfig {
            attach_stdin: Some(true),
            attach_stdout: Some(true),
            attach_stderr: Some(true),
            tty: Some(true),
            env: Some(vec!["TERM=xterm-256color".to_owned()]),
            cmd: Some(self.command.clone()),
            user: self.user.as_ref().map(|u| u.trim().to_owned()),
            console_size: Some(vec![usize::from(self.rows), usize::from(self.cols)]),
            ..Default::default()
        }
    }
}

/// What an exec session sends to the frontend.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ExecEvent {
    /// Terminal output, to be written to the emulator as it is.
    Output { text: String },
    /// The process ended; `code` is its exit code when the engine reports one.
    Exit { code: Option<i32> },
}

/// A request to a running session.
#[derive(Debug, PartialEq, Eq)]
enum Control {
    Input(Vec<u8>),
    Resize { cols: u16, rows: u16 },
}

struct Session {
    controls: mpsc::UnboundedSender<Control>,
    inbox: Option<mpsc::UnboundedReceiver<Control>>,
    cancel: Arc<Notify>,
}

/// The running exec sessions by id. The frontend picks the id; closing an id that has not started
/// yet is remembered, so a tab that is closed right after it was opened never runs a process.
#[derive(Default)]
pub struct ExecSessions {
    sessions: Mutex<HashMap<String, Session>>,
}

impl ExecSessions {
    fn open(&self, id: &str) -> (mpsc::UnboundedReceiver<Control>, Arc<Notify>) {
        let mut sessions = self.sessions.lock().expect("exec sessions lock");
        let session = sessions.entry(id.to_owned()).or_insert_with(|| {
            let (controls, inbox) = mpsc::unbounded_channel();
            Session {
                controls,
                inbox: Some(inbox),
                cancel: Arc::default(),
            }
        });
        let inbox = session.inbox.take().unwrap_or_else(|| {
            // Opened twice: the second session gets a dead inbox instead of stealing the first.
            mpsc::unbounded_channel().1
        });
        (inbox, Arc::clone(&session.cancel))
    }

    /// Sends keyboard input to session `id`. Input for an unknown session is dropped.
    pub fn write(&self, id: &str, data: &str) {
        self.send(id, Control::Input(data.as_bytes().to_vec()));
    }

    /// Resizes the terminal of session `id`.
    pub fn resize(&self, id: &str, cols: u16, rows: u16) {
        if cols > 0 && rows > 0 {
            self.send(id, Control::Resize { cols, rows });
        }
    }

    fn send(&self, id: &str, control: Control) {
        if let Some(session) = self.sessions.lock().expect("exec sessions lock").get(id) {
            let _ = session.controls.send(control);
        }
    }

    /// Ends session `id`. Its connection closes, which hangs up the terminal of the process.
    pub fn close(&self, id: &str) {
        let (_, cancel) = self.open(id);
        cancel.notify_one();
    }

    /// Forgets session `id`; call it when the session ended.
    pub fn finish(&self, id: &str) {
        self.sessions.lock().expect("exec sessions lock").remove(id);
    }
}

/// Splits bytes into text without cutting a multi-byte character in two.
#[derive(Default)]
struct Utf8Chunks {
    pending: Vec<u8>,
}

impl Utf8Chunks {
    fn push(&mut self, bytes: &[u8]) -> String {
        self.pending.extend_from_slice(bytes);
        let mut text = String::new();
        let mut rest = self.pending.as_slice();
        loop {
            match std::str::from_utf8(rest) {
                Ok(valid) => {
                    text.push_str(valid);
                    rest = &[];
                    break;
                }
                Err(error) => {
                    let (valid, after) = rest.split_at(error.valid_up_to());
                    text.push_str(std::str::from_utf8(valid).expect("validated prefix"));
                    match error.error_len() {
                        Some(len) => {
                            text.push('\u{FFFD}');
                            rest = &after[len..];
                        }
                        // An incomplete character at the end: wait for the next chunk.
                        None => {
                            rest = after;
                            break;
                        }
                    }
                }
            }
        }
        self.pending = rest.to_vec();
        text
    }

    fn finish(&mut self) -> String {
        if std::mem::take(&mut self.pending).is_empty() {
            String::new()
        } else {
            "\u{FFFD}".to_owned()
        }
    }
}

/// Runs the session until the process ends or `cancel` is notified. Returns whether the process
/// ended by itself.
async fn pump<F, Fut>(
    output: impl Stream<Item = std::result::Result<LogOutput, bollard::errors::Error>>,
    input: impl AsyncWrite,
    mut controls: mpsc::UnboundedReceiver<Control>,
    cancel: &Notify,
    resize: F,
    mut emit: impl FnMut(ExecEvent) + Send,
) -> Result<bool>
where
    F: Fn(u16, u16) -> Fut,
    Fut: Future<Output = ()>,
{
    let mut output = std::pin::pin!(output);
    let mut input = std::pin::pin!(input);
    let mut text = Utf8Chunks::default();
    let mut writable = true;
    let ended = loop {
        tokio::select! {
            () = cancel.notified() => break false,
            chunk = output.next() => match chunk {
                None => break true,
                Some(Err(error)) => return Err(error.into()),
                Some(Ok(chunk)) => {
                    let text = text.push(chunk.as_ref());
                    if !text.is_empty() {
                        emit(ExecEvent::Output { text });
                    }
                }
            },
            control = controls.recv() => match control {
                None => break false,
                // A failed write means the process closed its input; the output still drains.
                Some(Control::Input(bytes)) if writable => {
                    writable = input.write_all(&bytes).await.is_ok() && input.flush().await.is_ok();
                }
                Some(Control::Input(_)) => {}
                Some(Control::Resize { cols, rows }) => resize(cols, rows).await,
            },
        }
    };
    let rest = text.finish();
    if !rest.is_empty() {
        emit(ExecEvent::Output { text: rest });
    }
    Ok(ended)
}

/// Starts `options.command` in container `id` with a terminal and forwards its output to `emit`
/// until it ends or session `session_id` is closed. Input and resizes arrive through
/// [`ExecSessions::write`] and [`ExecSessions::resize`]. The final event is `Exit` when the
/// process ended by itself.
pub async fn run_exec(
    docker: &Docker,
    sessions: &ExecSessions,
    session_id: &str,
    id: &str,
    options: &ExecOptions,
    emit: impl FnMut(ExecEvent) + Send,
) -> Result<()> {
    let result = run(docker, sessions, session_id, id, options, emit).await;
    sessions.finish(session_id);
    result
}

async fn run(
    docker: &Docker,
    sessions: &ExecSessions,
    session_id: &str,
    id: &str,
    options: &ExecOptions,
    mut emit: impl FnMut(ExecEvent) + Send,
) -> Result<()> {
    options.validate()?;
    let (controls, cancel) = sessions.open(session_id);
    let created = tokio::select! {
        () = cancel.notified() => return Ok(()),
        created = docker.create_exec(id, options.config()) => created?,
    };
    let started = docker
        .start_exec(
            &created.id,
            Some(StartExecOptions {
                detach: false,
                tty: true,
                output_capacity: None,
            }),
        )
        .await?;
    let StartExecResults::Attached { output, input } = started else {
        return Err(Error::InvalidInput("the exec did not attach".to_owned()));
    };
    let exec_id = created.id;
    let resize = |cols: u16, rows: u16| {
        let exec_id = exec_id.clone();
        async move {
            let options = ResizeExecOptionsBuilder::new()
                .w(i32::from(cols))
                .h(i32::from(rows))
                .build();
            let _ = docker.resize_exec(&exec_id, options).await;
        }
    };
    let ended = pump(output, input, controls, &cancel, resize, &mut emit).await?;
    if ended {
        let code = docker
            .inspect_exec(&exec_id)
            .await
            .ok()
            .and_then(|inspect| inspect.exit_code)
            .and_then(|code| i32::try_from(code).ok());
        emit(ExecEvent::Exit { code });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use bollard::container::LogOutput;
    use futures_util::stream;
    use tokio::io::AsyncReadExt;

    use super::*;

    type Chunk = std::result::Result<LogOutput, bollard::errors::Error>;

    fn out(bytes: &[u8]) -> Chunk {
        Ok(LogOutput::Console {
            message: bytes.to_vec().into(),
        })
    }

    fn options(command: &[&str], user: Option<&str>) -> ExecOptions {
        ExecOptions {
            command: command.iter().map(|c| (*c).to_owned()).collect(),
            user: user.map(str::to_owned),
            cols: 80,
            rows: 24,
        }
    }

    #[test]
    fn utf8_chunks_join_a_character_cut_in_two() {
        let mut chunks = Utf8Chunks::default();
        let euro = "€".as_bytes();
        assert_eq!(chunks.push(&euro[..2]), "");
        assert_eq!(chunks.push(&euro[2..]), "€");
        assert_eq!(chunks.finish(), "");
    }

    #[test]
    fn utf8_chunks_replace_invalid_bytes_and_a_dangling_start() {
        let mut chunks = Utf8Chunks::default();
        assert_eq!(chunks.push(b"a\xFFb\xE2\x82"), "a\u{FFFD}b");
        assert_eq!(chunks.finish(), "\u{FFFD}");
    }

    #[test]
    fn options_are_validated() {
        assert!(options(&["/bin/sh"], None).validate().is_ok());
        assert!(options(&[], None).validate().is_err());
        assert!(options(&[" "], None).validate().is_err());
        assert!(options(&["sh"], Some(" ")).validate().is_err());
        let err = options(&[], None).validate().unwrap_err();
        assert_eq!(err.kind(), crate::ErrorKind::InvalidInput);
    }

    #[test]
    fn config_attaches_a_terminal_of_the_requested_size() {
        let config = options(&["/bin/bash", "-l"], Some("root")).config();
        assert_eq!(config.tty, Some(true));
        assert_eq!(config.attach_stdin, Some(true));
        assert_eq!(config.cmd, Some(vec!["/bin/bash".into(), "-l".into()]));
        assert_eq!(config.user.as_deref(), Some("root"));
        assert_eq!(config.console_size, Some(vec![24, 80]));
        assert!(
            config
                .env
                .unwrap()
                .contains(&"TERM=xterm-256color".to_owned())
        );
    }

    #[test]
    fn events_serialize_with_a_type_tag() {
        let json = serde_json::to_value(ExecEvent::Exit { code: Some(3) }).unwrap();
        assert_eq!(json["type"], "exit");
        assert_eq!(json["code"], 3);
        let json = serde_json::to_value(ExecEvent::Output { text: "x".into() }).unwrap();
        assert_eq!(json["type"], "output");
    }

    #[tokio::test]
    async fn forwards_output_input_and_resizes() {
        let sessions = ExecSessions::default();
        let (inbox, cancel) = sessions.open("s");
        sessions.write("s", "ls\n");
        sessions.resize("s", 100, 30);
        sessions.resize("s", 0, 30);
        let (writer, mut reader) = tokio::io::duplex(64);
        let resized = Mutex::new(Vec::new());
        let mut events = Vec::new();
        let driver = async {
            // Input is written after the resize was handled or before it; both are queued.
            let mut written = [0u8; 3];
            reader.read_exact(&mut written).await.unwrap();
            while resized.lock().unwrap().is_empty() {
                tokio::task::yield_now().await;
            }
            sessions.close("s");
            written
        };
        let (ended, written) = tokio::join!(
            pump(
                stream::iter(vec![out(b"$ "), out("ü".as_bytes())]).chain(stream::pending()),
                writer,
                inbox,
                &cancel,
                |cols, rows| {
                    resized.lock().unwrap().push((cols, rows));
                    async {}
                },
                |event| events.push(event),
            ),
            driver
        );
        assert!(!ended.unwrap());
        assert_eq!(*resized.lock().unwrap(), vec![(100, 30)]);
        assert_eq!(&written, b"ls\n");
        let text: String = events
            .iter()
            .map(|e| match e {
                ExecEvent::Output { text } => text.as_str(),
                ExecEvent::Exit { .. } => "",
            })
            .collect();
        assert_eq!(text, "$ ü");
    }

    #[tokio::test]
    async fn close_ends_an_open_session_and_works_before_it_starts() {
        let sessions = ExecSessions::default();
        sessions.close("early");
        let (inbox, cancel) = sessions.open("early");
        let (writer, _reader) = tokio::io::duplex(8);
        let ended = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            pump(
                stream::pending::<Chunk>(),
                writer,
                inbox,
                &cancel,
                |_, _| async {},
                |_| {},
            ),
        )
        .await
        .expect("a closed session ends")
        .unwrap();
        assert!(!ended);
        sessions.finish("early");
        assert!(sessions.sessions.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_failed_stream_is_an_error_and_input_after_it_is_ignored() {
        let sessions = ExecSessions::default();
        let (inbox, cancel) = sessions.open("s");
        let (writer, reader) = tokio::io::duplex(8);
        drop(reader);
        sessions.write("s", "x");
        let failing: Chunk = Err(bollard::errors::Error::RequestTimeoutError);
        let result = pump(
            stream::iter(vec![failing]),
            writer,
            inbox,
            &cancel,
            |_, _| async {},
            |_| {},
        )
        .await;
        assert!(result.is_err());
        sessions.write("gone", "ignored");
    }
}
