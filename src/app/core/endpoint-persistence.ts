import { InjectionToken } from "@angular/core";
import { load } from "@tauri-apps/plugin-store";

import type { Endpoint } from "./bindings";

/** What survives a restart: the manual endpoints and the id of the active endpoint. */
export interface EndpointPrefs {
  readonly manual: readonly Endpoint[];
  readonly active: string | null;
}

export interface EndpointPersistence {
  load(): Promise<EndpointPrefs>;
  save(prefs: EndpointPrefs): Promise<void>;
}

const FILE = "endpoints.json";
const EMPTY: EndpointPrefs = { manual: [], active: null };

/**
 * Keeps the preferences in a tauri-plugin-store file. Only addresses and certificate paths are stored,
 * never passwords. Outside Tauri (a browser) the store is unavailable and nothing is kept.
 */
export function tauriPersistence(): EndpointPersistence {
  const opened = load(FILE, { defaults: {}, autoSave: false }).catch(() => null);
  return {
    async load() {
      const store = await opened;
      if (!store) return EMPTY;
      const manual = await store.get<Endpoint[]>("manual");
      const active = await store.get<string>("active");
      return { manual: Array.isArray(manual) ? manual : [], active: active ?? null };
    },
    async save(prefs) {
      const store = await opened;
      if (!store) return;
      await store.set("manual", prefs.manual);
      await store.set("active", prefs.active);
      await store.save();
    },
  };
}

export const ENDPOINT_PERSISTENCE = new InjectionToken<EndpointPersistence>("EndpointPersistence", {
  providedIn: "root",
  factory: tauriPersistence,
});
