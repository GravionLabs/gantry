import { DOCUMENT, Injectable, InjectionToken, effect, inject, signal } from "@angular/core";
import { HxTheme } from "@gravionlabs/helix-ui";

import { type Theme } from "./settings-core";
import { SettingsService } from "./settings.service";

/** Whether the system prefers a dark color scheme, and a way to follow its changes. */
export interface SystemScheme {
  readonly dark: boolean;
  onChange(listener: (dark: boolean) => void): void;
}

export const SYSTEM_SCHEME = new InjectionToken<SystemScheme>("SystemScheme", {
  providedIn: "root",
  factory: () => {
    const query = inject(DOCUMENT).defaultView?.matchMedia?.("(prefers-color-scheme: dark)");
    return {
      dark: query?.matches ?? false,
      onChange: (listener) => query?.addEventListener("change", (e) => listener(e.matches)),
    };
  },
});

/** Dark or light for a theme choice; System follows the system scheme. */
export function resolveDark(theme: Theme, systemDark: boolean): boolean {
  return theme === "system" ? systemDark : theme === "dark";
}

/** Applies the theme of the settings to the shell and the grids (both follow `HxTheme`). */
@Injectable({ providedIn: "root" })
export class ThemeService {
  private readonly hxTheme = inject(HxTheme);
  private readonly settings = inject(SettingsService);
  private readonly systemDark = signal(false);

  constructor() {
    const system = inject(SYSTEM_SCHEME);
    this.systemDark.set(system.dark);
    system.onChange((dark) => this.systemDark.set(dark));
    effect(() => {
      this.hxTheme.setDark(resolveDark(this.settings.appearance().theme, this.systemDark()));
    });
  }

  /** Changes the theme at once and stores it. */
  setTheme(theme: Theme): Promise<void> {
    return this.settings.update((current) => ({
      ...current,
      appearance: { ...current.appearance, theme },
    }));
  }
}
