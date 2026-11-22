import { Injectable, computed, inject } from "@angular/core";

import { HxUpdateService } from "../shell/shell.service";
import { SettingsService } from "./settings.service";

/** The result of "Check now" as the Updates page shows it. */
export type UpdateResult =
  | { readonly kind: "none" }
  | { readonly kind: "checking" }
  | { readonly kind: "current" }
  | { readonly kind: "available"; readonly version: string }
  | { readonly kind: "error"; readonly message: string };

/** Ties the update check of Helix to the settings: the automatic check and "Check now". */
@Injectable({ providedIn: "root" })
export class UpdateSettings {
  private readonly service = inject(HxUpdateService);
  private readonly settings = inject(SettingsService);

  /** An RC build never checks by itself (#28); the switch gives way to a note. */
  readonly isRc = this.service.channel === "rc";

  readonly result = computed<UpdateResult>(() => {
    const state = this.service.state();
    switch (state.status) {
      case "checking":
        return { kind: "checking" };
      case "current":
        return { kind: "current" };
      case "available":
      case "installing":
        return { kind: "available", version: state.update.version };
      case "error":
        return { kind: "error", message: state.message };
      default:
        return { kind: "none" };
    }
  });

  /** The check at startup, once the settings are read: only when switched on (Helix skips RC). */
  async startup(): Promise<void> {
    await this.settings.load();
    if (this.settings.updates().autoCheck) await this.service.start();
  }

  setAutoCheck(autoCheck: boolean): Promise<void> {
    return this.settings.update((current) => ({ ...current, updates: { autoCheck } }));
  }

  checkNow(): Promise<void> {
    return this.service.check();
  }
}
