/** One page of the Settings view. The pages of #113 to #116 fill them. */
export interface SettingsCategory {
  readonly id: string;
  readonly label: string;
  readonly description: string;
}

/** The categories in the order of the list. */
export const SETTINGS_CATEGORIES: readonly SettingsCategory[] = [
  { id: "appearance", label: "Appearance", description: "Theme and display." },
  { id: "updates", label: "Updates", description: "Checking for new versions." },
  { id: "containers", label: "Containers", description: "How the container views behave." },
  { id: "engine", label: "Engine", description: "How Gantry talks to the engine." },
];

export const DEFAULT_CATEGORY = SETTINGS_CATEGORIES[0].id;

/** The wanted category when it exists, else the first one. */
export function resolveCategory(id: string | null | undefined): string {
  return SETTINGS_CATEGORIES.some((c) => c.id === id) ? (id as string) : DEFAULT_CATEGORY;
}

/** Pure UI state, kept apart from `settings.json`. */
export const UI_STATE_KEY = "gantry.ui-state";

export function readSelectedCategory(storage: Pick<Storage, "getItem">): string {
  try {
    const raw = storage.getItem(UI_STATE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    const id = (parsed as { settingsCategory?: unknown } | null)?.settingsCategory;
    return resolveCategory(typeof id === "string" ? id : null);
  } catch {
    return DEFAULT_CATEGORY;
  }
}

export function writeSelectedCategory(storage: Pick<Storage, "setItem">, id: string): void {
  try {
    storage.setItem(UI_STATE_KEY, JSON.stringify({ settingsCategory: id }));
  } catch {
    // The selection is only a convenience.
  }
}
