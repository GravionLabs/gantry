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
  SortDirection,
  SortKey,
  StateFilter,
  filterContainers,
  isLocalEndpoint,
  openLocalPort,
  portLabel,
  sortContainers,
  stateLabel,
} from "../core/containers";
import { EndpointStore } from "../core/endpoint-store";

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
}
