import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
} from "@angular/core";
import { HxMessage } from "@gravionlabs/helix-ui";

import type { Endpoint } from "../core/bindings";
import { toGantryError } from "../core/invoke";
import {
  STATS_BACKEND,
  type Stats,
  formatBytes,
  formatMemory,
  formatPercent,
  memoryPercent,
  pushHistory,
  sparklinePoints,
} from "../core/stats";

const WIDTH = 160;
const HEIGHT = 32;

interface Metric {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  /** SVG points of the history. */
  readonly points: string;
}

/** Live CPU, memory, network and block I/O of one running container with a short history. */
@Component({
  selector: "app-container-stats",
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HxMessage],
  templateUrl: "./container-stats.html",
  styleUrl: "./container-stats.css",
})
export class ContainerStats {
  readonly endpoint = input.required<Endpoint>();
  readonly containerId = input.required<string>();
  /** Stats exist only for a running container. */
  readonly running = input(true);

  private readonly backend = inject(STATS_BACKEND);
  private stop: (() => void) | null = null;

  protected readonly width = WIDTH;
  protected readonly height = HEIGHT;
  protected readonly latest = signal<Stats | null>(null);
  protected readonly problem = signal<string | null>(null);
  private readonly cpu = signal<readonly number[]>([]);
  private readonly memory = signal<readonly number[]>([]);
  private readonly rx = signal<readonly number[]>([]);
  private readonly tx = signal<readonly number[]>([]);
  private readonly read = signal<readonly number[]>([]);
  private readonly write = signal<readonly number[]>([]);
  private previous: Stats | null = null;

  /** The rates are per second, from the counters of two readings. */
  protected readonly metrics = computed<readonly Metric[]>(() => {
    const s = this.latest();
    if (!s) return [];
    const memoryShare = memoryPercent(s);
    return [
      {
        id: "cpu",
        label: "CPU",
        value: formatPercent(s.cpuPercent),
        points: sparklinePoints(this.cpu(), WIDTH, HEIGHT, 100),
      },
      {
        id: "memory",
        label: "Memory",
        value: formatMemory(s) + (memoryShare === null ? "" : ` (${formatPercent(memoryShare)})`),
        points: sparklinePoints(this.memory(), WIDTH, HEIGHT, s.memoryLimit || undefined),
      },
      {
        id: "network-rx",
        label: "Network received",
        value: `${formatBytes(s.networkRx)} total`,
        points: sparklinePoints(this.rx(), WIDTH, HEIGHT),
      },
      {
        id: "network-tx",
        label: "Network sent",
        value: `${formatBytes(s.networkTx)} total`,
        points: sparklinePoints(this.tx(), WIDTH, HEIGHT),
      },
      {
        id: "block-read",
        label: "Block read",
        value: `${formatBytes(s.blockRead)} total`,
        points: sparklinePoints(this.read(), WIDTH, HEIGHT),
      },
      {
        id: "block-write",
        label: "Block written",
        value: `${formatBytes(s.blockWrite)} total`,
        points: sparklinePoints(this.write(), WIDTH, HEIGHT),
      },
    ];
  });

  constructor() {
    effect(() => {
      const endpoint = this.endpoint();
      const id = this.containerId();
      const running = this.running();
      untracked(() => this.start(endpoint, id, running));
    });
    inject(DestroyRef).onDestroy(() => this.close());
  }

  private close(): void {
    this.stop?.();
    this.stop = null;
  }

  private start(endpoint: Endpoint, id: string, running: boolean): void {
    this.close();
    this.latest.set(null);
    this.problem.set(null);
    this.previous = null;
    for (const history of [this.cpu, this.memory, this.rx, this.tx, this.read, this.write]) {
      history.set([]);
    }
    if (!running) return;
    this.stop = this.backend(
      endpoint,
      id,
      (sample) => this.onSample(sample),
      (error) => {
        this.stop = null;
        if (error) this.problem.set(toGantryError(error).message);
      },
    );
  }

  /** Histories of counters hold the change since the previous reading, so a flat line means idle. */
  private onSample(sample: Stats): void {
    const before = this.previous;
    const delta = (now: number, was: number | undefined) =>
      was === undefined ? 0 : Math.max(0, now - was);
    this.latest.set(sample);
    this.cpu.update((h) => pushHistory(h, sample.cpuPercent));
    this.memory.update((h) => pushHistory(h, sample.memoryUsage));
    this.rx.update((h) => pushHistory(h, delta(sample.networkRx, before?.networkRx)));
    this.tx.update((h) => pushHistory(h, delta(sample.networkTx, before?.networkTx)));
    this.read.update((h) => pushHistory(h, delta(sample.blockRead, before?.blockRead)));
    this.write.update((h) => pushHistory(h, delta(sample.blockWrite, before?.blockWrite)));
    this.previous = sample;
  }
}
