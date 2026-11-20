use std::io;

use bollard::errors::Error as BollardError;
use serde::{Serialize, Serializer};
use specta::Type;

/// What went wrong, in terms the UI can act on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ErrorKind {
    /// The engine cannot be reached (no socket, connection refused, timeout).
    Unreachable,
    /// The engine or the operating system refused access.
    PermissionDenied,
    /// The addressed object does not exist.
    NotFound,
    /// The request conflicts with the state of the engine (name in use, running container).
    Conflict,
    /// The request or the endpoint address is malformed.
    InvalidInput,
    /// Any other engine or client error.
    Engine,
}

/// The serialized form of [`Error`]: `{ kind, message }`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ErrorPayload {
    pub kind: ErrorKind,
    pub message: String,
}

/// Errors of the core, serialized to the frontend as `{ kind, message }`.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("invalid endpoint address: {0}")]
    InvalidAddress(String),
    #[error("Docker engine error: {0}")]
    Docker(#[from] BollardError),
}

pub type Result<T> = std::result::Result<T, Error>;

impl Error {
    /// Classifies the error for the UI.
    pub fn kind(&self) -> ErrorKind {
        match self {
            Self::InvalidAddress(_) => ErrorKind::InvalidInput,
            Self::Docker(error) => classify(error),
        }
    }

    /// The `{ kind, message }` form sent to the frontend.
    pub fn payload(&self) -> ErrorPayload {
        ErrorPayload {
            kind: self.kind(),
            message: self.to_string(),
        }
    }
}

impl Serialize for Error {
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        self.payload().serialize(serializer)
    }
}

fn classify(error: &BollardError) -> ErrorKind {
    match error {
        BollardError::DockerResponseServerError { status_code, .. } => match *status_code {
            401 | 403 => ErrorKind::PermissionDenied,
            404 => ErrorKind::NotFound,
            409 => ErrorKind::Conflict,
            400 | 422 => ErrorKind::InvalidInput,
            _ => ErrorKind::Engine,
        },
        BollardError::IOError { err } => classify_io(err.kind()),
        BollardError::RequestTimeoutError
        | BollardError::HyperResponseError { .. }
        | BollardError::HttpClientError { .. } => ErrorKind::Unreachable,
        BollardError::URLParseError { .. } | BollardError::URLEncodedError { .. } => {
            ErrorKind::InvalidInput
        }
        // Request-time failures of the socket transports arrive wrapped; look for the I/O cause.
        other => io_cause(other).map_or(ErrorKind::Engine, classify_io),
    }
}

/// The first `io::Error` in the source chain of the error.
fn io_cause<'a>(error: &'a (dyn std::error::Error + 'static)) -> Option<io::ErrorKind> {
    let mut current = error.source();
    while let Some(cause) = current {
        if let Some(io) = cause.downcast_ref::<io::Error>() {
            return Some(io.kind());
        }
        current = cause.source();
    }
    None
}

fn classify_io(kind: io::ErrorKind) -> ErrorKind {
    match kind {
        io::ErrorKind::PermissionDenied => ErrorKind::PermissionDenied,
        // A missing socket file means there is no engine to talk to.
        io::ErrorKind::NotFound
        | io::ErrorKind::ConnectionRefused
        | io::ErrorKind::ConnectionReset
        | io::ErrorKind::ConnectionAborted
        | io::ErrorKind::NotConnected
        | io::ErrorKind::AddrNotAvailable
        | io::ErrorKind::BrokenPipe
        | io::ErrorKind::TimedOut => ErrorKind::Unreachable,
        _ => ErrorKind::Engine,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn server(status_code: u16) -> Error {
        Error::Docker(BollardError::DockerResponseServerError {
            status_code,
            message: "boom".into(),
        })
    }

    fn io_error(kind: io::ErrorKind) -> Error {
        Error::Docker(BollardError::IOError {
            err: io::Error::new(kind, "io"),
        })
    }

    #[test]
    fn maps_every_kind_from_bollard_errors() {
        let cases = [
            (
                io_error(io::ErrorKind::ConnectionRefused),
                ErrorKind::Unreachable,
            ),
            (io_error(io::ErrorKind::NotFound), ErrorKind::Unreachable),
            (
                Error::Docker(BollardError::RequestTimeoutError),
                ErrorKind::Unreachable,
            ),
            (
                io_error(io::ErrorKind::PermissionDenied),
                ErrorKind::PermissionDenied,
            ),
            (server(403), ErrorKind::PermissionDenied),
            (server(404), ErrorKind::NotFound),
            (server(409), ErrorKind::Conflict),
            (server(400), ErrorKind::InvalidInput),
            (Error::InvalidAddress("x".into()), ErrorKind::InvalidInput),
            (server(500), ErrorKind::Engine),
            (io_error(io::ErrorKind::InvalidData), ErrorKind::Engine),
            (
                Error::Docker(BollardError::APIVersionParseError {}),
                ErrorKind::Engine,
            ),
        ];
        for (error, kind) in cases {
            assert_eq!(error.kind(), kind, "{error}");
        }
    }

    #[test]
    fn serializes_kind_and_message() {
        let json = serde_json::to_value(server(409)).unwrap();
        assert_eq!(json["kind"], "conflict");
        assert_eq!(
            json["message"],
            "Docker engine error: Docker responded with status code 409: boom"
        );
        let json = serde_json::to_value(io_error(io::ErrorKind::PermissionDenied)).unwrap();
        assert_eq!(json["kind"], "permissionDenied");
        let json = serde_json::to_value(Error::InvalidAddress("x".into())).unwrap();
        assert_eq!(json["kind"], "invalidInput");
        assert_eq!(json["message"], "invalid endpoint address: x");
    }
}
