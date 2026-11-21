//! Gantry domain core: Docker engine endpoints and API access.
//!
//! This crate has no Tauri dependency, so the desktop shell stays thin and the logic is testable
//! without system libraries.

pub mod bindings;
mod compose;
mod containers;
mod context;
mod detect;
mod endpoint;
mod engine;
mod error;
mod exec;
mod images;
mod logs;
mod ssh;
mod stacks;
mod stats;
mod volumes;

pub use compose::{
    ComposeAction, ComposeAvailability, ComposeCommand, ComposeEvent, ComposeProject, PluginProbe,
    availability_of, build_command, check_compose, default_project_name, deploy_project,
    is_valid_project_name, preview_compose_file, run_command, run_compose,
};
pub use containers::{
    ActionEvent, ActionTarget, Container, ContainerAction, ContainerActions, ContainerDetails,
    ContainerHealth, ContainerSource, ContainerState, ContainerWatchEvent, EnvVar, Label,
    MountInfo, NetworkAttachment, PortMapping, RestartPolicy, WatchTiming, Watches,
    inspect_container, list_containers, run_action, watch_containers,
};
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
pub use exec::{ExecEvent, ExecOptions, ExecSessions, run_exec};
pub use images::{
    Image, PruneOutcome, PullEvent, RemoveOutcome, images_of, list_images, prune_images,
    pull_image, remove_image, split_reference,
};
pub use logs::{LogBatching, LogEvent, LogLine, LogOptions, LogStream, stream_logs};
pub use ssh::SshTarget;
pub use stacks::{Stack, StackService, list_stacks, stacks_of};
pub use stats::{StatsEvent, StatsSample, sample_of, stream_stats};
pub use volumes::{
    Volume, VolumePruneOutcome, VolumeSpec, create_volume, list_volumes, prune_volumes,
    remove_volume,
};
