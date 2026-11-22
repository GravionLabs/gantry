import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from "@angular/core";
import { HxButton, HxMessage, HxTable } from "@gravionlabs/helix-ui";
import { AgGridAngular } from "ag-grid-angular";
import type { ColDef, GetRowIdParams, RowClassRules } from "ag-grid-community";

import { pollRefresh } from "../core/settings/refresh-poll";
import type { ComposeAction, ComposeAvailability, Container, Stack } from "../core/bindings";
import { ContainerList } from "../core/container-list";
import { stateLabel } from "../core/containers";
import { EndpointStore } from "../core/endpoint-store";
import { toGantryError } from "../core/invoke";
import { ShellService } from "../core/shell/shell.service";
import {
  COMPOSE_ACTIONS,
  actionCommand,
  checkCompose,
  composeProject,
  finishedMessage,
  listStacks,
  runCompose,
  serviceCount,
  stackRows,
  stackSummary,
  toggleStack,
  type StackRow,
} from "../core/stacks";
import { StackGridContext, StackNameCell } from "../grid/cells";
import { GRID_MODULES, GRID_THEME } from "../grid/grid";
import { StackDeploy } from "./stack-deploy";

const COLUMNS: ColDef<StackRow>[] = [
  {
    colId: "name",
    headerName: "Stack",
    // The cell refreshes only when its value changes: the value holds all it shows.
    valueGetter: (p) =>
      p.data?.kind === "stack"
        ? `${p.data.stack.name} ${p.data.expanded}`
        : p.data
          ? `${p.data.container.name} ${p.data.container.state} ${p.data.container.health}`
          : "",
    cellRenderer: StackNameCell,
    minWidth: 200,
    flex: 2,
  },
  {
    colId: "services",
    headerName: "Services",
    valueGetter: (p) =>
      p.data?.kind === "stack" ? String(serviceCount(p.data.stack)) : (p.data?.service ?? ""),
    width: 140,
  },
  {
    colId: "image",
    headerName: "Image",
    valueGetter: (p) => (p.data?.kind === "container" ? p.data.container.image : ""),
    tooltip: true,
    minWidth: 160,
    flex: 2,
  },
  {
    colId: "state",
    headerName: "State",
    valueGetter: (p) =>
      p.data?.kind === "stack"
        ? stackSummary(p.data.stack)
        : p.data
          ? stateLabel(p.data.container)
          : "",
    width: 150,
  },
  {
    colId: "workingDir",
    headerName: "Working directory",
    valueGetter: (p) => (p.data?.kind === "stack" ? (p.data.stack.workingDir ?? "–") : ""),
    tooltip: true,
    cellClass: "mono",
    minWidth: 200,
    flex: 3,
  },
];

/**
 * The Stacks view: the Compose projects of the active endpoint. The stacks are read again whenever
 * the live container list changes.
 */
@Component({
  selector: "app-stacks-view",
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AgGridAngular, HxButton, HxMessage, HxTable, StackDeploy],
  providers: [ContainerList],
  templateUrl: "./stacks-view.html",
  styleUrl: "./stacks-view.css",
})
export class StacksView {
  private readonly list = inject(ContainerList);
  private readonly endpoints = inject(EndpointStore);
  private readonly shell = inject(ShellService);

  protected readonly endpoint = computed(() => this.endpoints.active()?.endpoint ?? null, {
    equal: (a, b) => a?.address === b?.address,
  });

  protected readonly stacks = signal<readonly Stack[]>([]);
  protected readonly loaded = signal(false);
  protected readonly problem = signal<string | null>(null);
  /** The name of the stack whose detail is shown; null for the list. */
  protected readonly selectedName = signal<string | null>(null);
  protected readonly selected = computed(
    () => this.stacks().find((s) => s.name === this.selectedName()) ?? null,
  );

  private readonly lastStack = signal<Stack | null>(null);
  /**
   * The stack the detail shows. `down` removes the stack, so the last known state stays visible
   * while a run is active or its outcome is unread.
   */
  protected readonly detail = computed(() => {
    const current = this.selected();
    if (current) return current;
    const last = this.lastStack();
    const busy = this.running() !== null || this.outcome() !== null;
    return last && last.name === this.selectedName() && busy ? last : null;
  });

  private requests = 0;

  /** The stacks whose containers are shown below them in the grid. */
  protected readonly expanded = signal<ReadonlySet<string>>(new Set());
  protected readonly rows = computed(() => stackRows(this.stacks(), this.expanded()));
  protected readonly modules = GRID_MODULES;
  protected readonly theme = GRID_THEME;
  protected readonly columnDefs = COLUMNS;
  protected readonly defaultColDef: ColDef<StackRow> = { resizable: true, sortable: false };
  protected readonly rowClassRules: RowClassRules<StackRow> = {
    child: (p) => p.data?.kind === "container",
  };
  protected readonly getRowId = (p: GetRowIdParams<StackRow>) => p.data.id;
  protected readonly context: StackGridContext = {
    toggle: (name) => this.expanded.update((names) => toggleStack(names, name)),
    openStack: (name) => this.selectedName.set(name),
    details: (container) => this.shell.openContainer(container.id),
  };

  /** True while the form for a new deployment is shown instead of the list. */
  protected readonly deploying = signal(false);

  protected readonly actions = COMPOSE_ACTIONS;
  /** Whether `docker compose` can act on the selected stack; null while it is being checked. */
  protected readonly availability = signal<ComposeAvailability | null>(null);
  /** The action that is running; null when idle. */
  protected readonly running = signal<ComposeAction | null>(null);
  /** The output of the last action. */
  protected readonly output = signal<readonly string[]>([]);
  protected readonly outcome = signal<string | null>(null);
  protected readonly failed = signal(false);
  /** True while `down` waits for confirmation. */
  protected readonly confirmingDown = signal(false);
  protected readonly removeVolumes = signal(false);
  protected readonly canAct = computed(() => this.availability()?.available === true);
  private stopRun: (() => void) | null = null;

  constructor() {
    // Poll at the interval of the settings; off leaves the engine events and the Refresh button.
    pollRefresh(() => this.list.reload());
    effect(() => {
      const endpoint = this.endpoint();
      if (endpoint) untracked(() => this.list.start(endpoint));
    });
    // A snapshot of the watch means that a container changed: read the stacks again.
    effect(() => {
      this.list.containers();
      if (this.list.phase() === "ready") untracked(() => void this.refresh());
    });
    effect(() => {
      const current = this.selected();
      if (current) this.lastStack.set(current);
    });
    // Check the plugin and the files whenever another stack is opened.
    effect(() => {
      const name = this.selectedName();
      const stack = untracked(() => this.selected());
      untracked(() => {
        this.availability.set(null);
        this.resetRun();
        if (name && stack) void this.check(stack);
      });
    });
    effect(() => {
      if (this.list.phase() === "error") this.problem.set(this.list.problem());
    });
  }

  private resetRun(): void {
    this.stopRun?.();
    this.stopRun = null;
    this.running.set(null);
    this.output.set([]);
    this.outcome.set(null);
    this.failed.set(false);
    this.confirmingDown.set(false);
    this.removeVolumes.set(false);
  }

  private async check(stack: Stack): Promise<void> {
    const name = stack.name;
    const result = await checkCompose(composeProject(stack)).catch(
      (error: unknown): ComposeAvailability => ({
        available: false,
        version: null,
        reason: toGantryError(error).message,
      }),
    );
    if (this.selectedName() === name) this.availability.set(result);
  }

  protected perform(action: ComposeAction): void {
    const endpoint = this.endpoint();
    const stack = this.selected();
    if (!endpoint || !stack || this.running() || !this.canAct()) return;
    this.confirmingDown.set(false);
    this.output.set([]);
    this.outcome.set(null);
    this.failed.set(false);
    this.running.set(action);
    const run = runCompose(endpoint, composeProject(stack), action, (event) => {
      if (event.type === "line") {
        this.output.update((lines) => [...lines, event.text]);
      } else {
        this.outcome.set(finishedMessage(action, event));
        this.failed.set(!event.success);
      }
    });
    this.stopRun = run.stop;
    run.done
      .catch((error: unknown) => {
        this.outcome.set(`${actionCommand(action)}: ${toGantryError(error).message}`);
        this.failed.set(true);
      })
      .finally(() => {
        if (this.stopRun === run.stop) {
          this.stopRun = null;
          this.running.set(null);
        }
      });
  }

  protected stop(): void {
    this.stopRun?.();
  }

  protected askDown(): void {
    this.removeVolumes.set(false);
    this.confirmingDown.set(true);
  }

  protected cancelDown(): void {
    this.confirmingDown.set(false);
  }

  protected setRemoveVolumes(event: Event): void {
    this.removeVolumes.set((event.target as HTMLInputElement).checked);
  }

  protected confirmDown(): void {
    this.perform({ type: "down", volumes: this.removeVolumes() });
  }

  protected retry(): void {
    this.list.retry();
    void this.refresh();
  }

  private async refresh(): Promise<void> {
    const endpoint = this.endpoint();
    if (!endpoint) return;
    const request = ++this.requests;
    try {
      const stacks = await listStacks(endpoint);
      if (request !== this.requests) return;
      this.stacks.set(stacks);
      this.problem.set(null);
    } catch (error) {
      if (request !== this.requests) return;
      this.problem.set(toGantryError(error).message);
    } finally {
      if (request === this.requests) this.loaded.set(true);
    }
  }

  protected summary = stackSummary;
  protected services = serviceCount;
  protected state(container: Container): string {
    return stateLabel(container);
  }

  protected startDeploy(): void {
    this.deploying.set(true);
  }

  protected endDeploy(result: { deployed: boolean }): void {
    this.deploying.set(false);
    if (result.deployed) void this.refresh();
  }

  protected back(): void {
    this.stopRun?.();
    this.selectedName.set(null);
  }

  protected details(event: Event, container: Container): void {
    event.preventDefault();
    this.shell.openContainer(container.id);
  }
}
