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

import { containerPath } from "../containers";
import { GantryView, VIEWS, findView, resolveView } from "./views";

/**
 * Sets `data-platform` on the root element and provides the app version. This is the only place that
 * imports `@gravionlabs/helix-desktop/tauri`; outside Tauri the platform is `web` and the version a fallback.
 */
export async function provideShell(): Promise<EnvironmentProviders> {
  const version = await readTauriVersion("0.0.0");
  const channel = (await readTauriIdentifier()).endsWith(RC_IDENTIFIER_SUFFIX) ? "rc" : undefined;
  return makeEnvironmentProviders([providePlatform(), provideHxAppInfo({ version, channel })]);
}

/** The identifier of the RC build is `dev.gravionlabs.gantry.rc`; it installs next to the stable app. */
export const RC_IDENTIFIER_SUFFIX = ".rc";

/** The bundle identifier from Tauri; empty outside Tauri. */
async function readTauriIdentifier(): Promise<string> {
  try {
    const { getIdentifier } = await import("@tauri-apps/api/app");
    return await getIdentifier();
  } catch {
    return "";
  }
}

/**
 * The activity bar: one active view. The shell has no sidebar while no view has content for it, so the
 * activity bar switches the content directly.
 */
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
  readonly activeView = computed(() => findView(this.activeId()) ?? VIEWS[0]);

  /**
   * The route `/containers/:id`: the container whose details the Containers view shows, or null for
   * the list. It lives here, not in the view, so that it survives a reload of the endpoint.
   */
  readonly containerId = signal<string | null>(null);
  readonly path = computed(() => {
    const id = this.containerId();
    return this.activeId() === "containers" && id !== null
      ? containerPath(id)
      : `/${this.activeId()}`;
  });

  /** Shows the details of a container. */
  openContainer(id: string): void {
    this.activeId.set("containers");
    this.containerId.set(id);
  }

  /** Back to the list of containers. */
  closeContainer(): void {
    this.containerId.set(null);
  }

  /** Shows a view; selecting the active view again returns from the details to the list. */
  select(id: string): void {
    this.containerId.set(null);
    this.activeId.set(resolveView(id));
  }
}

// Re-exported so that no file outside core/shell imports the /tauri entry.
export {
  HxStatusAppVersion,
  HxStatusUpdate,
  HxUpdateService,
} from "@gravionlabs/helix-desktop/tauri";
