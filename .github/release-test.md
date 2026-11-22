## Overview

Manual test of `release/next` (run with `pnpm tauri dev`) for {milestone} on {platforms}, the last item of the
milestone. The release pull request `release/next` → `main` is finished only after this issue is closed.

## Setup

- [ ] Check out `release/next` (up to date with origin) and run `pnpm install` and `pnpm tauri dev`. There is no RC
      build.
- [ ] Close an installed stable Gantry first: `tauri dev` uses the stable identifier `dev.gravionlabs.gantry`, so it
      reads and writes the same `settings.json` as an installed stable app.
- [ ] A local Docker engine is running with containers, stacks, images, volumes and networks to show.

## Acceptance Criteria

- [ ] The app starts; the webview console shows no Content Security Policy violation (`style-src`, `script-src`,
      `connect-src`).
- [ ] Every view (Containers, Stacks, Images, Volumes, Networks, System, Endpoints, Settings) has its padding and gaps;
      the lists show their rows in the Helix grid theme.
- [ ] Endpoints: the local endpoint connects; switching the endpoint reloads the views.
- [ ] Containers: start, stop and restart a test container; logs, stats and exec stream.
- [ ] Settings: a changed setting is applied at once and is still set after a restart of the app.
- [ ] Every visible acceptance criterion of the PBIs closed in {milestone} holds in the running app (go through the milestone's
      closed issues).
- [ ] Findings are filed as PBIs or Bugs (this milestone if they block the release, otherwise the next one) and linked
      here.

## Technical Notes

- Destructive actions (remove, prune, down) only on containers and resources created for the test.
- Not covered by `tauri dev`: the handling of the release asset CSP. `dangerousDisableAssetCspModification` has no
  effect in dev (Tauri does not rewrite the assets of the dev server) and `devCsp` only mirrors `csp`, so an unstyled
  release build or empty grids caused by it do not show up here. Check that on an installer after the release.
- Dev uses the stable identifier `dev.gravionlabs.gantry` and therefore the same `settings.json` as an installed stable
  app. Back it up first if its values matter, and expect the Settings checks to change it.
- The webview console of `tauri dev` opens with the inspector (right click, Inspect Element).
