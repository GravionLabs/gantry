# 0001: Scope and technology stack

- Status: Accepted (decided by the owner on 2026-11-20)

## Context

The owner runs Docker CE on Linux and uses Portainer to manage containers there; on macOS Docker Desktop is used. Portainer needs a server container per host and a browser; Docker Desktop is heavy and its GUI is tied to its own runtime. The goal is a native desktop client that manages any Docker engine.

## Decision

- **Client only.** Gantry talks to existing Docker engines through the Docker Engine API. It does not ship or manage a container runtime or a VM. Engines come from Docker CE (Linux), Docker Desktop, Colima or OrbStack (macOS), Docker in WSL2 or Docker Desktop (Windows), and remote hosts.
- **Endpoints:** local Unix socket and Windows named pipe, Docker contexts, TCP, and **SSH remote hosts as part of 1.0**.
- **Stack:** Tauri 2 with a Rust core (`crates/gantry-core`, no Tauri dependency, Docker access through `bollard`) and a thin shell (`src-tauri`); Angular 22 frontend (standalone components, signals, pnpm), as in the other GravionLabs desktop applications.
- **Compose:** stacks are recognized by the `com.docker.compose.*` labels; actions call the `docker compose` CLI instead of reimplementing Compose.
- **License:** MIT OR Apache-2.0; the repository is public.
- **Name:** Gantry (a gantry crane moves containers in a port).

## Consequences

- macOS and Windows need an engine installed by the user; Gantry detects the common ones and explains what is missing.
- Runtime management (starting a Colima VM, WSL integration) is out of scope for 1.0 and needs a new decision.
