import { DestroyRef, Injectable, InjectionToken, inject, signal } from "@angular/core";

import type { Endpoint, StatsEvent, StatsSample } from "./bindings";
import { invoke, stream } from "./invoke";

/** A reading with every value a number (the IPC type allows `null` for a non-finite float). */
export type Stats = { readonly [K in keyof StatsSample]: number };

/** Replaces the `null` of a non-finite value with 0. */
export function normalizeSample(sample: StatsSample): Stats {
  const entries = Object.entries(sample).map(([k, v]) => [k, v ?? 0]);
  return Object.fromEntries(entries) as Stats;
}

/** Number of readings kept for a sparkline (about one per second). */
export const HISTORY_LENGTH = 60;

/**
 * Streams the resource stats of a container: a sample about every second. `onEnd` runs when the
 * stream ends on its own (the container stopped, or an error such as a missing container).
 */
export function streamContainerStats(
  endpoint: Endpoint,
  id: string,
  onSample: (sample: Stats) => void,
  onEnd: (error: unknown) => void,
): () => void {
  const watchId = crypto.randomUUID();
  let stopped = false;
  stream<StatsEvent>(
    "containers_stats",
    (event) => {
      if (!stopped && event.type === "sample") onSample(normalizeSample(event.sample));
    },
    { endpoint, id, watchId },
  ).then(
    () => {
      if (!stopped) onEnd(null);
    },
    (error: unknown) => {
      if (!stopped) onEnd(error);
    },
  );
  return () => {
    if (stopped) return;
    stopped = true;
    void invoke("containers_unwatch", { watchId }).catch(() => {});
  };
}

/** The stats stream the feed uses; replaced by a fake in tests. */
export type StatsBackend = typeof streamContainerStats;

export const STATS_BACKEND = new InjectionToken<StatsBackend>("StatsBackend", {
  providedIn: "root",
  factory: () => streamContainerStats,
});

/** Appends `value`, keeping the last `max` values. */
export function pushHistory(
  history: readonly number[],
  value: number,
  max = HISTORY_LENGTH,
): number[] {
  const next = [...history, value];
  return next.length > max ? next.slice(next.length - max) : next;
}

/** The points of an SVG polyline for `values`, scaled into `width` x `height`; empty for no data. */
export function sparklinePoints(
  values: readonly number[],
  width: number,
  height: number,
  ceiling?: number,
): string {
  if (values.length === 0) return "";
  const max = Math.max(ceiling ?? 0, ...values, Number.EPSILON);
  const step = values.length > 1 ? width / (values.length - 1) : 0;
  return values.map((v, i) => `${round(i * step)},${round(height - (v / max) * height)}`).join(" ");
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}

const UNITS = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"] as const;

/** Bytes with a binary unit, like `docker stats` (`12.5MiB`, but spaced). */
export function formatBytes(bytes: number): string {
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  const digits = unit === 0 || value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${UNITS[unit]}`;
}

export function formatPercent(percent: number): string {
  return `${percent.toFixed(percent >= 100 ? 0 : 1)} %`;
}

/** Memory use against the limit as a percentage; null without a limit. */
export function memoryPercent(sample: Stats): number | null {
  return sample.memoryLimit > 0 ? (sample.memoryUsage / sample.memoryLimit) * 100 : null;
}

/** `usage / limit`, or only the usage when there is no limit. */
export function formatMemory(sample: Stats): string {
  const usage = formatBytes(sample.memoryUsage);
  return sample.memoryLimit > 0 ? `${usage} / ${formatBytes(sample.memoryLimit)}` : usage;
}

/**
 * The live stats of the containers a list shows: one stream per id, started when the id appears
 * and stopped when it leaves. Provide it in the component that shows the list; all streams stop
 * when that component is destroyed.
 */
@Injectable()
export class StatsFeed {
  private readonly backend = inject(STATS_BACKEND);
  private readonly streams = new Map<string, () => void>();
  private endpoint: Endpoint | null = null;

  /** The latest sample per container id. */
  readonly samples = signal<ReadonlyMap<string, Stats>>(new Map());

  constructor() {
    inject(DestroyRef).onDestroy(() => this.clear());
  }

  /** Makes `ids` the containers with a stream on `endpoint`. */
  track(endpoint: Endpoint, ids: ReadonlySet<string>): void {
    if (this.endpoint?.address !== endpoint.address) this.clear();
    this.endpoint = endpoint;
    for (const [id, stop] of this.streams) {
      if (!ids.has(id)) {
        stop();
        this.streams.delete(id);
        this.drop(id);
      }
    }
    for (const id of ids) {
      if (this.streams.has(id)) continue;
      this.streams.set(
        id,
        this.backend(
          endpoint,
          id,
          (sample) => this.samples.update((m) => new Map(m).set(id, sample)),
          () => {
            // The container stopped or vanished; a new stream starts when it is tracked again.
            this.streams.delete(id);
            this.drop(id);
          },
        ),
      );
    }
  }

  /** Stops every stream. */
  clear(): void {
    for (const stop of this.streams.values()) stop();
    this.streams.clear();
    this.samples.set(new Map());
    this.endpoint = null;
  }

  private drop(id: string): void {
    this.samples.update((m) => {
      if (!m.has(id)) return m;
      const next = new Map(m);
      next.delete(id);
      return next;
    });
  }
}
