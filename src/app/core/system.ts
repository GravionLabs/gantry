import type {
  CleanupCategory,
  CleanupPreview,
  CleanupResult,
  DiskUsage,
  Endpoint,
  SystemOverview,
} from "./bindings";
import { invoke } from "./invoke";
import { formatBytes } from "./stats";

export type {
  CleanupCategory,
  CleanupPreview,
  CleanupResult,
  DiskUsage,
  EngineDetails,
  SystemOverview,
} from "./bindings";

/** The categories in the order the view shows them. */
export const CATEGORIES: readonly CleanupCategory[] = [
  "containers",
  "images",
  "volumes",
  "buildCache",
];

const LABELS: Record<CleanupCategory, string> = {
  containers: "Containers",
  images: "Images",
  volumes: "Volumes",
  buildCache: "Build cache",
};

const SCOPES: Record<CleanupCategory, string> = {
  containers: "Stopped containers",
  images: "Dangling images (no tag, no container)",
  volumes: "Volumes no container uses, named ones included",
  buildCache: "Build cache records no build uses",
};

/** `Build cache`. */
export function categoryLabel(category: CleanupCategory): string {
  return LABELS[category];
}

/** What a cleanup of the category removes, in one line. */
export function categoryScope(category: CleanupCategory): string {
  return SCOPES[category];
}

/** Reads the engine information and the disk usage through `system_overview`. */
export function readOverview(endpoint: Endpoint): Promise<SystemOverview> {
  return invoke<SystemOverview>("system_overview", { endpoint });
}

/** Lists what a cleanup of the categories removes through `system_cleanup_preview`. */
export function previewCleanup(
  endpoint: Endpoint,
  categories: readonly CleanupCategory[],
): Promise<CleanupPreview[]> {
  return invoke<CleanupPreview[]>("system_cleanup_preview", { endpoint, categories });
}

/** Removes the unused data of the categories through `system_cleanup`. */
export function runCleanup(
  endpoint: Endpoint,
  categories: readonly CleanupCategory[],
): Promise<CleanupResult> {
  return invoke<CleanupResult>("system_cleanup", { endpoint, categories });
}

/** A size, or a dash when the engine does not report it. */
export function sizeOrDash(bytes: number | null): string {
  return bytes === null ? "–" : formatBytes(bytes);
}

/** `3 (1 active)`, or a dash when the engine does not report the count. */
export function countLabel(usage: Pick<DiskUsage, "totalCount" | "activeCount">): string {
  if (usage.totalCount === null) return "–";
  return usage.activeCount === null
    ? String(usage.totalCount)
    : `${usage.totalCount} (${usage.activeCount} active)`;
}

/** The share of the used space that a cleanup frees, 0 to 100; 0 without a size. */
export function reclaimablePercent(usage: Pick<DiskUsage, "size" | "reclaimable">): number {
  if (!usage.size || usage.reclaimable === null) return 0;
  return Math.min(100, Math.round((usage.reclaimable / usage.size) * 100));
}

/** `4 CPUs`, `1 CPU`, or a dash. */
export function cpuLabel(cpus: number | null): string {
  if (cpus === null) return "–";
  return `${cpus} ${cpus === 1 ? "CPU" : "CPUs"}`;
}

/** The size the preview of the selected categories frees, or null when none can tell. */
export function previewTotal(previews: readonly CleanupPreview[]): number | null {
  const known = previews.filter((p) => p.reclaimable !== null);
  return known.length === 0 ? null : known.reduce((sum, p) => sum + (p.reclaimable ?? 0), 0);
}

/** The bytes a finished cleanup freed. */
export function reclaimedTotal(result: CleanupResult): number {
  return result.outcomes.reduce((sum, o) => sum + (o.reclaimed ?? 0), 0);
}

/** `Freed 1.2 GB: 3 containers, 2 images.` plus one clause per failed category. */
export function cleanupSummary(result: CleanupResult): string {
  const parts = result.outcomes.map((o) => `${categoryLabel(o.category)} ${o.removed}`);
  const done = `Freed ${formatBytes(reclaimedTotal(result))}${parts.length ? ` (removed: ${parts.join(", ")})` : ""}.`;
  const failed = result.failures.map((f) => ` ${categoryLabel(f.category)} failed: ${f.message}`);
  return done + failed.join("");
}
