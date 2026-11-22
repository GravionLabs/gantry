# Contributing

Read [AGENTS.md](AGENTS.md) first: architecture, rules, verify commands and the issue and PR conventions.

## Development

`pnpm tauri dev` runs the webview under the release CSP (`devCsp` in `src-tauri/tauri.conf.json` equals `csp`), so a
CSP problem shows up while developing and not only in the installers (#96). Only `connect-src` is extended, with
`ws://localhost:1420` and `http://localhost:1420` for the Angular dev server's live reload. When you change `csp`,
change `devCsp` the same way. Tauri does not rewrite assets the dev server serves, so
`dangerousDisableAssetCspModification` has no effect there; the CSP header itself still applies.

## Release flow

1. Work is integrated on `release/next` through one pull request per PBI.
2. Every milestone ends with its release test: `/github-milestone create M<nnn>` adds the PBI
   `[PBI] test: release candidate test of M<nnn> on <platforms>` (label `release-test`, body from
   `.github/release-test.md`, configured in `.agents/config.json` under `release`). The owner runs `pnpm tauri dev` on
   `release/next` and works through it; no RC build is needed.
3. When the milestone is done, the release pull request `release/next` → `main` is opened and reviewed by the owner.
   With `release.test.gate: true`, `github-release finish` refuses while the release-test issue is open.
4. A push to `main` runs `.github/workflows/release.yml`. It calls the shared workflow
   `GravionLabs/ci/.github/workflows/tauri-app.yml@v1`, versions the build with GitVersion, builds the installers
   for Linux, macOS and Windows, signs the update packages and publishes one GitHub release `v<version>` with
   `latest.json`.
5. Installed apps find the release through `releases/latest/download/latest.json` at startup
   (see [docs/updater.md](docs/updater.md)).

### Validation and RC builds

Run the `release` workflow with `workflow_dispatch` on a branch to validate the matrix. Such a run gets the
throw-away version `0.0.<run number>` and creates no release. A dispatch on any branch other than `main` builds
**Gantry RC** with the overlay `src-tauri/tauri.rc.conf.json`: identifier `dev.gravionlabs.gantry.rc`, binary
`gantry-rc`, no updater artifacts and no endpoint. It installs next to the stable app, and the app has the channel `rc`,
shows the RC badge and does not check for updates.

## Signing secrets

Update packages are signed with a Tauri updater key pair (not an operating system certificate).

| Secret                               | Content                  |
| ------------------------------------ | ------------------------ |
| `TAURI_SIGNING_PRIVATE_KEY`          | private key file content |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | its password             |

- The public key is `plugins.updater.pubkey` in `src-tauri/tauri.conf.json`.
- Create a pair with `pnpm tauri signer generate -w ~/.tauri/gantry.key`, then set the secrets with
  `gh secret set TAURI_SIGNING_PRIVATE_KEY --repo GravionLabs/gantry < ~/.tauri/gantry.key` and
  `gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD --repo GravionLabs/gantry`.
- `createUpdaterArtifacts` is set only in `src-tauri/tauri.release.conf.json`, so `tauri dev` and local builds need
  no key.
- Keep a backup of the private key and its password. If they are lost, installed apps can never update again.
  Rotating the key needs a manual install by every user (see [docs/updater.md](docs/updater.md)).
