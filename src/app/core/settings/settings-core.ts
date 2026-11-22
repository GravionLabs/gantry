/** The theme choices of the Appearance section. */
export const THEMES = ["system", "light", "dark"] as const;
export type Theme = (typeof THEMES)[number];

/** The application settings as the views see them. The pages of #113 to #116 add their values here. */
export interface AppSettings {
  readonly appearance: { readonly theme: Theme };
  readonly updates: { readonly autoCheck: boolean };
}

export const DEFAULT_SETTINGS: AppSettings = {
  appearance: { theme: "system" },
  updates: { autoCheck: true },
};

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function flag(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

/**
 * Turns whatever `settings.json` held into valid settings: every unknown or invalid value falls
 * back to its default, so a hand-edited or newer file never breaks the app.
 */
export function sanitizeSettings(raw: unknown): AppSettings {
  const appearance = record(record(raw)["appearance"]);
  const updates = record(record(raw)["updates"]);
  return {
    appearance: {
      theme: oneOf(appearance["theme"], THEMES, DEFAULT_SETTINGS.appearance.theme),
    },
    updates: {
      autoCheck: flag(updates["autoCheck"], DEFAULT_SETTINGS.updates.autoCheck),
    },
  };
}
