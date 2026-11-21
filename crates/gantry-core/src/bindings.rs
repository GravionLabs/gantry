//! TypeScript bindings for every type that crosses the IPC boundary.
//!
//! Register new IPC types in [`ipc_types`]. The `bindings` integration test fails when the committed
//! `src/app/core/bindings.ts` is stale; run `pnpm bindings` to regenerate it.

use specta::Types;
use specta_typescript::Typescript;

use crate::{
    Container, ContainerHealth, ContainerState, ContainerWatchEvent, ContextList, DetectedEngine,
    Endpoint, EndpointKind, EngineInfo, EngineStatus, ErrorKind, ErrorPayload, PortMapping,
    TlsFiles,
};

/// All types exposed to the frontend.
pub fn ipc_types() -> Types {
    Types::default()
        .register::<Container>()
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
        .register::<ErrorPayload>()
        .register::<PortMapping>()
        .register::<TlsFiles>()
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
