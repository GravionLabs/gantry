//! Gantry domain core: Docker engine endpoints and API access.
//!
//! This crate has no Tauri dependency, so the desktop shell stays thin and the logic is testable
//! without system libraries.

pub mod bindings;
mod endpoint;
mod engine;
mod error;
mod ssh;

pub use endpoint::{Endpoint, EndpointKind};
pub use engine::{Connections, EngineInfo, connect, ping};
pub use error::{Error, ErrorKind, ErrorPayload, Result};
pub use ssh::SshTarget;
