//! Gantry domain core: Docker engine endpoints and API access.
//!
//! This crate has no Tauri dependency, so the desktop shell stays thin and the logic is testable
//! without system libraries.

pub mod bindings;
mod context;
mod endpoint;
mod engine;
mod error;

pub use context::{
    ContextList, DEFAULT_CONTEXT, current_context, docker_config_dir, import_contexts,
    read_contexts,
};
pub use endpoint::{Endpoint, EndpointKind, TlsFiles};
pub use engine::{EngineInfo, connect, ping};
pub use error::{Error, ErrorKind, ErrorPayload, Result};
