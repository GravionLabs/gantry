# ADR 0003: SSH transport through docker system dial-stdio

- Status: Proposed
- Date: 2026-11-20
- Issues: #13

## Context

[ADR 0001](0001-scope-and-stack.md) puts SSH remote hosts into 1.0. Gantry must connect to a Docker engine on a remote host on Linux, macOS and Windows, use the user's `~/.ssh/config` (aliases, keys, jump hosts) and agent, and store no keys or passwords. An unknown host key or failed authentication must produce a clear error, and no interactive prompt may block the app.

Options considered in #13: (a) the `ssh` feature of `bollard` (crate `openssh`, Unix only); (b) `ssh <host> docker system dial-stdio` as a custom transport, as the Docker CLI does; (c) `ssh -L` socket forwarding to a local port.

## Decision

Use option (b) on all platforms. Gantry starts the system `ssh` with `docker system dial-stdio` and speaks the Docker Engine API over its stdin and stdout through a custom transport for `bollard` in `gantry-core`.

- Call `ssh` with `-o BatchMode=yes` so no prompt can hang the app. Unknown host keys and failed authentication surface as typed errors.
- Keep one connection per active endpoint. Close it when the endpoint is switched or the app exits.
- Endpoint form: `ssh://[user@]host[:port]`.
- Test against a local sshd container, marked `#[ignore]` with the reason.

## Consequences

- One code path for Linux, macOS and Windows.
- Aliases, keys, jump hosts and the agent work because the system `ssh` does the work. Gantry stores no secrets.
- The remote host needs a Docker CLI that supports `docker system dial-stdio`.
- Gantry needs an `ssh` client on the machine and owns the transport code, including process handling and cleanup.
- How the stdio stream plugs into `bollard` is settled in the implementation of #13. If it proves unworkable, this ADR is revisited.

## Alternatives

- **(a) `bollard` feature `ssh`:** less own code, but Unix only. Windows would need (b) anyway, which means two transports.
- **(a) on Unix plus (b) on Windows:** closes the Windows gap, but doubles code and tests.
- **(c) `ssh -L` forwarding:** needs local port management and cleanup, and exposes a local port.
