//! Gantry domain core: Docker engine endpoints and API access.
//!
//! This crate has no Tauri dependency, so the desktop shell stays thin and the logic is testable
//! without system libraries.

pub mod bindings;
mod context;
mod detect;
mod endpoint;
mod engine;
mod error;
mod ssh;

pub use context::{
    ContextList, DEFAULT_CONTEXT, current_context, docker_config_dir, import_contexts,
    read_contexts,
};
pub use detect::{
    DEFAULT_TIMEOUT, DetectEnv, DetectedEngine, EngineStatus, Os, candidates, detect, detect_with,
    status_of,
};
pub use endpoint::{Endpoint, EndpointKind, TlsFiles};
pub use engine::{Connections, EngineInfo, connect, ping};
pub use error::{Error, ErrorKind, ErrorPayload, Result};
pub use ssh::SshTarget;
