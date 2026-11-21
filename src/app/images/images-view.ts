import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from "@angular/core";
import { HxButton, HxCheckbox, HxInput, HxMessage } from "@gravionlabs/helix-ui";
import { AgGridAngular } from "ag-grid-angular";
import type {
  ColDef,
  GetRowIdParams,
  RowClassRules,
  RowSelectionOptions,
  SelectionChangedEvent,
} from "ag-grid-community";

import type { Image } from "../core/bindings";
import { ContainerList } from "../core/container-list";
import { EndpointStore } from "../core/endpoint-store";
import {
  EMPTY_PULL,
  applyPullEvent,
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
import { GRID_MODULES, GRID_THEME } from "../grid/grid";

/** Row ids must be unique: an image with several tags has a row per tag. */
function rowId(image: Image): string {
  return `${image.id}|${image.reference ?? ""}`;
}

const COLUMNS: ColDef<Image>[] = [
  {
    colId: "repository",
    headerName: "Repository",
    valueGetter: (p) => p.data?.repository ?? "<none>",
    tooltipValueGetter: (p) => p.data?.reference ?? p.data?.id,
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
    tooltipValueGetter: (p) => p.data?.id,
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

/** A prune that waits for the user's confirmation. */
interface PruneRequest {
  readonly all: boolean;
  readonly images: readonly Image[];
}

/**
 * The Images view: the images of the active endpoint with pull, remove and prune. The list is read
 * again after every action and whenever the live container list changes, so that the number of
 * containers that use an image stays current.
 */
@Component({
  selector: "app-images-view",
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AgGridAngular, HxButton, HxCheckbox, HxInput, HxMessage],
  providers: [ContainerList],
  templateUrl: "./images-view.html",
  styleUrl: "./images-view.css",
})
export class ImagesView {
  private readonly list = inject(ContainerList);
  private readonly endpoints = inject(EndpointStore);

  protected readonly endpoint = computed(() => this.endpoints.active()?.endpoint ?? null, {
    equal: (a, b) => a?.address === b?.address,
  });

  protected readonly images = signal<Image[]>([]);
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
    () => this.images().find((i) => rowId(i) === this.selectedRowId()) ?? null,
  );

  /** The reference typed into the pull form. */
  protected readonly reference = signal("");
  /** The pull that runs; null when idle. */
  protected readonly pulling = signal<string | null>(null);
  protected readonly pullProgress = signal<PullProgress>(EMPTY_PULL);
  private stopPull: (() => void) | null = null;

  /** The image whose removal waits for confirmation. */
  protected readonly removal = signal<Image | null>(null);
  protected readonly force = signal(false);
  protected readonly pruneRequest = signal<PruneRequest | null>(null);
  protected readonly pruneNames = computed(() =>
    (this.pruneRequest()?.images ?? []).map(imageName).join(", "),
  );
  protected readonly pruneSize = computed(() =>
    formatBytes((this.pruneRequest()?.images ?? []).reduce((sum, i) => sum + (i.size ?? 0), 0)),
  );

  /** What the last action did: a success text or an error. */
  protected readonly result = signal<{ text: string; failed: boolean } | null>(null);
  protected readonly busy = signal(false);

  protected readonly format = layerLabel;
  protected readonly fraction = layerFraction;

  constructor() {
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

  protected askRemove(): void {
    const image = this.selected();
    if (!image) return;
    this.force.set(false);
    this.removal.set(image);
  }

  protected cancelRemove(): void {
    this.removal.set(null);
  }

  protected setForce(event: Event): void {
    this.force.set((event.target as HTMLInputElement).checked);
  }

  protected async confirmRemove(): Promise<void> {
    const endpoint = this.endpoint();
    const image = this.removal();
    if (!endpoint || !image || this.busy()) return;
    const name = imageName(image);
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
      this.removal.set(null);
      void this.refresh();
    }
  }

  protected askPrune(all: boolean): void {
    this.pruneRequest.set({ all, images: pruneCandidates(this.images(), all) });
  }

  protected cancelPrune(): void {
    this.pruneRequest.set(null);
  }

  protected async confirmPrune(): Promise<void> {
    const endpoint = this.endpoint();
    const request = this.pruneRequest();
    if (!endpoint || !request || this.busy()) return;
    this.busy.set(true);
    try {
      const outcome = await pruneImages(endpoint, request.all);
      this.result.set({ text: pruneSummary(outcome), failed: false });
    } catch (error) {
      this.result.set({
        text: `Cannot prune the images: ${toGantryError(error).message}`,
        failed: true,
      });
    } finally {
      this.busy.set(false);
      this.pruneRequest.set(null);
      void this.refresh();
    }
  }

  protected dismissResult(): void {
    this.result.set(null);
  }

  protected name = imageName;
}
