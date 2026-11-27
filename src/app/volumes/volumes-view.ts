import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  inject,
  Injector,
  signal,
  untracked,
} from "@angular/core";
import {
  HxButton,
  HxCheckbox,
  HxField,
  HxInput,
  HxMessage,
  HxPopover,
  HxSelectButton,
} from "@gravionlabs/helix-ui";
import { AgGridAngular } from "ag-grid-angular";
import type {
  ColDef,
  GetRowIdParams,
  RowSelectionOptions,
  SelectionChangedEvent,
} from "ag-grid-community";

import { pollRefresh } from "../core/settings/refresh-poll";
import type { Volume } from "../core/bindings";
import { ContainerList } from "../core/container-list";
import { EndpointStore } from "../core/endpoint-store";
import { toGantryError } from "../core/invoke";
import { formatBytes } from "../core/stats";
import { USAGE_OPTIONS, countLabel, type UsageFilter } from "../core/usage-filter";
import {
  createVolume,
  filterVolumes,
  listVolumes,
  parseLabels,
  pruneCandidates,
  pruneSummary,
  pruneVolumes,
  removeVolume,
  sizeLabel,
  volumeUsageLabel,
} from "../core/volumes";
import { GRID_MODULES, GRID_THEME } from "../grid/grid";
import { volumeMountpointTooltip } from "../grid/tooltips";

const COLUMNS: ColDef<Volume>[] = [
  { colId: "name", headerName: "Name", field: "name", minWidth: 180, flex: 2, sortable: true },
  { colId: "driver", headerName: "Driver", field: "driver", width: 110, sortable: true },
  {
    colId: "mountpoint",
    headerName: "Mountpoint",
    field: "mountpoint",
    tooltip: volumeMountpointTooltip,
    cellClass: "mono",
    minWidth: 200,
    flex: 3,
  },
  {
    colId: "size",
    headerName: "Size",
    valueGetter: (p) => (p.data ? sizeLabel(p.data) : ""),
    comparator: (_a, _b, nodeA, nodeB) => (nodeA.data?.size ?? -1) - (nodeB.data?.size ?? -1),
    type: "rightAligned",
    width: 110,
    sortable: true,
  },
  {
    colId: "usage",
    headerName: "Used by",
    valueGetter: (p) => (p.data ? volumeUsageLabel(p.data.containers) : ""),
    minWidth: 160,
    flex: 2,
    comparator: (_a, _b, nodeA, nodeB) =>
      (nodeA.data?.containers.length ?? 0) - (nodeB.data?.containers.length ?? 0),
    sortable: true,
  },
];

/**
 * The Volumes view: the volumes of the active endpoint with create, remove and prune. The list is
 * read again after every action and whenever the live container list changes, so that the
 * containers that use a volume stay current.
 */
@Component({
  selector: "app-volumes-view",
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    AgGridAngular,
    HxButton,
    HxCheckbox,
    HxField,
    HxInput,
    HxMessage,
    HxPopover,
    HxSelectButton,
  ],
  providers: [ContainerList],
  templateUrl: "./volumes-view.html",
  styleUrl: "./volumes-view.css",
})
export class VolumesView {
  private readonly list = inject(ContainerList);
  private readonly endpoints = inject(EndpointStore);
  private readonly injector = inject(Injector);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly endpoint = computed(() => this.endpoints.active()?.endpoint ?? null, {
    equal: (a, b) => a?.address === b?.address,
  });

  protected readonly volumes = signal<Volume[]>([]);
  protected readonly usageOptions = USAGE_OPTIONS;
  protected readonly usageFilter = signal<UsageFilter>("all");
  /** The volumes the usage filter lets through. */
  protected readonly visible = computed(() => filterVolumes(this.volumes(), this.usageFilter()));
  protected readonly count = computed(() =>
    countLabel(this.visible().length, this.volumes().length, this.usageFilter()),
  );
  protected readonly loaded = signal(false);
  protected readonly problem = signal<string | null>(null);
  private requests = 0;

  protected readonly modules = GRID_MODULES;
  protected readonly theme = GRID_THEME;
  protected readonly columnDefs = COLUMNS;
  protected readonly defaultColDef: ColDef<Volume> = { resizable: true, sortable: false };
  protected readonly rowSelection: RowSelectionOptions<Volume> = {
    mode: "singleRow",
    checkboxes: false,
    enableClickSelection: true,
  };
  protected readonly getRowId = (p: GetRowIdParams<Volume>) => p.data.name;

  private readonly selectedName = signal<string | null>(null);
  protected readonly selected = computed(
    () => this.visible().find((v) => v.name === this.selectedName()) ?? null,
  );

  /** The create form; null while closed. */
  protected readonly creating = signal<{ name: string; driver: string; labels: string } | null>(
    null,
  );
  protected readonly createProblem = signal<string | null>(null);
  /** The problem, when the name is what it is about. */
  protected readonly nameError = computed(() =>
    this.creating()?.name.trim() === "" ? this.createProblem() : null,
  );
  /** The problem, when the labels are what it is about. */
  protected readonly labelsError = computed(() => {
    const form = this.creating();
    if (!form || this.nameError()) return null;
    try {
      parseLabels(form.labels);
      return null;
    } catch {
      return this.createProblem();
    }
  });
  /** A problem that belongs to no field, such as the refusal of the engine. */
  protected readonly formError = computed(() =>
    this.nameError() || this.labelsError() ? null : this.createProblem(),
  );

  protected readonly removal = signal<Volume | null>(null);
  protected readonly force = signal(false);
  protected readonly pruneRequest = signal<readonly Volume[] | null>(null);
  protected readonly pruneNames = computed(() =>
    (this.pruneRequest() ?? []).map((v) => v.name).join(", "),
  );
  protected readonly pruneSize = computed(() =>
    formatBytes((this.pruneRequest() ?? []).reduce((sum, v) => sum + (v.size ?? 0), 0)),
  );

  /** What the last action did: a success text or an error. */
  protected readonly result = signal<{ text: string; failed: boolean } | null>(null);
  protected readonly busy = signal(false);

  constructor() {
    // Poll at the interval of the settings; off leaves the engine events and the Refresh button.
    pollRefresh(() => void this.refresh());
    effect(() => {
      const endpoint = this.endpoint();
      if (!endpoint) return;
      untracked(() => {
        this.volumes.set([]);
        this.loaded.set(false);
        this.selectedName.set(null);
        this.list.start(endpoint);
      });
    });
    // A snapshot of the container watch means a container changed: read the volumes again.
    effect(() => {
      this.list.containers();
      if (this.list.phase() === "ready") untracked(() => void this.refresh());
    });
    effect(() => {
      if (this.list.phase() === "error") this.problem.set(this.list.problem());
    });
  }

  protected selectionChanged(event: SelectionChangedEvent<Volume>): void {
    const [volume] = event.api.getSelectedRows();
    this.selectedName.set(volume?.name ?? null);
  }

  protected setUsageFilter(value: unknown): void {
    this.usageFilter.set(value as UsageFilter);
    // A row the filter hides is no longer selected, also when the filter is lifted again.
    if (!this.selected()) this.selectedName.set(null);
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
      const volumes = await listVolumes(endpoint);
      if (request !== this.requests) return;
      this.volumes.set(volumes);
      this.problem.set(null);
    } catch (error) {
      if (request !== this.requests) return;
      this.problem.set(toGantryError(error).message);
    } finally {
      if (request === this.requests) this.loaded.set(true);
    }
  }

  protected toggleCreate(popover: HxPopover, event: Event): void {
    if (popover.open()) {
      popover.hide();
      return;
    }
    this.openCreate();
    popover.show(event);
  }

  protected openCreate(): void {
    this.createProblem.set(null);
    this.creating.set({ name: "", driver: "", labels: "" });
  }

  protected cancelCreate(): void {
    this.creating.set(null);
  }

  protected setField(field: "name" | "driver" | "labels", event: Event): void {
    const value = (event.target as HTMLInputElement | HTMLTextAreaElement).value;
    this.creating.update((form) => (form ? { ...form, [field]: value } : form));
    this.createProblem.set(null);
  }

  protected async confirmCreate(): Promise<void> {
    const endpoint = this.endpoint();
    const form = this.creating();
    if (!endpoint || !form || this.busy()) return;
    const name = form.name.trim();
    if (!name) {
      this.createProblem.set("A volume needs a name.");
      return;
    }
    let labels;
    try {
      labels = parseLabels(form.labels);
    } catch (error) {
      this.createProblem.set((error as Error).message);
      return;
    }
    this.busy.set(true);
    try {
      await createVolume(endpoint, { name, driver: form.driver.trim(), labels });
      this.result.set({ text: `Created volume ${name}.`, failed: false });
      this.creating.set(null);
    } catch (error) {
      this.createProblem.set(`Cannot create ${name}: ${toGantryError(error).message}`);
    } finally {
      this.busy.set(false);
      void this.refresh();
    }
  }

  /** Creates, then closes the popover on success or moves the focus to the field in error. */
  protected async submitCreate(popover: HxPopover, element: HTMLElement): Promise<void> {
    // A second Enter while creating changes nothing.
    if (this.busy()) return;
    await this.confirmCreate();
    if (this.destroyRef.destroyed) return;
    if (this.creating()) {
      const invalid = this.nameError() ? "name" : this.labelsError() ? "labels" : null;
      if (invalid) element.querySelector<HTMLElement>(`[name="${invalid}"]`)?.focus();
      return;
    }
    const problem = this.createProblem();
    if (problem) {
      // The popover was closed while creating: the refusal still has to be read.
      this.result.set({ text: problem, failed: true });
      return;
    }
    // After the render the toolbar button is enabled again and can take the focus back.
    afterNextRender(() => popover.hide(), { injector: this.injector });
  }

  protected askRemove(): void {
    const volume = this.selected();
    if (!volume) return;
    this.force.set(false);
    this.removal.set(volume);
  }

  protected cancelRemove(): void {
    this.removal.set(null);
  }

  protected setForce(event: Event): void {
    this.force.set((event.target as HTMLInputElement).checked);
  }

  protected async confirmRemove(): Promise<void> {
    const endpoint = this.endpoint();
    const volume = this.removal();
    if (!endpoint || !volume || this.busy()) return;
    this.busy.set(true);
    try {
      await removeVolume(endpoint, volume.name, this.force());
      this.result.set({ text: `Removed volume ${volume.name}.`, failed: false });
    } catch (error) {
      this.result.set({
        text: `Cannot remove ${volume.name}: ${toGantryError(error).message}`,
        failed: true,
      });
    } finally {
      this.busy.set(false);
      this.removal.set(null);
      void this.refresh();
    }
  }

  protected askPrune(): void {
    this.pruneRequest.set(pruneCandidates(this.volumes()));
  }

  protected cancelPrune(): void {
    this.pruneRequest.set(null);
  }

  protected async confirmPrune(): Promise<void> {
    const endpoint = this.endpoint();
    if (!endpoint || !this.pruneRequest() || this.busy()) return;
    this.busy.set(true);
    try {
      const outcome = await pruneVolumes(endpoint);
      this.result.set({ text: pruneSummary(outcome), failed: false });
    } catch (error) {
      this.result.set({
        text: `Cannot prune the volumes: ${toGantryError(error).message}`,
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
}
