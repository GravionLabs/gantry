//! Container logs: `docker logs [-f]` as a stream of line batches.

use std::time::Duration;

use bollard::Docker;
use bollard::container::LogOutput;
use bollard::query_parameters::LogsOptionsBuilder;
use futures_util::{Stream, StreamExt};
use serde::{Deserialize, Serialize};
use specta::Type;
use tokio::sync::Notify;

use crate::Result;

/// Which options `docker logs` is started with.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LogOptions {
    /// Keep the stream open and send new lines as they are written.
    pub follow: bool,
    /// Only the last lines; all lines when unset.
    pub tail: Option<u32>,
    /// Only lines since this time, in seconds since the Unix epoch.
    pub since: Option<i32>,
    /// Prefix every line with its RFC 3339 timestamp.
    pub timestamps: bool,
}

/// The output stream a line was written to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum LogStream {
    Stdout,
    Stderr,
}

/// One line of output, without its line break.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LogLine {
    pub stream: LogStream,
    pub text: String,
}

/// What a log stream sends to the frontend.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum LogEvent {
    /// Lines in the order they were written. Lines are batched to keep the IPC cheap.
    Lines { lines: Vec<LogLine> },
}

/// Timing and size of the batches.
#[derive(Debug, Clone, Copy)]
pub struct LogBatching {
    /// Lines are sent after at most this wait.
    pub max_wait: Duration,
    /// Lines are sent at once when this many are waiting.
    pub max_lines: usize,
}

impl Default for LogBatching {
    fn default() -> Self {
        Self {
            max_wait: Duration::from_millis(50),
            max_lines: 500,
        }
    }
}

/// Cuts a byte stream into lines; a line may span several chunks.
#[derive(Default)]
struct LineSplitter {
    partial: Vec<u8>,
}

impl LineSplitter {
    fn push(&mut self, chunk: &[u8], mut line: impl FnMut(String)) {
        for part in chunk.split_inclusive(|b| *b == b'\n') {
            self.partial.extend_from_slice(part);
            if self.partial.last() == Some(&b'\n') {
                self.partial.pop();
                if self.partial.last() == Some(&b'\r') {
                    self.partial.pop();
                }
                line(String::from_utf8_lossy(&self.partial).into_owned());
                self.partial.clear();
            }
        }
    }

    /// The last line when the stream ended without a line break.
    fn finish(&mut self) -> Option<String> {
        if self.partial.is_empty() {
            return None;
        }
        let text = String::from_utf8_lossy(&self.partial).into_owned();
        self.partial.clear();
        Some(text)
    }
}

/// Streams the logs of container `id` to `emit` until the logs end (not following) or `cancel`
/// is notified. A container that does not exist fails with `ErrorKind::NotFound`.
pub async fn stream_logs(
    docker: &Docker,
    id: &str,
    options: &LogOptions,
    cancel: &Notify,
    emit: impl FnMut(LogEvent) + Send,
) -> Result<()> {
    let mut builder = LogsOptionsBuilder::default()
        .follow(options.follow)
        .stdout(true)
        .stderr(true)
        .timestamps(options.timestamps);
    if let Some(tail) = options.tail {
        builder = builder.tail(&tail.to_string());
    }
    if let Some(since) = options.since {
        builder = builder.since(since);
    }
    let logs = docker.logs(id, Some(builder.build()));
    forward_logs(logs, cancel, LogBatching::default(), emit).await
}

/// Splits the chunks of `logs` into lines and sends them in batches.
async fn forward_logs(
    logs: impl Stream<Item = std::result::Result<LogOutput, bollard::errors::Error>>,
    cancel: &Notify,
    batching: LogBatching,
    mut emit: impl FnMut(LogEvent) + Send,
) -> Result<()> {
    let mut logs = std::pin::pin!(logs);
    let mut stdout = LineSplitter::default();
    let mut stderr = LineSplitter::default();
    let mut pending: Vec<LogLine> = Vec::new();
    let mut flush = |pending: &mut Vec<LogLine>| {
        if !pending.is_empty() {
            emit(LogEvent::Lines {
                lines: std::mem::take(pending),
            });
        }
    };
    loop {
        let next = tokio::select! {
            () = cancel.notified() => return Ok(()),
            next = async {
                if pending.is_empty() {
                    Some(logs.next().await)
                } else {
                    tokio::time::timeout(batching.max_wait, logs.next()).await.ok()
                }
            } => next,
        };
        let Some(next) = next else {
            flush(&mut pending);
            continue;
        };
        match next {
            None => break,
            Some(Err(error)) => {
                flush(&mut pending);
                return Err(error.into());
            }
            Some(Ok(output)) => {
                let (splitter, stream) = match &output {
                    LogOutput::StdErr { .. } => (&mut stderr, LogStream::Stderr),
                    _ => (&mut stdout, LogStream::Stdout),
                };
                splitter.push(output.as_ref(), |text| {
                    pending.push(LogLine { stream, text });
                });
                if pending.len() >= batching.max_lines {
                    flush(&mut pending);
                }
            }
        }
    }
    for (splitter, stream) in [
        (&mut stdout, LogStream::Stdout),
        (&mut stderr, LogStream::Stderr),
    ] {
        if let Some(text) = splitter.finish() {
            pending.push(LogLine { stream, text });
        }
    }
    flush(&mut pending);
    Ok(())
}

#[cfg(test)]
mod tests {
    use bollard::container::LogOutput;
    use futures_util::stream;

    use super::*;

    fn out(s: &str) -> std::result::Result<LogOutput, bollard::errors::Error> {
        Ok(LogOutput::StdOut {
            message: s.as_bytes().to_vec().into(),
        })
    }

    fn err(s: &str) -> std::result::Result<LogOutput, bollard::errors::Error> {
        Ok(LogOutput::StdErr {
            message: s.as_bytes().to_vec().into(),
        })
    }

    async fn collect(
        items: Vec<std::result::Result<LogOutput, bollard::errors::Error>>,
        batching: LogBatching,
    ) -> (Vec<Vec<LogLine>>, Result<()>) {
        let mut batches = Vec::new();
        let cancel = Notify::new();
        let result = forward_logs(stream::iter(items), &cancel, batching, |event| {
            let LogEvent::Lines { lines } = event;
            batches.push(lines);
        })
        .await;
        (batches, result)
    }

    fn line(stream: LogStream, text: &str) -> LogLine {
        LogLine {
            stream,
            text: text.to_owned(),
        }
    }

    #[test]
    fn splitter_joins_chunks_and_strips_line_breaks() {
        let mut splitter = LineSplitter::default();
        let mut lines = Vec::new();
        splitter.push(b"one\r\ntw", |l| lines.push(l));
        splitter.push(b"o\n\nthree", |l| lines.push(l));
        assert_eq!(lines, ["one", "two", ""]);
        assert_eq!(splitter.finish().as_deref(), Some("three"));
        assert_eq!(splitter.finish(), None);
    }

    #[test]
    fn splitter_replaces_invalid_utf8() {
        let mut splitter = LineSplitter::default();
        let mut lines = Vec::new();
        splitter.push(b"a\xffb\n", |l| lines.push(l));
        assert_eq!(lines, ["a\u{fffd}b"]);
    }

    #[tokio::test]
    async fn keeps_stdout_and_stderr_apart_and_in_order() {
        let (batches, result) = collect(
            vec![out("a\nb"), err("x\n"), out("c\n"), err("y")],
            LogBatching::default(),
        )
        .await;
        result.unwrap();
        assert_eq!(
            batches.concat(),
            [
                line(LogStream::Stdout, "a"),
                line(LogStream::Stderr, "x"),
                line(LogStream::Stdout, "bc"),
                line(LogStream::Stderr, "y"),
            ]
        );
    }

    #[tokio::test]
    async fn sends_a_full_batch_at_once() {
        let items = (0..5).map(|i| out(&format!("{i}\n"))).collect();
        let (batches, result) = collect(
            items,
            LogBatching {
                max_wait: Duration::from_secs(60),
                max_lines: 2,
            },
        )
        .await;
        result.unwrap();
        assert_eq!(batches.iter().map(Vec::len).collect::<Vec<_>>(), [2, 2, 1]);
    }

    #[tokio::test]
    async fn sends_the_lines_before_an_error() {
        let items = vec![
            out("a\n"),
            Err(bollard::errors::Error::DockerContainerWaitError {
                error: "boom".into(),
                code: 1,
            }),
        ];
        let (batches, result) = collect(items, LogBatching::default()).await;
        assert!(result.is_err());
        assert_eq!(batches.concat(), [line(LogStream::Stdout, "a")]);
    }

    #[tokio::test]
    async fn flushes_a_waiting_batch_after_the_wait() {
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        tx.send(out("a\n")).unwrap();
        let logs = tokio_stream_from(rx);
        let cancel = Notify::new();
        let mut batches = Vec::new();
        let batching = LogBatching {
            max_wait: Duration::from_millis(10),
            max_lines: 100,
        };
        let run = forward_logs(logs, &cancel, batching, |event| {
            let LogEvent::Lines { lines } = event;
            batches.push(lines);
            cancel.notify_one();
        });
        run.await.unwrap();
        assert_eq!(batches, [vec![line(LogStream::Stdout, "a")]]);
        drop(tx);
    }

    #[tokio::test]
    async fn cancel_ends_an_open_stream() {
        let cancel = Notify::new();
        cancel.notify_one();
        let result = forward_logs(stream::pending(), &cancel, LogBatching::default(), |_| {}).await;
        result.unwrap();
    }

    fn tokio_stream_from(
        mut rx: tokio::sync::mpsc::UnboundedReceiver<
            std::result::Result<LogOutput, bollard::errors::Error>,
        >,
    ) -> impl Stream<Item = std::result::Result<LogOutput, bollard::errors::Error>> {
        stream::poll_fn(move |cx| rx.poll_recv(cx))
    }
}
