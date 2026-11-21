import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from "@angular/core";
import { HxButton, HxCheckbox, HxMessage } from "@gravionlabs/helix-ui";

import type { CleanupCategory, CleanupPreview, DiskUsage, EngineDetails } from "../core/bindings";
import { EndpointStore } from "../core/endpoint-store";
import { toGantryError } from "../core/invoke";
import { formatBytes } from "../core/stats";
import {
  CATEGORIES,
  categoryLabel,
  categoryScope,
  cleanupSummary,
  countLabel,
  cpuLabel,
  previewCleanup,
  previewTotal,
  readOverview,
  reclaimablePercent,
  runCleanup,
  sizeOrDash,
} from "../core/system";

/** The System view: engine information, disk usage per category and a guided cleanup. */
@Component({
  selector: "app-system-view",
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HxButton, HxCheckbox, HxMessage],
  templateUrl: "./system-view.html",
  styleUrl: "./system-view.css",
})
export class SystemView {
  private readonly endpoints = inject(EndpointStore);

  protected readonly endpoint = computed(() => this.endpoints.active()?.endpoint ?? null, {
    equal: (a, b) => a?.address === b?.address,
  });

  protected readonly engine = signal<EngineDetails | null>(null);
  protected readonly usage = signal<DiskUsage[]>([]);
  protected readonly loaded = signal(false);
  protected readonly problem = signal<string | null>(null);
  private requests = 0;

  /** The cleanup dialog; null while closed. */
  protected readonly cleaning = signal<{
    selected: readonly CleanupCategory[];
    previews: readonly CleanupPreview[] | null;
    confirming: boolean;
  } | null>(null);
  protected readonly previewProblem = signal<string | null>(null);
  private previewRequests = 0;

  /** What the last cleanup did: a text and whether it failed in part or fully. */
  protected readonly result = signal<{ text: string; failed: boolean } | null>(null);
  protected readonly busy = signal(false);

  protected readonly categories = CATEGORIES;
  protected readonly categoryLabel = categoryLabel;
  protected readonly categoryScope = categoryScope;
  protected readonly countLabel = countLabel;
  protected readonly sizeOrDash = sizeOrDash;
  protected readonly percent = reclaimablePercent;

  protected readonly engineRows = computed(() => {
    const e = this.engine();
    if (!e) return [];
    return [
      { label: "Version", value: e.version ?? "–" },
      { label: "API version", value: e.apiVersion ?? "–" },
      { label: "Operating system", value: e.os ?? "–" },
      { label: "Architecture", value: e.arch ?? "–" },
      { label: "CPUs", value: cpuLabel(e.cpus) },
      { label: "Memory", value: e.memory === null ? "–" : formatBytes(e.memory) },
      { label: "Storage driver", value: e.storageDriver ?? "–" },
    ];
  });

  protected readonly totalSize = computed(() => {
    const sizes = this.usage().filter((u) => u.size !== null);
    return sizes.length === 0 ? null : sizes.reduce((sum, u) => sum + (u.size ?? 0), 0);
  });
  protected readonly totalReclaimable = computed(() => {
    const sizes = this.usage().filter((u) => u.reclaimable !== null);
    return sizes.length === 0 ? null : sizes.reduce((sum, u) => sum + (u.reclaimable ?? 0), 0);
  });

  protected readonly previewSize = computed(() => {
    const previews = this.cleaning()?.previews;
    return previews ? previewTotal(previews) : null;
  });
  protected readonly previewCount = computed(() =>
    (this.cleaning()?.previews ?? []).reduce((sum, p) => sum + p.count, 0),
  );

  constructor() {
    effect(() => {
      const endpoint = this.endpoint();
      if (!endpoint) return;
      untracked(() => {
        this.engine.set(null);
        this.usage.set([]);
        this.loaded.set(false);
        this.cleaning.set(null);
        this.result.set(null);
        void this.refresh();
      });
    });
  }

  protected async refresh(): Promise<void> {
    const endpoint = this.endpoint();
    if (!endpoint) return;
    const request = ++this.requests;
    try {
      const overview = await readOverview(endpoint);
      if (request !== this.requests) return;
      this.engine.set(overview.engine);
      this.usage.set(overview.usage);
      this.problem.set(null);
    } catch (error) {
      if (request !== this.requests) return;
      this.problem.set(toGantryError(error).message);
    } finally {
      if (request === this.requests) this.loaded.set(true);
    }
  }

  protected openCleanup(): void {
    this.previewProblem.set(null);
    this.cleaning.set({ selected: [], previews: null, confirming: false });
  }

  protected closeCleanup(): void {
    this.previewRequests++;
    this.cleaning.set(null);
  }

  protected isSelected(category: CleanupCategory): boolean {
    return this.cleaning()?.selected.includes(category) ?? false;
  }

  protected toggle(category: CleanupCategory, event: Event): void {
    const checked = (event.target as HTMLInputElement).checked;
    this.cleaning.update((state) => {
      if (!state) return state;
      const selected = checked
        ? CATEGORIES.filter((c) => c === category || state.selected.includes(c))
        : state.selected.filter((c) => c !== category);
      // The preview belongs to the selection it was made for.
      return { selected, previews: null, confirming: false };
    });
    this.previewProblem.set(null);
  }

  /** Reads what the selected categories remove, without removing anything. */
  protected async preview(): Promise<void> {
    const endpoint = this.endpoint();
    const state = this.cleaning();
    if (!endpoint || !state || state.selected.length === 0 || this.busy()) return;
    const request = ++this.previewRequests;
    this.busy.set(true);
    this.previewProblem.set(null);
    try {
      const previews = await previewCleanup(endpoint, state.selected);
      if (request !== this.previewRequests) return;
      this.cleaning.update((s) => (s ? { ...s, previews, confirming: true } : s));
    } catch (error) {
      if (request !== this.previewRequests) return;
      this.previewProblem.set(`Cannot preview the cleanup: ${toGantryError(error).message}`);
    } finally {
      if (request === this.previewRequests) this.busy.set(false);
    }
  }

  protected async confirm(): Promise<void> {
    const endpoint = this.endpoint();
    const state = this.cleaning();
    if (!endpoint || !state?.confirming || this.busy()) return;
    this.busy.set(true);
    try {
      const outcome = await runCleanup(endpoint, state.selected);
      this.result.set({ text: cleanupSummary(outcome), failed: outcome.failures.length > 0 });
    } catch (error) {
      this.result.set({
        text: `Cannot clean up: ${toGantryError(error).message}`,
        failed: true,
      });
    } finally {
      this.busy.set(false);
      this.cleaning.set(null);
      void this.refresh();
    }
  }

  protected dismissResult(): void {
    this.result.set(null);
  }
}
