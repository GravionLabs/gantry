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
  stackSummary,
} from "../core/stacks";

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
    effect(() => {
      const endpoint = this.endpoint();
      if (endpoint) untracked(() => this.list.start(endpoint));
    });
    // A snapshot of the watch means that a container changed: read the stacks again.
    effect(() => {
      this.list.containers();
      if (this.list.phase() === "ready") untracked(() => void this.refresh());
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

  protected open(event: Event, stack: Stack): void {
    event.preventDefault();
    this.selectedName.set(stack.name);
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
