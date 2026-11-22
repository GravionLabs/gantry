import { effect, inject } from "@angular/core";

import { SettingsService } from "./settings.service";

/**
 * Runs `action` every `engine.refreshSeconds` while the calling component lives; 0 (off) runs it
 * never, so the list refreshes on engine events and the Refresh button only. A changed setting
 * restarts the timer at once. Call it in an injection context (a constructor).
 */
export function pollRefresh(action: () => void): void {
  const settings = inject(SettingsService);
  effect((onCleanup) => {
    const seconds = settings.engine().refreshSeconds;
    if (seconds <= 0) return;
    const id = setInterval(action, seconds * 1000);
    onCleanup(() => clearInterval(id));
  });
}
