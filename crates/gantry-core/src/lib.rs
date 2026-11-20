//! Gantry domain core: Docker engine endpoints and API access.
//!
//! This crate has no Tauri dependency, so the desktop shell stays thin and the logic is testable
//! without system libraries.

pub mod bindings;
mod endpoint;
mod engine;
mod error;

pub use endpoint::{Endpoint, EndpointKind};
pub use engine::{EngineInfo, connect, ping};
pub use error::{Error, ErrorKind, ErrorPayload, Result};
