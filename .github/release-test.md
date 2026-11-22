## Overview

Manual test of {milestone} on {platforms} with `pnpm tauri dev` on `release/next`, the last item of the milestone. The
release pull request `release/next` → `main` is finished only after this issue is closed.

## Setup

- [ ] Check out `release/next` at its current head (`git fetch origin && git checkout --detach origin/release/next`),
      then `pnpm install --frozen-lockfile` and `pnpm tauri dev`.
- [ ] A local Docker engine is running with containers, stacks, images, volumes and networks to show.

`tauri dev` does not cover everything an installer does:

- Tauri does not rewrite the assets the dev server serves, so `dangerousDisableAssetCspModification` has no effect;
  `devCsp` mirrors `csp`, and `src/app/core/tauri-csp.spec.ts` guards both.
- The dev build uses the stable identifier `dev.gravionlabs.gantry`: it reads and writes the same `settings.json` as
  an installed stable app. Note the settings before the test and restore them afterwards.
- Updates are not checked in dev.

## Acceptance Criteria

- [ ] The app starts; the webview console shows no Content Security Policy violation (`style-src`, `script-src`,
      `connect-src`).
- [ ] Every view (Containers, Stacks, Images, Volumes, Networks, System, Endpoints, Settings) has its padding and gaps;
      the lists show their rows in the Helix grid theme.
- [ ] Endpoints: the local endpoint connects; switching the endpoint reloads the views.
- [ ] Containers: start, stop and restart a test container; logs, stats and exec stream.
- [ ] Settings: a changed setting is applied at once and is still set after a restart of the app.
- [ ] Every visible acceptance criterion of the PBIs closed in {milestone} holds in the RC (go through the milestone's
      closed issues).
- [ ] Findings are filed as PBIs or Bugs (this milestone if they block the release, otherwise the next one) and linked
      here.

## Technical Notes

- Destructive actions (remove, prune, down) only on containers and resources created for the test.
- The webview console in dev: right-click → Inspect Element, or start with
  `WEBKIT_INSPECTOR_HTTP_SERVER=127.0.0.1:9339 pnpm tauri dev` (Linux) and open `http://127.0.0.1:9339`.
