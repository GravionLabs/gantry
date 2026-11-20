import {
  EnvironmentProviders,
  Injectable,
  computed,
  inject,
  makeEnvironmentProviders,
  signal,
} from "@angular/core";
import type { HxActivityBarItem } from "@gravionlabs/helix-desktop";
import {
  HX_APP_INFO,
  provideHxAppInfo,
  providePlatform,
  readTauriVersion,
} from "@gravionlabs/helix-desktop/tauri";

import { GantryView, VIEWS, findView, resolveView } from "./views";

/**
 * Sets `data-platform` on the root element and provides the app version. This is the only place that
 * imports `@gravionlabs/helix-desktop/tauri`; outside Tauri the platform is `web` and the version a fallback.
 */
export async function provideShell(): Promise<EnvironmentProviders> {
  const version = await readTauriVersion("0.0.0");
  return makeEnvironmentProviders([providePlatform(), provideHxAppInfo({ version })]);
}

/** The activity bar and the sidebar: one active view and the sidebar shown or collapsed. */
@Injectable({ providedIn: "root" })
export class ShellService {
  readonly appInfo = inject(HX_APP_INFO);

  readonly views: readonly GantryView[] = VIEWS;
  readonly items: HxActivityBarItem[] = VIEWS.map(({ id, label, icon, position }) => ({
    id,
    label,
    icon,
    position,
  }));

  readonly activeId = signal(resolveView(null));
  readonly collapsed = signal(false);
  readonly sidebarWidth = signal(260);
  readonly activeView = computed(() => findView(this.activeId()) ?? VIEWS[0]);

  select(id: string): void {
    if (id === this.activeId() && !this.collapsed()) this.collapsed.set(true);
    else {
      this.activeId.set(resolveView(id));
      this.collapsed.set(false);
    }
  }
}

// Re-exported so that no file outside core/shell imports the /tauri entry.
export { HxStatusAppVersion } from "@gravionlabs/helix-desktop/tauri";
