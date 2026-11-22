import { Injectable, InjectionToken, computed, inject, signal } from "@angular/core";

import { invoke } from "../invoke";
import { type AppSettings, DEFAULT_SETTINGS, sanitizeSettings } from "./settings-core";

/** Reads and writes `settings.json` as a whole; the Tauri commands `load_settings` and `save_settings`. */
export interface SettingsBackend {
  load(): Promise<unknown>;
  save(settings: AppSettings): Promise<void>;
}

export const SETTINGS_BACKEND = new InjectionToken<SettingsBackend>("SettingsBackend", {
  providedIn: "root",
  factory: () => ({
    load: () => invoke<unknown>("load_settings"),
    save: (settings) => invoke<void>("save_settings", { settings }),
  }),
});

/** Keeps the application settings: loaded once on startup, exposed as signals, saved on change. */
@Injectable({ providedIn: "root" })
export class SettingsService {
  private readonly backend = inject(SETTINGS_BACKEND);
  private loading: Promise<void> | null = null;

  private readonly state = signal<AppSettings>(DEFAULT_SETTINGS);
  private readonly isLoaded = signal(false);
  private readonly failure = signal<string | null>(null);

  readonly settings = this.state.asReadonly();
  readonly appearance = computed(() => this.state().appearance);
  readonly updates = computed(() => this.state().updates);
  readonly containers = computed(() => this.state().containers);
  /** True once the file was read (or failed and the defaults apply). */
  readonly loaded = this.isLoaded.asReadonly();
  /** The message of the last failed read or write, else null. */
  readonly error = this.failure.asReadonly();

  /** Loads the settings once; later calls return the same promise. A failure keeps the defaults. */
  load(): Promise<void> {
    this.loading ??= this.backend
      .load()
      .then((raw) => this.state.set(sanitizeSettings(raw)))
      .catch((error: unknown) => this.failure.set(messageOf(error)))
      .finally(() => this.isLoaded.set(true));
    return this.loading;
  }

  /** Applies a change and writes the whole settings through `save_settings`. */
  async update(change: (current: AppSettings) => AppSettings): Promise<void> {
    const next = sanitizeSettings(change(this.state()));
    this.state.set(next);
    try {
      await this.backend.save(next);
      this.failure.set(null);
    } catch (error) {
      this.failure.set(messageOf(error));
    }
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
