import type { Endpoint, Label, Volume, VolumePruneOutcome, VolumeSpec } from "./bindings";
import { invoke } from "./invoke";
import { formatBytes } from "./stats";
import { matchesUsage, type UsageFilter } from "./usage-filter";

export type { Volume, VolumePruneOutcome, VolumeSpec } from "./bindings";

/** Lists the volumes of an endpoint through the Tauri command `volumes_list`. */
export function listVolumes(endpoint: Endpoint): Promise<Volume[]> {
  return invoke<Volume[]>("volumes_list", { endpoint });
}

/** Creates a volume through `volumes_create`. */
export function createVolume(endpoint: Endpoint, spec: VolumeSpec): Promise<void> {
  return invoke<void>("volumes_create", { endpoint, spec });
}

/** Removes a volume by name through `volumes_remove`. */
export function removeVolume(endpoint: Endpoint, name: string, force: boolean): Promise<void> {
  return invoke<void>("volumes_remove", { endpoint, name, force });
}

/** Removes every volume no container uses through `volumes_prune`. */
export function pruneVolumes(endpoint: Endpoint): Promise<VolumePruneOutcome> {
  return invoke<VolumePruneOutcome>("volumes_prune", { endpoint });
}

/**
 * Reads labels typed one `key=value` per line. Blank lines are skipped; a line without `=` is a
 * key with an empty value. Throws a message the form can show for a line without a key.
 */
export function parseLabels(text: string): Label[] {
  const labels: Label[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const at = line.indexOf("=");
    const key = (at < 0 ? line : line.slice(0, at)).trim();
    if (!key) throw new Error(`"${line}" has no label key`);
    labels.push({ key, value: at < 0 ? "" : line.slice(at + 1) });
  }
  return labels;
}

/** The size as the table shows it; a dash while the engine does not know it. */
export function sizeLabel(volume: Pick<Volume, "size">): string {
  return volume.size === null ? "–" : formatBytes(volume.size);
}

/** `in use by web, db`, or `unused`. */
export function volumeUsageLabel(containers: readonly string[]): string {
  return containers.length === 0 ? "unused" : `in use by ${containers.join(", ")}`;
}

/** The volumes that pass the usage filter. */
export function filterVolumes(volumes: readonly Volume[], usage: UsageFilter): Volume[] {
  return volumes.filter((v) => matchesUsage(usage, v.containers.length));
}

/** The volumes a prune removes: those no container mounts. */
export function pruneCandidates(volumes: readonly Volume[]): Volume[] {
  return volumes.filter((v) => v.containers.length === 0);
}

/** `Removed 3 volumes, 120 MiB reclaimed.` */
export function pruneSummary(outcome: VolumePruneOutcome): string {
  const count = `${outcome.removed.length} ${outcome.removed.length === 1 ? "volume" : "volumes"}`;
  return `Removed ${count}, ${formatBytes(outcome.reclaimed ?? 0)} reclaimed.`;
}
