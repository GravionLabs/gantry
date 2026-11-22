/** The theme choices of the Appearance section. */
export const THEMES = ["system", "light", "dark"] as const;
export type Theme = (typeof THEMES)[number];

/** The refresh intervals of the lists in seconds; 0 is off (events and the Refresh button only). */
export const REFRESH_INTERVALS = [0, 2, 5, 10, 30] as const;
export type RefreshInterval = (typeof REFRESH_INTERVALS)[number];

/** The application settings as the views see them. The pages of #113 to #116 add their values here. */
export interface AppSettings {
  readonly appearance: { readonly theme: Theme };
  readonly updates: { readonly autoCheck: boolean };
  /** What the containers view starts with; its toggles change the current view only. */
  readonly containers: { readonly showStats: boolean; readonly groupByStack: boolean };
  /** How Gantry talks to the engine; `refreshSeconds` is shared by all lists. */
  readonly engine: { readonly refreshSeconds: RefreshInterval };
}

export const DEFAULT_SETTINGS: AppSettings = {
  appearance: { theme: "system" },
  updates: { autoCheck: true },
  containers: { showStats: false, groupByStack: false },
  engine: { refreshSeconds: 0 },
};

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function flag(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function oneOf<T extends string | number>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

/**
 * Turns whatever `settings.json` held into valid settings: every unknown or invalid value falls
 * back to its default, so a hand-edited or newer file never breaks the app.
 */
export function sanitizeSettings(raw: unknown): AppSettings {
  const appearance = record(record(raw)["appearance"]);
  const updates = record(record(raw)["updates"]);
  const containers = record(record(raw)["containers"]);
  const engine = record(record(raw)["engine"]);
  return {
    appearance: {
      theme: oneOf(appearance["theme"], THEMES, DEFAULT_SETTINGS.appearance.theme),
    },
    updates: {
      autoCheck: flag(updates["autoCheck"], DEFAULT_SETTINGS.updates.autoCheck),
    },
    containers: {
      showStats: flag(containers["showStats"], DEFAULT_SETTINGS.containers.showStats),
      groupByStack: flag(containers["groupByStack"], DEFAULT_SETTINGS.containers.groupByStack),
    },
    engine: {
      refreshSeconds: oneOf(
        engine["refreshSeconds"],
        REFRESH_INTERVALS,
        DEFAULT_SETTINGS.engine.refreshSeconds,
      ),
    },
  };
}
