import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from "@angular/core";
import { HxButton, HxInput, HxMessage, HxTable } from "@gravionlabs/helix-ui";

import type { Container } from "../core/bindings";
import { ContainerList } from "../core/container-list";
import {
  ACTION_KINDS,
  ACTION_LABEL,
  ActionKind,
  SortDirection,
  SortKey,
  StateFilter,
  canApply,
  filterContainers,
  isLocalEndpoint,
  openLocalPort,
  portLabel,
  runContainerAction,
  sortContainers,
  stateLabel,
} from "../core/containers";
import { EndpointStore } from "../core/endpoint-store";
import { toGantryError } from "../core/invoke";

/** A container for which the last action failed, with the engine's message. */
export interface ActionFailure {
  readonly name: string;
  readonly message: string;
}

interface Column {
  readonly key: SortKey;
  readonly label: string;
}

const COLUMNS: readonly Column[] = [
  { key: "name", label: "Name" },
  { key: "image", label: "Image" },
  { key: "state", label: "State" },
  { key: "ports", label: "Ports" },
  { key: "created", label: "Created" },
  { key: "project", label: "Compose project" },
];

/** The Containers view: all containers of the active endpoint, kept current from the engine events. */
@Component({
  selector: "app-containers-view",
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HxButton, HxInput, HxMessage, HxTable],
  providers: [ContainerList],
  templateUrl: "./containers-view.html",
  styleUrl: "./containers-view.css",
})
export class ContainersView {
  protected readonly list = inject(ContainerList);
  private readonly endpoints = inject(EndpointStore);

  protected readonly columns = COLUMNS;
  protected readonly filter = signal("");
  protected readonly stateFilter = signal<StateFilter>("all");
  protected readonly sortKey = signal<SortKey>("name");
  protected readonly sortDirection = signal<SortDirection>("asc");

  /** The endpoint to show; a change of the active endpoint recreates the view, a retry restarts the watch. */
  private readonly endpoint = computed(() => this.endpoints.active()?.endpoint ?? null, {
    equal: (a, b) => a?.address === b?.address,
  });
  protected readonly local = computed(() => {
    const endpoint = this.endpoint();
    return endpoint !== null && isLocalEndpoint(endpoint);
  });

  protected readonly visible = computed(() =>
    sortContainers(
      filterContainers(this.list.containers(), this.filter(), this.stateFilter()),
      this.sortKey(),
      this.sortDirection(),
    ),
  );

  protected readonly actionKinds = ACTION_KINDS;
  protected readonly actionLabel = ACTION_LABEL;

  /** Ids of the selected containers; ids that left the list are ignored. */
  private readonly selectedIds = signal<ReadonlySet<string>>(new Set());
  protected readonly selected = computed(() =>
    this.list.containers().filter((c) => this.selectedIds().has(c.id)),
  );
  protected readonly allVisibleSelected = computed(
    () => this.visible().length > 0 && this.visible().every((c) => this.selectedIds().has(c.id)),
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
  }

  protected sort(key: SortKey): void {
    if (this.sortKey() === key) {
      this.sortDirection.update((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      this.sortKey.set(key);
      this.sortDirection.set("asc");
    }
  }

  protected ariaSort(key: SortKey): "ascending" | "descending" | "none" {
    if (this.sortKey() !== key) return "none";
    return this.sortDirection() === "asc" ? "ascending" : "descending";
  }

  protected setFilter(event: Event): void {
    this.filter.set((event.target as HTMLInputElement).value);
  }

  protected setStateFilter(event: Event): void {
    this.stateFilter.set((event.target as HTMLSelectElement).value as StateFilter);
  }

  protected state(container: Container): string {
    return stateLabel(container);
  }

  protected port = portLabel;

  protected created(container: Container): string {
    return new Date(container.created * 1000).toLocaleString();
  }

  protected createdIso(container: Container): string {
    return new Date(container.created * 1000).toISOString();
  }

  protected open(event: Event, port: number): void {
    event.preventDefault();
    void openLocalPort(port).catch(() => {});
  }

  protected isSelected(container: Container): boolean {
    return this.selectedIds().has(container.id);
  }

  protected toggle(container: Container): void {
    this.selectedIds.update((ids) => {
      const next = new Set(ids);
      if (!next.delete(container.id)) next.add(container.id);
      return next;
    });
  }

  protected toggleAll(): void {
    const visible = this.visible();
    this.selectedIds.update((ids) => {
      const next = new Set(ids);
      const all = visible.every((c) => next.has(c.id));
      for (const c of visible) {
        if (all) next.delete(c.id);
        else next.add(c.id);
      }
      return next;
    });
  }

  /** The selected containers an action applies to. */
  protected applicable(kind: ActionKind): readonly Container[] {
    return this.selected().filter((c) => canApply(kind, c.state));
  }

  protected disabled(kind: ActionKind): boolean {
    return this.progress() !== null || this.applicable(kind).length === 0;
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
