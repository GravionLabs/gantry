## Overview

Manual test of the release candidate of {milestone} on {platforms}, the last item of the milestone. The release pull
request `release/next` → `main` is finished only after this issue is closed.

## Setup

- [ ] Build the RC: `gh workflow run release.yml --ref release/next` (or the run `deliver` started) and download the
      installer of each platform from the run's artifacts.
- [ ] Install **Gantry RC** next to the stable app: it has its own identifier `dev.gravionlabs.gantry.rc`, its own
      settings and no auto-update, and shows the RC badge.
- [ ] A local Docker engine is running with containers, stacks, images, volumes and networks to show.

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
- A webview console of a release build: start the app with `WEBKIT_INSPECTOR_HTTP_SERVER=127.0.0.1:9339` (Linux) and
  open `http://127.0.0.1:9339`.
