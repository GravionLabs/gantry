//! Gantry domain core: Docker engine endpoints and API access.
//!
//! This crate has no Tauri dependency, so the desktop shell stays thin and the logic is testable
//! without system libraries.

mod endpoint;
mod engine;

pub use endpoint::{Endpoint, EndpointKind};
pub use engine::{EngineInfo, connect, ping};

/// Errors of the core, serialized to the frontend as `{ kind, message }`.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("invalid endpoint address: {0}")]
    InvalidAddress(String),
    #[error("Docker engine error: {0}")]
    Docker(#[from] bollard::errors::Error),
}

pub type Result<T> = std::result::Result<T, Error>;
