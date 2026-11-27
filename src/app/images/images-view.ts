import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
  untracked,
  DestroyRef,
  TemplateRef,
} from "@angular/core";
import {
  HxButton,
  HxCheckbox,
  HxConfirmationService,
  HxInput,
  HxMessage,
  HxProgressBar,
  HxSelectButton,
} from "@gravionlabs/helix-ui";
import { AgGridAngular } from "ag-grid-angular";
import type {
  ColDef,
  GetRowIdParams,
  RowClassRules,
  RowSelectionOptions,
  SelectionChangedEvent,
} from "ag-grid-community";

import { pollRefresh } from "../core/settings/refresh-poll";
import type { Image } from "../core/bindings";
import { ContainerList } from "../core/container-list";
import { EndpointStore } from "../core/endpoint-store";
import {
  EMPTY_PULL,
  applyPullEvent,
  filterImages,
  imageName,
  layerFraction,
  layerLabel,
  listImages,
  pruneCandidates,
  pruneImages,
  pruneSummary,
  pullImage,
  removeImage,
  removeSummary,
  shortId,
  usageLabel,
  type PullProgress,
} from "../core/images";
import { toGantryError } from "../core/invoke";
import { formatBytes } from "../core/stats";
import { USAGE_OPTIONS, countLabel, type UsageFilter } from "../core/usage-filter";
import { GRID_MODULES, GRID_THEME } from "../grid/grid";
import { imageIdTooltip, imageReferenceTooltip } from "../grid/tooltips";

/** Row ids must be unique: an image with several tags has a row per tag. */
function rowId(image: Image): string {
  return `${image.id}|${image.reference ?? ""}`;
}

const COLUMNS: ColDef<Image>[] = [
  {
    colId: "repository",
    headerName: "Repository",
    valueGetter: (p) => p.data?.repository ?? "<none>",
    tooltip: imageReferenceTooltip,
    minWidth: 180,
    flex: 2,
    sortable: true,
  },
  {
    colId: "tag",
    headerName: "Tag",
    valueGetter: (p) => p.data?.tag ?? "<none>",
    width: 140,
    sortable: true,
  },
  {
    colId: "id",
    headerName: "Image ID",
    valueGetter: (p) => (p.data ? shortId(p.data.id) : ""),
    tooltip: imageIdTooltip,
    cellClass: "mono",
    width: 130,
  },
  {
    colId: "size",
    headerName: "Size",
    field: "size",
    valueFormatter: (p) => formatBytes(p.value ?? 0),
    type: "rightAligned",
    width: 110,
    sortable: true,
  },
  {
    colId: "created",
    headerName: "Created",
    field: "created",
    valueFormatter: (p) => (p.value ? new Date(p.value * 1000).toLocaleString() : ""),
    width: 170,
    sortable: true,
  },
  {
    colId: "usage",
    headerName: "Usage",
    valueGetter: (p) => (p.data ? usageLabel(p.data.containers) : ""),
    minWidth: 160,
    flex: 1,
    comparator: (_a, _b, nodeA, nodeB) =>
      (nodeA.data?.containers ?? 0) - (nodeB.data?.containers ?? 0),
    sortable: true,
  },
  {
    colId: "dangling",
    headerName: "",
    valueGetter: (p) => (p.data?.dangling ? "dangling" : ""),
    cellClass: "dangling-cell",
    width: 100,
  },
];

/**
 * The Images view: the images of the active endpoint with pull, remove and prune. The list is read
 * again after every action and whenever the live container list changes, so that the number of
 * containers that use an image stays current.
 */
@Component({
  selector: "app-images-view",
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AgGridAngular, HxButton, HxCheckbox, HxInput, HxMessage, HxProgressBar, HxSelectButton],
  providers: [ContainerList],
  templateUrl: "./images-view.html",
  styleUrl: "./images-view.css",
})
export class ImagesView {
  private readonly list = inject(ContainerList);
  private readonly confirmation = inject(HxConfirmationService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly endpoints = inject(EndpointStore);

  protected readonly endpoint = computed(() => this.endpoints.active()?.endpoint ?? null, {
    equal: (a, b) => a?.address === b?.address,
  });

  protected readonly images = signal<Image[]>([]);
  protected readonly usageOptions = USAGE_OPTIONS;
  protected readonly usageFilter = signal<UsageFilter>("all");
  /** The images the usage filter lets through. */
  protected readonly visible = computed(() => filterImages(this.images(), this.usageFilter()));
  protected readonly count = computed(() =>
    countLabel(this.visible().length, this.images().length, this.usageFilter()),
  );
  protected readonly loaded = signal(false);
  protected readonly problem = signal<string | null>(null);
  private requests = 0;

  protected readonly modules = GRID_MODULES;
  protected readonly theme = GRID_THEME;
  protected readonly columnDefs = COLUMNS;
  protected readonly defaultColDef: ColDef<Image> = { resizable: true, sortable: false };
  protected readonly rowSelection: RowSelectionOptions<Image> = {
    mode: "singleRow",
    checkboxes: false,
    enableClickSelection: true,
  };
  protected readonly rowClassRules: RowClassRules<Image> = {
    dangling: (p) => p.data?.dangling === true,
  };
  protected readonly getRowId = (p: GetRowIdParams<Image>) => rowId(p.data);

  private readonly selectedRowId = signal<string | null>(null);
  protected readonly selected = computed(
    () => this.visible().find((i) => rowId(i) === this.selectedRowId()) ?? null,
  );

  /** The reference typed into the pull form. */
  protected readonly reference = signal("");
  /** The pull that runs; null when idle. */
  protected readonly pulling = signal<string | null>(null);
  protected readonly pullProgress = signal<PullProgress>(EMPTY_PULL);
  private stopPull: (() => void) | null = null;

  /** The option of the remove question. */
  protected readonly force = signal(false);
  /** What the last action did: a success text or an error. */
  protected readonly result = signal<{ text: string; failed: boolean } | null>(null);
  protected readonly busy = signal(false);

  protected readonly format = layerLabel;
  protected readonly fraction = layerFraction;

  constructor() {
    // Poll at the interval of the settings; off leaves the engine events and the Refresh button.
    pollRefresh(() => void this.refresh());
    effect(() => {
      const endpoint = this.endpoint();
      if (!endpoint) return;
      untracked(() => {
        this.cancelPull();
        this.images.set([]);
        this.loaded.set(false);
        this.list.start(endpoint);
      });
    });
    // A snapshot of the container watch means a container changed: read the images again.
    effect(() => {
      this.list.containers();
      if (this.list.phase() === "ready") untracked(() => void this.refresh());
    });
    effect(() => {
      if (this.list.phase() === "error") this.problem.set(this.list.problem());
    });
  }

  protected selectionChanged(event: SelectionChangedEvent<Image>): void {
    const [image] = event.api.getSelectedRows();
    this.selectedRowId.set(image ? rowId(image) : null);
  }

  protected setUsageFilter(value: unknown): void {
    this.usageFilter.set(value as UsageFilter);
    // A row the filter hides is no longer selected, also when the filter is lifted again.
    if (!this.selected()) this.selectedRowId.set(null);
  }

  protected retry(): void {
    this.list.retry();
    void this.refresh();
  }

  protected async refresh(): Promise<void> {
    const endpoint = this.endpoint();
    if (!endpoint) return;
    const request = ++this.requests;
    try {
      const images = await listImages(endpoint);
      if (request !== this.requests) return;
      this.images.set(images);
      this.problem.set(null);
    } catch (error) {
      if (request !== this.requests) return;
      this.problem.set(toGantryError(error).message);
    } finally {
      if (request === this.requests) this.loaded.set(true);
    }
  }

  protected setReference(event: Event): void {
    this.reference.set((event.target as HTMLInputElement).value);
  }

  protected pull(): void {
    const endpoint = this.endpoint();
    const reference = this.reference().trim();
    if (!endpoint || !reference || this.pulling()) return;
    this.result.set(null);
    this.pullProgress.set(EMPTY_PULL);
    this.pulling.set(reference);
    const run = pullImage(endpoint, reference, (event) =>
      this.pullProgress.update((progress) => applyPullEvent(progress, event)),
    );
    this.stopPull = run.stop;
    run.done
      .then((finished) => {
        if (!finished)
          return this.result.set({ text: `Pull of ${reference} cancelled.`, failed: false });
        this.result.set({ text: `Pulled ${reference}.`, failed: false });
        this.reference.set("");
      })
      .catch((error: unknown) =>
        this.result.set({
          text: `Cannot pull ${reference}: ${toGantryError(error).message}`,
          failed: true,
        }),
      )
      .finally(() => {
        if (this.stopPull === run.stop) {
          this.stopPull = null;
          this.pulling.set(null);
        }
        void this.refresh();
      });
  }

  protected cancelPull(): void {
    this.stopPull?.();
  }

  /** Asks, with `option` as the controls of the question, and removes the selected image. */
  protected async askRemove(option: TemplateRef<unknown>): Promise<void> {
    const endpoint = this.endpoint();
    const image = this.selected();
    if (!endpoint || !image) return;
    const name = imageName(image);
    this.force.set(false);
    const accepted = await this.confirmation.confirmAsync({
      header: `Remove ${name}?`,
      message: `This removes ${name} from the engine. A tagged image only loses this tag while other tags point to it.`,
      content: option,
      acceptLabel: "Remove",
      rejectLabel: "Cancel",
      acceptSeverity: "danger",
    });
    if (!accepted || !this.mayAct(endpoint)) return;
    this.busy.set(true);
    try {
      const outcome = await removeImage(endpoint, image.reference ?? image.id, this.force());
      this.result.set({ text: removeSummary(name, outcome), failed: false });
    } catch (error) {
      this.result.set({
        text: `Cannot remove ${name}: ${toGantryError(error).message}`,
        failed: true,
      });
    } finally {
      this.busy.set(false);
      void this.refresh();
    }
  }

  protected setForce(event: Event): void {
    this.force.set((event.target as HTMLInputElement).checked);
  }

  protected async askPrune(all: boolean): Promise<void> {
    const endpoint = this.endpoint();
    if (!endpoint) return;
    const images = pruneCandidates(this.images(), all);
    const size = formatBytes(images.reduce((sum, i) => sum + (i.size ?? 0), 0));
    const matches = images.length
      ? `This removes ${images.length} ${images.length === 1 ? "image" : "images"} (${size}): ${images.map(imageName).join(", ")}.`
      : "No image matches right now; the engine decides when it runs.";
    const rule = all
      ? "Every image that no container uses is removed, tagged or not."
      : "Only images without a tag are removed.";
    const accepted = await this.confirmation.confirmAsync({
      header: all ? "Remove all unused images?" : "Remove the dangling images?",
      message: `${matches} ${rule}`,
      acceptLabel: "Prune",
      rejectLabel: "Cancel",
      acceptSeverity: "danger",
    });
    if (!accepted || !this.mayAct(endpoint)) return;
    this.busy.set(true);
    try {
      const outcome = await pruneImages(endpoint, all);
      this.result.set({ text: pruneSummary(outcome), failed: false });
    } catch (error) {
      this.result.set({
        text: `Cannot prune the images: ${toGantryError(error).message}`,
        failed: true,
      });
    } finally {
      this.busy.set(false);
      void this.refresh();
    }
  }

  /** Whether an accepted question may still act: the view and its endpoint are the ones that asked. */
  private mayAct(endpoint: object): boolean {
    return !this.destroyRef.destroyed && this.endpoint() === endpoint && !this.busy();
  }

  protected dismissResult(): void {
    this.result.set(null);
  }
}
