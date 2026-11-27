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
import { HxButton, HxField, HxInput, HxMessage, HxPopover, HxSelect } from "@gravionlabs/helix-ui";
import { AgGridAngular } from "ag-grid-angular";
import type {
  ColDef,
  GetRowIdParams,
  RowSelectionOptions,
  SelectionChangedEvent,
} from "ag-grid-community";

import { pollRefresh } from "../core/settings/refresh-poll";
import type { Network } from "../core/bindings";
import { ContainerList } from "../core/container-list";
import { EndpointStore } from "../core/endpoint-store";
import { toGantryError } from "../core/invoke";
import {
  connectable,
  connectedLabel,
  connectNetwork,
  createNetwork,
  disconnectNetwork,
  listNetworks,
  pruneCandidates,
  pruneNetworks,
  pruneSummary,
  removeNetwork,
  subnetLabel,
} from "../core/networks";
import { GRID_MODULES, GRID_THEME } from "../grid/grid";

const COLUMNS: ColDef<Network>[] = [
  { colId: "name", headerName: "Name", field: "name", minWidth: 160, flex: 2, sortable: true },
  { colId: "driver", headerName: "Driver", field: "driver", width: 110, sortable: true },
  { colId: "scope", headerName: "Scope", field: "scope", width: 100, sortable: true },
  {
    colId: "subnet",
    headerName: "Subnet",
    valueGetter: (p) => (p.data ? subnetLabel(p.data) : ""),
    cellClass: "mono",
    minWidth: 160,
    flex: 2,
    sortable: true,
  },
  {
    colId: "containers",
    headerName: "Containers",
    valueGetter: (p) => (p.data ? connectedLabel(p.data.containers) : ""),
    tooltip: (p) => (p.data ? connectedLabel(p.data.containers) : ""),
    minWidth: 180,
    flex: 3,
    comparator: (_a, _b, nodeA, nodeB) =>
      (nodeA.data?.containers.length ?? 0) - (nodeB.data?.containers.length ?? 0),
    sortable: true,
  },
];

/**
 * The Networks view: the networks of the active endpoint with create, remove, prune and the
 * connection of containers. The list is read again after every action and whenever the live
 * container list changes, so that the connected containers stay current.
 */
@Component({
  selector: "app-networks-view",
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AgGridAngular, HxButton, HxField, HxInput, HxMessage, HxPopover, HxSelect],
  providers: [ContainerList],
  templateUrl: "./networks-view.html",
  styleUrl: "./networks-view.css",
})
export class NetworksView {
  private readonly list = inject(ContainerList);
  private readonly endpoints = inject(EndpointStore);
  private readonly injector = inject(Injector);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly endpoint = computed(() => this.endpoints.active()?.endpoint ?? null, {
    equal: (a, b) => a?.address === b?.address,
  });

  protected readonly networks = signal<Network[]>([]);
  protected readonly loaded = signal(false);
  protected readonly problem = signal<string | null>(null);
  private requests = 0;

  protected readonly modules = GRID_MODULES;
  protected readonly theme = GRID_THEME;
  protected readonly columnDefs = COLUMNS;
  protected readonly defaultColDef: ColDef<Network> = { resizable: true, sortable: false };
  protected readonly rowSelection: RowSelectionOptions<Network> = {
    mode: "singleRow",
    checkboxes: false,
    enableClickSelection: true,
  };
  protected readonly getRowId = (p: GetRowIdParams<Network>) => p.data.id;

  private readonly selectedId = signal<string | null>(null);
  protected readonly selected = computed(
    () => this.networks().find((n) => n.id === this.selectedId()) ?? null,
  );
  /** The containers that can be connected to the selected network. */
  protected readonly attachable = computed(() => {
    const network = this.selected();
    return network ? connectable(network, this.list.containers()) : [];
  });
  protected readonly toConnect = signal("");

  /** The create form; null while closed. */
  protected readonly creating = signal<{ name: string; subnet: string } | null>(null);
  protected readonly createProblem = signal<string | null>(null);
  /** The problem, when the name is what it is about. */
  protected readonly nameError = computed(() =>
    this.creating()?.name.trim() === "" ? this.createProblem() : null,
  );
  /** A problem that belongs to no field, such as the refusal of the engine. */
  protected readonly formError = computed(() => (this.nameError() ? null : this.createProblem()));

  protected readonly removal = signal<Network | null>(null);
  protected readonly pruneRequest = signal<readonly Network[] | null>(null);
  protected readonly pruneNames = computed(() =>
    (this.pruneRequest() ?? []).map((n) => n.name).join(", "),
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
        this.networks.set([]);
        this.loaded.set(false);
        this.selectedId.set(null);
        this.list.start(endpoint);
      });
    });
    // A snapshot of the container watch means a container changed: read the networks again.
    effect(() => {
      this.list.containers();
      if (this.list.phase() === "ready") untracked(() => void this.refresh());
    });
    effect(() => {
      if (this.list.phase() === "error") this.problem.set(this.list.problem());
    });
  }

  protected selectionChanged(event: SelectionChangedEvent<Network>): void {
    const [network] = event.api.getSelectedRows();
    this.selectedId.set(network?.id ?? null);
    this.toConnect.set("");
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
      const networks = await listNetworks(endpoint);
      if (request !== this.requests) return;
      this.networks.set(networks);
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
    this.creating.set({ name: "", subnet: "" });
  }

  protected cancelCreate(): void {
    this.creating.set(null);
  }

  protected setField(field: "name" | "subnet", event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.creating.update((form) => (form ? { ...form, [field]: value } : form));
    this.createProblem.set(null);
  }

  protected async confirmCreate(): Promise<void> {
    const endpoint = this.endpoint();
    const form = this.creating();
    if (!endpoint || !form || this.busy()) return;
    const name = form.name.trim();
    if (!name) {
      this.createProblem.set("A network needs a name.");
      return;
    }
    this.busy.set(true);
    try {
      await createNetwork(endpoint, { name, subnet: form.subnet.trim() });
      this.result.set({ text: `Created network ${name}.`, failed: false });
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
      if (this.nameError()) element.querySelector<HTMLElement>('[name="name"]')?.focus();
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
    const network = this.selected();
    if (network) this.removal.set(network);
  }

  protected cancelRemove(): void {
    this.removal.set(null);
  }

  protected async confirmRemove(): Promise<void> {
    const endpoint = this.endpoint();
    const network = this.removal();
    if (!endpoint || !network || this.busy()) return;
    this.busy.set(true);
    try {
      await removeNetwork(endpoint, network.id);
      this.result.set({ text: `Removed network ${network.name}.`, failed: false });
    } catch (error) {
      this.result.set({
        text: `Cannot remove ${network.name}: ${toGantryError(error).message}`,
        failed: true,
      });
    } finally {
      this.busy.set(false);
      this.removal.set(null);
      void this.refresh();
    }
  }

  protected askPrune(): void {
    this.pruneRequest.set(pruneCandidates(this.networks()));
  }

  protected cancelPrune(): void {
    this.pruneRequest.set(null);
  }

  protected async confirmPrune(): Promise<void> {
    const endpoint = this.endpoint();
    if (!endpoint || !this.pruneRequest() || this.busy()) return;
    this.busy.set(true);
    try {
      const outcome = await pruneNetworks(endpoint);
      this.result.set({ text: pruneSummary(outcome), failed: false });
    } catch (error) {
      this.result.set({
        text: `Cannot prune the networks: ${toGantryError(error).message}`,
        failed: true,
      });
    } finally {
      this.busy.set(false);
      this.pruneRequest.set(null);
      void this.refresh();
    }
  }

  /** Null is the cleared select. */
  protected setToConnect(value: unknown): void {
    this.toConnect.set(typeof value === "string" ? value : "");
  }

  protected async connect(): Promise<void> {
    const endpoint = this.endpoint();
    const network = this.selected();
    const container = this.toConnect();
    if (!endpoint || !network || !container || this.busy()) return;
    this.busy.set(true);
    try {
      await connectNetwork(endpoint, network.id, container);
      this.result.set({ text: `Connected ${container} to ${network.name}.`, failed: false });
      this.toConnect.set("");
    } catch (error) {
      this.result.set({
        text: `Cannot connect ${container} to ${network.name}: ${toGantryError(error).message}`,
        failed: true,
      });
    } finally {
      this.busy.set(false);
      void this.refresh();
    }
  }

  protected async disconnect(container: string): Promise<void> {
    const endpoint = this.endpoint();
    const network = this.selected();
    if (!endpoint || !network || this.busy()) return;
    this.busy.set(true);
    try {
      await disconnectNetwork(endpoint, network.id, container, false);
      this.result.set({
        text: `Disconnected ${container} from ${network.name}.`,
        failed: false,
      });
    } catch (error) {
      this.result.set({
        text: `Cannot disconnect ${container} from ${network.name}: ${toGantryError(error).message}`,
        failed: true,
      });
    } finally {
      this.busy.set(false);
      void this.refresh();
    }
  }

  protected dismissResult(): void {
    this.result.set(null);
  }
}
