# Auto update: release side

Gantry updates itself like Nixe with [`tauri-plugin-updater`](https://v2.tauri.app/plugin/updater/) from the latest
GitHub release. This page covers the release side: signed update packages and `latest.json`. The in-app update
flow is a separate change.

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
