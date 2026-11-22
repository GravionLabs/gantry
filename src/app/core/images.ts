import type { Endpoint, Image, PruneOutcome, PullEvent, RemoveOutcome } from "./bindings";
import { invoke, stream } from "./invoke";
import { formatBytes } from "./stats";
import { matchesUsage, type UsageFilter } from "./usage-filter";

export type { Image, PruneOutcome, PullEvent, RemoveOutcome } from "./bindings";

/** Lists the images of an endpoint through the Tauri command `images_list`. */
export function listImages(endpoint: Endpoint): Promise<Image[]> {
  return invoke<Image[]>("images_list", { endpoint });
}

/** Removes an image by reference or ID through `images_remove`. */
export function removeImage(
  endpoint: Endpoint,
  target: string,
  force: boolean,
): Promise<RemoveOutcome> {
  return invoke<RemoveOutcome>("images_remove", { endpoint, target, force });
}

/** Removes the dangling images, or with `all` every image no container uses, through `images_prune`. */
export function pruneImages(endpoint: Endpoint, all: boolean): Promise<PruneOutcome> {
  return invoke<PruneOutcome>("images_prune", { endpoint, all });
}

/**
 * Pulls an image and streams the progress per layer. Resolves with `true` when the pull finished
 * and `false` when `stop` ended it early.
 */
export function pullImage(
  endpoint: Endpoint,
  reference: string,
  onEvent: (event: PullEvent) => void,
): { done: Promise<boolean>; stop: () => void } {
  const watchId = crypto.randomUUID();
  const done = stream<PullEvent, boolean>("images_pull", onEvent, { endpoint, reference, watchId });
  return { done, stop: () => void invoke("containers_unwatch", { watchId }).catch(() => {}) };
}

/** The state of one layer of a pull. */
export interface LayerProgress {
  readonly id: string;
  readonly status: string;
  readonly current: number | null;
  readonly total: number | null;
}

/** What a pull has reported so far: its status lines and its layers in the order they appeared. */
export interface PullProgress {
  readonly messages: readonly string[];
  readonly layers: readonly LayerProgress[];
}

export const EMPTY_PULL: PullProgress = { messages: [], layers: [] };

/** The progress with `event` applied; a layer keeps its last known size while its status changes. */
export function applyPullEvent(progress: PullProgress, event: PullEvent): PullProgress {
  if (event.type === "status") {
    return { ...progress, messages: [...progress.messages, event.message] };
  }
  const known = progress.layers.find((l) => l.id === event.id);
  const layer: LayerProgress = {
    id: event.id,
    status: event.status,
    current: event.current ?? known?.current ?? null,
    total: event.total ?? known?.total ?? null,
  };
  return {
    ...progress,
    layers: known
      ? progress.layers.map((l) => (l.id === event.id ? layer : l))
      : [...progress.layers, layer],
  };
}

/** `Downloading 12.5 MiB / 40 MiB`, or only the status while the size is unknown. */
export function layerLabel(layer: LayerProgress): string {
  const { status, current, total } = layer;
  if (current === null || total === null || total <= 0) return status;
  if (/complete|exists/i.test(status)) return status;
  return `${status} ${formatBytes(current)} / ${formatBytes(total)}`;
}

/** The share of a layer that is transferred, 0 to 1; null while its size is unknown. */
export function layerFraction(layer: LayerProgress): number | null {
  if (layer.current === null || layer.total === null || layer.total <= 0) return null;
  return Math.min(1, layer.current / layer.total);
}

/** The ID as the CLI shows it: twelve characters without the `sha256:` prefix. */
export function shortId(id: string): string {
  return id.replace(/^sha256:/, "").slice(0, 12);
}

/** `repository:tag`, or `<none>` for a dangling image. */
export function imageName(image: Pick<Image, "reference" | "id">): string {
  return image.reference ?? `<none> (${shortId(image.id)})`;
}

/** `in use by 2 containers`, or `unused`. */
export function usageLabel(containers: number): string {
  if (containers === 0) return "unused";
  return `in use by ${containers} ${containers === 1 ? "container" : "containers"}`;
}

/** The images that pass the usage filter. */
export function filterImages(images: readonly Image[], usage: UsageFilter): Image[] {
  return images.filter((i) => matchesUsage(usage, i.containers));
}

/** The images a prune would remove, each image once: the dangling ones, or with `all` every unused one. */
export function pruneCandidates(images: readonly Image[], all: boolean): Image[] {
  const tagged = new Set(images.filter((i) => !i.dangling).map((i) => i.id));
  const seen = new Set<string>();
  return images.filter((image) => {
    const wanted = all ? image.containers === 0 : image.dangling && !tagged.has(image.id);
    if (!wanted || seen.has(image.id)) return false;
    seen.add(image.id);
    return true;
  });
}

/** `Removed 3 images, 120 MiB reclaimed.` */
export function pruneSummary(outcome: PruneOutcome): string {
  const count = `${outcome.removed} ${outcome.removed === 1 ? "image" : "images"}`;
  return `Removed ${count}, ${formatBytes(outcome.reclaimed ?? 0)} reclaimed.`;
}

/** What removing an image reported, e.g. `Removed nginx:latest.` */
export function removeSummary(name: string, outcome: RemoveOutcome): string {
  const layers = outcome.deleted.length;
  return layers > 0
    ? `Removed ${name} (${layers} ${layers === 1 ? "layer" : "layers"} deleted).`
    : `Removed ${name}.`;
}
