# 0002: UI on helix-desktop

- Status: Accepted (decided by the owner on 2026-11-20)

## Context

Gantry is a desktop application with the frame of an IDE: an activity bar of views, one sidebar, a content area and a status bar. The other GravionLabs desktop applications (nixe, poimen) build that frame on the own design system Helix: `@gravionlabs/helix-desktop` for the frame and `@gravionlabs/helix-ui` for the components and the theme. helix ADR 0005, which defines the package, is still Proposed.

## Decision

- **Frame:** `HxAppShell` with an `HxActivityBar`; the views are declared once as `HelixView` data in `src/app/core/shell/views.ts` (top: Containers, Stacks, Images, Volumes, Networks, System; bottom: Endpoints, Settings). The status bar is `HxStatusBar` with `HxStatusItem`. `@gravionlabs/helix-shell` (the web page layout) is not used.
- **Theme:** `HxTheme` (`provideHxTheme`) follows the system for light and dark. Gantry tokens refine the helix tokens in `src/styles.scss`: accent amber `#f2a900`, container teal `#2bb3c0`.
- **Icons:** inline SVG templates in the app component; helix-desktop ships no icon set.
- **Tauri boundary:** only `src/app/core/shell` imports `@gravionlabs/helix-desktop/tauri` (platform switch, app version). Views stay free of `@tauri-apps/*`. In a plain browser (`pnpm start`) the platform is `web` and the engine shows as unreachable.
- **Dependencies:** `@gravionlabs/helix-*` is excluded from `minimumReleaseAge` so that a new Helix release installs at once. The `/tauri` entry loads `@tauri-apps/plugin-updater` and `@tauri-apps/plugin-process` lazily; they are installed as peers so that the bundle resolves, the updater itself is not wired yet.

## Consequences

- Gantry follows the Helix releases; an API change of helix-desktop (still Proposed upstream) is followed through the helix release notes.
- A new view is one entry in `VIEWS` plus its icon template and its feature.
