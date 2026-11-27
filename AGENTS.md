# AGENTS.md

Guidance for humans and coding agents working in this repository. Generated text (docs, issues, commits, code) is written in US English.

## Architecture

```
Angular views ─► Tauri commands (src-tauri) ─► gantry-core ─► bollard ─► Docker Engine API
```

- **`crates/gantry-core`**: endpoints, connections and every Docker operation. No Tauri or UI dependency, so it is tested without system libraries. New logic belongs here.
- **`src-tauri`** (crate `gantry-app`): a thin shell. Each command converts arguments, calls the core and maps errors to `{ message }`. Long-running streams (logs, events, stats, exec) are forwarded with Tauri channels.
- **`src`**: Angular 22 (standalone components, signals, OnPush, pnpm). Calls to commands live in `src/app/core`; their TypeScript types mirror the core's serde types (camelCase).
- Scope and stack: [ADR 0001](docs/adr/0001-scope-and-stack.md). Gantry is a client only; it never installs or manages a runtime.

### Rules

- **Endpoints are explicit:** every core operation takes the endpoint it acts on; there is no hidden global connection.
- **No secrets in plain files:** SSH keys stay with the user's SSH agent and config; Gantry stores no passwords.
- **Tests never need a running engine** unless marked `#[ignore]` with the reason; use `bollard` mocks or fixtures.

## UI style guide

Before changing UI, read the base guide `node_modules/@gravionlabs/helix-ui/styleguide/STYLEGUIDE.md`, then [`docs/STYLEGUIDE.md`](docs/STYLEGUIDE.md), which lists this project's rules and deviations; read a deep-dive file of either when its condition applies. Both are binding: a deviation needs a reason in the PR description.

- Feedback follows the Helix [UX rules](https://github.com/GravionLabs/helix/blob/main/docs/UX-RULES.md).
- Build forms with `hx-field`, rows with `hx-list-row`, text sizes with the type scale (`--h-font-size-*`) and gaps and padding with the spacing tokens (`--h-space-*`).

## Verification

```sh
pnpm lint && pnpm format:check && pnpm test && pnpm build
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

`cargo clippy`/`cargo test` of `gantry-app` need the Tauri system libraries (`libwebkit2gtk-4.1-dev` and friends) and a built frontend (`pnpm build`).

## Issue and PR conventions

- Hierarchy: Epic → Feature → PBI, linked as native sub-issues; dependencies as "blocked by". Titles carry the level prefix (`[PBI] feat(scope): …`).
- One branch and one PR per PBI; the PR body says `Closes #<PBI>`. Conventional commit messages.
- Work is integrated on `release/next`; `main` only receives a finished release branch. CI checks run for PRs into `main` and pushes to `release/**`; installers are built only on `main`.
- Decisions get the `needs-decision` label. Write the ADR in `docs/adr/` with the next free number and Status: Proposed, then wait for the owner.
