import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from "@angular/core";
import { HxButton, HxCheckbox, HxInput, HxMessage, HxSelectButton } from "@gravionlabs/helix-ui";
import { AgGridAngular } from "ag-grid-angular";
import type {
  ColDef,
  GetRowIdParams,
  GridApi,
  GridReadyEvent,
  RowClassRules,
  RowSelectionOptions,
  SelectionChangedEvent,
} from "ag-grid-community";

import type { Container } from "../core/bindings";
import { ContainerList } from "../core/container-list";
import {
  ACTION_KINDS,
  ACTION_LABEL,
  actionSeverity,
  ActionKind,
  SortKey,
  StateFilter,
  canApply,
  compareContainers,
  filterContainers,
  isLocalEndpoint,
  openLocalPort,
  runContainerAction,
  stateLabel,
} from "../core/containers";
import { EndpointStore } from "../core/endpoint-store";
import { toGantryError } from "../core/invoke";
import { ShellService } from "../core/shell/shell.service";
import { StatsFeed, formatMemory, formatPercent } from "../core/stats";
import {
  ContainerGridContext,
  ContainerNameCell,
  ContainerPortsCell,
  ContainerStateCell,
} from "../grid/cells";
import { GRID_MODULES, GRID_THEME } from "../grid/grid";
import { containerPortsTooltip } from "../grid/tooltips";

/** A container for which the last action failed, with the engine's message. */
export interface ActionFailure {
  readonly name: string;
  readonly message: string;
}

/** A sortable column that compares whole containers, so that a missing port or project stays last. */
function sortedBy(key: SortKey): Pick<ColDef<Container>, "comparator"> {
  return {
    comparator: (_a, _b, nodeA, nodeB, descending) =>
      nodeA.data && nodeB.data ? compareContainers(nodeA.data, nodeB.data, key, descending) : 0,
  };
}

const COLUMNS: ColDef<Container>[] = [
  {
    colId: "name",
    headerName: "Name",
    field: "name",
    cellRenderer: ContainerNameCell,
    sort: "asc",
    minWidth: 160,
    flex: 2,
    ...sortedBy("name"),
  },
  {
    colId: "image",
    headerName: "Image",
    field: "image",
    tooltip: true,
    minWidth: 160,
    flex: 3,
    ...sortedBy("image"),
  },
  {
    colId: "state",
    headerName: "State",
    // The cell refreshes only when its value changes: the value holds all it shows.
    valueGetter: (p) => (p.data ? `${stateLabel(p.data)} ${p.data.status}` : ""),
    cellRenderer: ContainerStateCell,
    width: 150,
    ...sortedBy("state"),
  },
  {
    colId: "ports",
    headerName: "Ports",
    field: "ports",
    cellRenderer: ContainerPortsCell,
    tooltip: containerPortsTooltip,
    cellDataType: false,
    minWidth: 140,
    flex: 2,
    ...sortedBy("ports"),
  },
  {
    colId: "created",
    headerName: "Created",
    field: "created",
    valueFormatter: (p) => (p.value ? new Date(p.value * 1000).toLocaleString() : ""),
    width: 170,
    ...sortedBy("created"),
  },
  {
    colId: "project",
    headerName: "Stack",
    field: "composeProject",
    valueFormatter: (p) => p.value ?? "–",
    width: 130,
    ...sortedBy("project"),
  },
];

const STATE_OPTIONS: readonly { label: string; value: StateFilter }[] = [
  { label: "All", value: "all" },
  { label: "Running", value: "running" },
  { label: "Exited", value: "exited" },
];

/** The Containers view: all containers of the active endpoint, kept current from the engine events. */
@Component({
  selector: "app-containers-view",
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AgGridAngular, HxButton, HxCheckbox, HxInput, HxMessage, HxSelectButton],
  providers: [ContainerList, StatsFeed],
  templateUrl: "./containers-view.html",
  styleUrl: "./containers-view.css",
})
export class ContainersView {
  protected readonly list = inject(ContainerList);
  private readonly endpoints = inject(EndpointStore);
  private readonly shell = inject(ShellService);
  protected readonly stats = inject(StatsFeed);

  protected readonly modules = GRID_MODULES;
  protected readonly theme = GRID_THEME;
  protected readonly stateOptions = STATE_OPTIONS;
  protected readonly filter = signal("");
  protected readonly stateFilter = signal<StateFilter>("all");

  /** The endpoint to show; a change of the active endpoint recreates the view, a retry restarts the watch. */
  private readonly endpoint = computed(() => this.endpoints.active()?.endpoint ?? null, {
    equal: (a, b) => a?.address === b?.address,
  });
  protected readonly local = computed(() => {
    const endpoint = this.endpoint();
    return endpoint !== null && isLocalEndpoint(endpoint);
  });

  /** The containers that match the filter; the grid sorts them. */
  protected readonly visible = computed(() =>
    filterContainers(this.list.containers(), this.filter(), this.stateFilter()),
  );

  /** The columns, with CPU and memory while the stats are shown. */
  protected readonly columnDefs = computed<ColDef<Container>[]>(() =>
    this.showStats()
      ? [
          ...COLUMNS,
          {
            colId: "cpu",
            headerName: "CPU",
            valueGetter: (p) => (p.data ? this.cpu(p.data) : ""),
            type: "rightAligned",
            width: 90,
            sortable: false,
          },
          {
            colId: "memory",
            headerName: "Memory",
            valueGetter: (p) => (p.data ? this.memory(p.data) : ""),
            type: "rightAligned",
            width: 150,
            sortable: false,
          },
        ]
      : COLUMNS,
  );
  protected readonly defaultColDef: ColDef<Container> = { resizable: true, sortable: true };
  protected readonly rowSelection: RowSelectionOptions<Container> = {
    mode: "multiRow",
    checkboxes: true,
    headerCheckbox: true,
    selectAll: "filtered",
    enableClickSelection: false,
  };
  protected readonly rowClassRules: RowClassRules<Container> = {
    busy: (p) => (p.data ? this.busy().has(p.data.id) : false),
  };
  protected readonly getRowId = (p: GetRowIdParams<Container>) => p.data.id;
  protected readonly context: ContainerGridContext = {
    details: (c) => this.shell.openContainer(c.id),
    openPort: (port) => void openLocalPort(port).catch(() => {}),
    local: () => this.local(),
  };
  private readonly grid = signal<GridApi<Container> | null>(null);

  /** Whether the CPU and memory columns are shown; they need one stats stream per running container. */
  protected readonly showStats = signal(false);
  /** Ids of the running containers in the list; empty while the columns are hidden. */
  private readonly statsIds = computed<ReadonlySet<string>>(
    () =>
      new Set(
        this.showStats()
          ? this.visible()
              .filter((c) => c.state === "running")
              .map((c) => c.id)
          : [],
      ),
    { equal: (a, b) => a.size === b.size && [...a].every((id) => b.has(id)) },
  );

  protected readonly actionKinds = ACTION_KINDS;
  protected readonly actionLabel = ACTION_LABEL;

  /** Ids of the selected containers; ids that left the list are ignored. */
  private readonly selectedIds = signal<ReadonlySet<string>>(new Set());
  protected readonly selected = computed(() =>
    this.list.containers().filter((c) => this.selectedIds().has(c.id)),
  );

  /** Ids of the containers an action is running for. */
  protected readonly busy = signal<ReadonlySet<string>>(new Set());
  /** What is running, e.g. `Stopping 2 of 3`; null when idle. */
  protected readonly progress = signal<string | null>(null);
  protected readonly failures = signal<readonly ActionFailure[]>([]);
  protected readonly summary = signal<string | null>(null);
  /** The containers a `remove` waits for confirmation for; null when there is no request. */
  protected readonly removal = signal<readonly Container[] | null>(null);
  protected readonly removeVolumes = signal(false);

  constructor() {
    effect(() => {
      const endpoint = this.endpoint();
      if (endpoint) untracked(() => this.list.start(endpoint));
    });
    effect(() => {
      const endpoint = this.endpoint();
      const ids = this.statsIds();
      untracked(() => (endpoint ? this.stats.track(endpoint, ids) : this.stats.clear()));
    });
    // The grid reads the samples and the busy ids through callbacks; redraw what depends on them.
    effect(() => {
      this.stats.samples();
      this.grid()?.refreshCells({ columns: ["cpu", "memory"] });
    });
    effect(() => {
      this.busy();
      this.grid()?.redrawRows();
    });
  }

  protected gridReady(event: GridReadyEvent<Container>): void {
    this.grid.set(event.api);
  }

  /** The grid goes when no container matches the filter; a selection nobody sees must not stay active. */
  protected gridDestroyed(): void {
    this.grid.set(null);
    this.selectedIds.set(new Set());
  }

  protected selectionChanged(event: SelectionChangedEvent<Container>): void {
    this.selectedIds.set(new Set(event.api.getSelectedRows().map((c) => c.id)));
  }

  protected setShowStats(event: Event): void {
    this.showStats.set((event.target as HTMLInputElement).checked);
  }

  private cpu(container: Container): string {
    const sample = this.stats.samples().get(container.id);
    return sample ? formatPercent(sample.cpuPercent) : "–";
  }

  private memory(container: Container): string {
    const sample = this.stats.samples().get(container.id);
    return sample ? formatMemory(sample) : "–";
  }

  protected setFilter(event: Event): void {
    this.filter.set((event.target as HTMLInputElement).value);
  }

  protected setStateFilter(value: unknown): void {
    this.stateFilter.set(value as StateFilter);
  }

  /** The selected containers an action applies to. */
  protected applicable(kind: ActionKind): readonly Container[] {
    return this.selected().filter((c) => canApply(kind, c.state));
  }

  protected disabled(kind: ActionKind): boolean {
    return this.progress() !== null || this.applicable(kind).length === 0;
  }

  protected severity(kind: ActionKind) {
    return actionSeverity(kind, !this.disabled(kind));
  }

  protected request(kind: ActionKind): void {
    const containers = this.applicable(kind);
    if (!containers.length) return;
    if (kind === "remove") {
      this.removeVolumes.set(false);
      this.removal.set(containers);
    } else {
      void this.run({ type: kind }, kind, containers);
    }
  }

  protected setRemoveVolumes(event: Event): void {
    this.removeVolumes.set((event.target as HTMLInputElement).checked);
  }

  protected cancelRemoval(): void {
    this.removal.set(null);
  }

  protected confirmRemoval(): void {
    const containers = this.removal();
    if (!containers) return;
    this.removal.set(null);
    void this.run({ type: "remove", volumes: this.removeVolumes() }, "remove", containers);
  }

  protected removalNames(): string {
    return (this.removal() ?? []).map((c) => c.name).join(", ");
  }

  private async run(
    action: Parameters<typeof runContainerAction>[1],
    kind: ActionKind,
    containers: readonly Container[],
  ): Promise<void> {
    const endpoint = this.endpoint();
    if (!endpoint) return;
    const names = new Map(containers.map((c) => [c.id, c.name]));
    const failures: ActionFailure[] = [];
    let done = 0;
    this.failures.set([]);
    this.summary.set(null);
    this.busy.set(new Set(containers.map((c) => c.id)));
    const report = () =>
      this.progress.set(`${ACTION_LABEL[kind]}: ${done} of ${containers.length} done`);
    report();
    try {
      await runContainerAction(
        endpoint,
        action,
        containers.map((c) => ({ id: c.id, name: c.name })),
        (event) => {
          if (event.type !== "finished") return;
          done++;
          this.busy.update((ids) => {
            const next = new Set(ids);
            next.delete(event.id);
            return next;
          });
          if (event.error !== null) {
            failures.push({ name: names.get(event.id) ?? event.id, message: event.error });
          }
          report();
        },
      );
      this.summary.set(
        failures.length
          ? null
          : `${ACTION_LABEL[kind]} succeeded for ${containers.length} container(s).`,
      );
    } catch (error) {
      // The command itself failed (e.g. the endpoint cannot be opened): it applies to all.
      for (const c of containers) {
        if (!failures.some((f) => f.name === c.name)) {
          failures.push({ name: c.name, message: toGantryError(error).message });
        }
      }
    } finally {
      this.failures.set(failures);
      this.busy.set(new Set());
      this.progress.set(null);
    }
  }

  protected dismissResult(): void {
    this.failures.set([]);
    this.summary.set(null);
  }
}
