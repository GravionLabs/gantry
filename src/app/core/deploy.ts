import { InjectionToken } from "@angular/core";
import { open } from "@tauri-apps/plugin-dialog";
import { load } from "@tauri-apps/plugin-store";

import type { ComposeProject } from "./bindings";
import { invoke } from "./invoke";

/** A deployment that is offered again: the picked files and the project name. */
export interface RecentDeploy {
  readonly composeFile: string;
  readonly envFile: string | null;
  readonly name: string;
}

/** How many deployments are remembered per endpoint. */
export const RECENT_LIMIT = 8;

/** Puts `entry` first, drops an older entry for the same Compose file and keeps the newest few. */
export function addRecent(
  recent: readonly RecentDeploy[],
  entry: RecentDeploy,
): readonly RecentDeploy[] {
  return [entry, ...recent.filter((r) => r.composeFile !== entry.composeFile)].slice(
    0,
    RECENT_LIMIT,
  );
}

/** Recently deployed files, kept per endpoint (by its address). */
export interface RecentDeploys {
  list(endpointAddress: string): Promise<readonly RecentDeploy[]>;
  remember(endpointAddress: string, entry: RecentDeploy): Promise<void>;
}

const FILE = "recent-deploys.json";

function isRecent(value: unknown): value is RecentDeploy {
  if (typeof value !== "object" || value === null) return false;
  const { composeFile, envFile, name } = value as Record<string, unknown>;
  return (
    typeof composeFile === "string" &&
    typeof name === "string" &&
    (envFile === null || typeof envFile === "string")
  );
}

/** Keeps the list in a tauri-plugin-store file; outside Tauri nothing is kept. */
export function tauriRecentDeploys(): RecentDeploys {
  const opened = load(FILE, { defaults: {}, autoSave: false }).catch(() => null);
  const read = async (store: NonNullable<Awaited<typeof opened>>, address: string) => {
    const all = await store.get<Record<string, unknown[]>>("byEndpoint");
    const mine = all && typeof all === "object" ? all[address] : undefined;
    return { all: all ?? {}, mine: Array.isArray(mine) ? mine.filter(isRecent) : [] };
  };
  return {
    async list(address) {
      const store = await opened;
      return store ? (await read(store, address)).mine : [];
    },
    async remember(address, entry) {
      const store = await opened;
      if (!store) return;
      const { all, mine } = await read(store, address);
      await store.set("byEndpoint", { ...all, [address]: addRecent(mine, entry) });
      await store.save();
    },
  };
}

export const RECENT_DEPLOYS = new InjectionToken<RecentDeploys>("RecentDeploys", {
  providedIn: "root",
  factory: tauriRecentDeploys,
});

/** Asks for a file with the system dialog; null when the dialog is cancelled. */
export async function pickFile(title: string, extensions?: string[]): Promise<string | null> {
  const picked = await open({
    title,
    multiple: false,
    directory: false,
    filters: extensions ? [{ name: "Files", extensions }] : undefined,
  });
  return typeof picked === "string" ? picked : null;
}

/** The text of a Compose file for the read-only preview. */
export function previewComposeFile(path: string): Promise<string> {
  return invoke<string>("compose_preview", { path });
}

/** Validates the picked files and the project name and returns the project to deploy. */
export function deployProject(
  composeFile: string,
  envFile: string | null,
  name: string,
): Promise<ComposeProject> {
  return invoke<ComposeProject>("compose_deploy_project", { composeFile, envFile, name });
}
