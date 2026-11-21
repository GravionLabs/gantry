//! TypeScript bindings for every type that crosses the IPC boundary.
//!
//! Register new IPC types in [`ipc_types`]. The `bindings` integration test fails when the committed
//! `src/app/core/bindings.ts` is stale; run `pnpm bindings` to regenerate it.

use specta::Types;
use specta_typescript::Typescript;

use crate::{
    ActionEvent, ActionTarget, ComposeAction, ComposeAvailability, ComposeEvent, ComposeProject,
    Container, ContainerAction, ContainerDetails, ContainerHealth, ContainerState,
    ContainerWatchEvent, ContextList, DetectedEngine, Endpoint, EndpointKind, EngineInfo,
    EngineStatus, EnvVar, ErrorKind, ErrorPayload, ExecEvent, ExecOptions, Image, Label, LogEvent,
    LogLine, LogOptions, LogStream, MountInfo, Network, NetworkAttachment, NetworkPruneOutcome,
    NetworkSpec, PortMapping, PruneOutcome, PullEvent, RemoveOutcome, RestartPolicy, Stack,
    StackService, StatsEvent, StatsSample, TlsFiles, Volume, VolumePruneOutcome, VolumeSpec,
};

/// All types exposed to the frontend.
pub fn ipc_types() -> Types {
    Types::default()
        .register::<ActionEvent>()
        .register::<ActionTarget>()
        .register::<ComposeAction>()
        .register::<ComposeAvailability>()
        .register::<ComposeEvent>()
        .register::<ComposeProject>()
        .register::<Container>()
        .register::<ContainerAction>()
        .register::<ContainerDetails>()
        .register::<ContainerHealth>()
        .register::<ContainerState>()
        .register::<ContainerWatchEvent>()
        .register::<ContextList>()
        .register::<Endpoint>()
        .register::<EndpointKind>()
        .register::<DetectedEngine>()
        .register::<EngineInfo>()
        .register::<EngineStatus>()
        .register::<ErrorKind>()
        .register::<EnvVar>()
        .register::<ErrorPayload>()
        .register::<ExecEvent>()
        .register::<ExecOptions>()
        .register::<Image>()
        .register::<Label>()
        .register::<LogEvent>()
        .register::<LogLine>()
        .register::<LogOptions>()
        .register::<LogStream>()
        .register::<MountInfo>()
        .register::<NetworkAttachment>()
        .register::<PortMapping>()
        .register::<PruneOutcome>()
        .register::<PullEvent>()
        .register::<RemoveOutcome>()
        .register::<RestartPolicy>()
        .register::<Stack>()
        .register::<StackService>()
        .register::<Network>()
        .register::<NetworkPruneOutcome>()
        .register::<NetworkSpec>()
        .register::<StatsEvent>()
        .register::<StatsSample>()
        .register::<TlsFiles>()
        .register::<Volume>()
        .register::<VolumePruneOutcome>()
        .register::<VolumeSpec>()
}

/// Renders the TypeScript bindings file.
pub fn typescript_bindings() -> String {
    Typescript::default()
        .header("// Generated from Rust by `pnpm bindings`. DO NOT EDIT.")
        .export(&ipc_types(), specta_serde::Format)
        .expect("IPC types must be exportable to TypeScript")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bindings_contain_the_error_shape() {
        let ts = typescript_bindings();
        assert!(ts.contains("ErrorPayload"), "{ts}");
        assert!(ts.contains("permissionDenied"), "{ts}");
        assert!(ts.contains("apiVersion"), "{ts}");
    }
}
