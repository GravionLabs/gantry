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

import type { Container, Stack } from "../core/bindings";
import { ContainerList } from "../core/container-list";
import { stateLabel } from "../core/containers";
import { EndpointStore } from "../core/endpoint-store";
import { toGantryError } from "../core/invoke";
import { ShellService } from "../core/shell/shell.service";
import { listStacks, serviceCount, stackSummary } from "../core/stacks";

/**
 * The Stacks view: the Compose projects of the active endpoint. The stacks are read again whenever
 * the live container list changes.
 */
@Component({
  selector: "app-stacks-view",
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HxButton, HxMessage, HxTable],
  providers: [ContainerList],
  templateUrl: "./stacks-view.html",
  styleUrl: "./stacks-view.css",
})
export class StacksView {
  private readonly list = inject(ContainerList);
  private readonly endpoints = inject(EndpointStore);
  private readonly shell = inject(ShellService);

  private readonly endpoint = computed(() => this.endpoints.active()?.endpoint ?? null, {
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

  private requests = 0;

  constructor() {
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
      if (this.list.phase() === "error") this.problem.set(this.list.problem());
    });
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

  protected open(event: Event, stack: Stack): void {
    event.preventDefault();
    this.selectedName.set(stack.name);
  }

  protected back(): void {
    this.selectedName.set(null);
  }

  protected details(event: Event, container: Container): void {
    event.preventDefault();
    this.shell.openContainer(container.id);
  }
}
