# Auto update: release side

Gantry updates itself like Nixe with [`tauri-plugin-updater`](https://v2.tauri.app/plugin/updater/) from the latest
GitHub release. This page covers the release side: signed update packages and `latest.json`. The in-app update
flow is in the status bar (below).

## What a release contains

A push to `main` runs `.github/workflows/release.yml`, which calls the shared workflow
`GravionLabs/ci/.github/workflows/tauri-app.yml@v1`. Besides the installers, the release has the signed update
packages (`*.sig`) and `latest.json`. The workflow pins the URLs in `latest.json` to the release tag.

Pre-releases are not offered to a stable install: the endpoint is `releases/latest`, which GitHub resolves to the
newest release that is not a pre-release.

## Configuration

`src-tauri/tauri.conf.json`:

```json
"plugins": {
  "updater": {
    "pubkey": "<public key>",
    "endpoints": ["https://github.com/GravionLabs/gantry/releases/latest/download/latest.json"]
  }
}
```

The repository ships a placeholder for `pubkey` until the owner has generated the key (below). A release build
fails until it is replaced.

`createUpdaterArtifacts` is set only in `src-tauri/tauri.release.conf.json`. `release.yml` passes it with
`installer-args: --config src-tauri/tauri.release.conf.json`, so `tauri dev` and local builds need no key.

## Signing

Update packages are signed with a Tauri updater key pair. It is **not** the Apple certificate.

1. Generate it once: `pnpm tauri signer generate -w ~/.tauri/gantry.key` (choose a password).
2. Put the content of `gantry.key.pub` into `plugins.updater.pubkey` and commit that change.
3. Set the secrets: `gh secret set TAURI_SIGNING_PRIVATE_KEY --repo GravionLabs/gantry < ~/.tauri/gantry.key` and
   `gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD --repo GravionLabs/gantry`.
4. Keep the private key and its password in the password manager. Never commit them.

### Rotating the key

Installed apps trust the old public key only. After a change of `pubkey` they cannot verify a new release, so
rotate it only together with a release that every user installs by hand, or keep the old key. To rotate: generate
a new pair, replace `pubkey`, update both secrets, and announce the manual install in the release notes.

## Test of the first release

1. Install the previous build on each platform (Linux, macOS, Windows).
2. Merge the release PR to `main` and wait for the release.
3. Check that the release lists `*.sig` files for every platform and a `latest.json` whose URLs point to
   `releases/download/<tag>/`.
4. Check the signature with the public key, then update the installed build through the updater once the in-app
   flow exists.

## Use

The in-app side is the update service of `@gravionlabs/helix-desktop/tauri` (`HxUpdateService`, as in Nixe and Poimen), on
top of `tauri-plugin-updater` and `tauri-plugin-process`.

- At startup the app checks once (`HxUpdateService.start()`) when Settings > Updates > "Check for updates automatically" is on (the default); there is no timer. **Check now** in the same page checks on request.
- `<hx-status-update>` at the right of the status bar shows nothing while idle or current. While checking, when a version
  is available, while installing and after an error it shows the state; its popover has the version, the release notes and
  **Install and restart**. The package is verified against `plugins.updater.pubkey` before it is installed.
- An error names the failed step (check, install, relaunch) and offers **Try again**.
- An RC build (identifier `dev.gravionlabs.gantry.rc`, built by a `release.yml` dispatch on a branch other than `main`
  with `src-tauri/tauri.rc.conf.json`: product name `Gantry RC`, no updater artifacts, empty endpoints) has the channel
  `rc` (`provideShell()` in `core/shell/shell.service.ts` reads the identifier): the status bar shows the RC badge and the
  app does not check at startup. A stable install ignores pre-releases because the endpoint is `releases/latest`.
- `src-tauri/capabilities/desktop.json` grants `updater:default` and `process:allow-restart` on Linux, macOS and Windows.
  The plugins are registered for desktop targets only.

## Manual test of the first update

Install an older build (with the real `pubkey`) on Linux, macOS and Windows, publish a release, then check, install and
confirm the restart shows the new version. Not done in this change: it needs a signed release.
