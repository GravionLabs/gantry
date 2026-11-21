import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
} from "@angular/core";
import { HxButton, HxMessage } from "@gravionlabs/helix-ui";

import type { ContainerDetails, Endpoint } from "../core/bindings";
import {
  boundPortLabel,
  commandLine,
  inspectContainer,
  maskValue,
  rawJson,
  restartPolicyLabel,
  stateLabel,
} from "../core/containers";
import { EndpointStore } from "../core/endpoint-store";
import { toGantryError } from "../core/invoke";
import { ShellService } from "../core/shell/shell.service";
import { isViewAvailable } from "../core/shell/views";
import { ContainerLogs } from "./container-logs";
import { ContainerTerminal } from "./container-terminal";

export type DetailTab =
  | "overview"
  | "logs"
  | "terminal"
  | "environment"
  | "mounts"
  | "networks"
  | "labels"
  | "raw";

const TABS: readonly { readonly id: DetailTab; readonly label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "logs", label: "Logs" },
  { id: "terminal", label: "Terminal" },
  { id: "environment", label: "Environment" },
  { id: "mounts", label: "Mounts" },
  { id: "networks", label: "Networks" },
  { id: "labels", label: "Labels" },
  { id: "raw", label: "Raw JSON" },
];

/** `loading`, then the details, or `notFound` (removed, or another endpoint) or `error`. */
export type DetailsPhase = "loading" | "ready" | "notFound" | "error";

/** The detail view of one container (`/containers/:id`): everything `docker inspect` shows. */
@Component({
  selector: "app-container-details",
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ContainerLogs, ContainerTerminal, HxButton, HxMessage],
  templateUrl: "./container-details.html",
  styleUrl: "./container-details.css",
})
export class ContainerDetailsView {
  /** The id (or name) from the route. */
  readonly id = input.required<string>();

  private readonly endpoints = inject(EndpointStore);
  protected readonly shell = inject(ShellService);

  protected readonly tabs = TABS;
  protected readonly tab = signal<DetailTab>("overview");
  protected readonly phase = signal<DetailsPhase>("loading");
  protected readonly details = signal<ContainerDetails | null>(null);
  protected readonly problem = signal<string | null>(null);
  /** Names of the environment variables whose value is shown. */
  protected readonly revealed = signal<ReadonlySet<string>>(new Set());
  protected readonly revealAll = signal(false);

  protected readonly endpoint = computed<Endpoint | null>(
    () => this.endpoints.active()?.endpoint ?? null,
    { equal: (a, b) => a?.address === b?.address },
  );
  /** Only the latest request may set the result. */
  private request = 0;

  protected readonly rawText = computed(() => rawJson(this.details()?.raw ?? "", this.revealAll()));
  protected readonly endpointName = this.endpoints.activeName;
  protected readonly canLinkImage = isViewAvailable("images");
  protected readonly canLinkVolumes = isViewAvailable("volumes");
  protected readonly canLinkNetworks = isViewAvailable("networks");
  protected readonly canLinkStacks = isViewAvailable("stacks");

  constructor() {
    effect(() => {
      const endpoint = this.endpoint();
      const id = this.id();
      if (endpoint) untracked(() => void this.load(endpoint, id));
    });
  }

  protected async load(endpoint: Endpoint | null = this.endpoint(), id = this.id()): Promise<void> {
    if (!endpoint) return;
    const request = ++this.request;
    this.phase.set("loading");
    this.problem.set(null);
    this.revealed.set(new Set());
    this.revealAll.set(false);
    try {
      const details = await inspectContainer(endpoint, id);
      if (request !== this.request) return;
      this.details.set(details);
      this.phase.set("ready");
    } catch (error) {
      if (request !== this.request) return;
      const e = toGantryError(error);
      this.details.set(null);
      this.problem.set(e.message);
      this.phase.set(e.kind === "notFound" ? "notFound" : "error");
    }
  }

  /** Terminals stay alive while other tabs are shown, so the view is created on first use. */
  protected readonly terminalOpened = signal(false);

  protected select(tab: DetailTab): void {
    if (tab === "terminal") this.terminalOpened.set(true);
    this.tab.set(tab);
  }

  /** Arrow keys move between the tabs, as the tab pattern asks. */
  protected onTabKey(event: KeyboardEvent): void {
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const index = TABS.findIndex((t) => t.id === this.tab());
    const next = TABS[(index + step + TABS.length) % TABS.length];
    this.select(next.id);
    (event.currentTarget as HTMLElement).querySelector<HTMLElement>(`#tab-${next.id}`)?.focus();
  }

  protected isRevealed(name: string): boolean {
    return this.revealAll() || this.revealed().has(name);
  }

  protected toggleReveal(name: string): void {
    this.revealed.update((names) => {
      const next = new Set(names);
      if (!next.delete(name)) next.add(name);
      return next;
    });
  }

  protected toggleRevealAll(): void {
    this.revealAll.update((v) => !v);
  }

  protected shown(name: string, value: string): string {
    return this.isRevealed(name) ? value : maskValue(value);
  }

  protected back(): void {
    this.shell.closeContainer();
  }

  protected goTo(event: Event, view: string): void {
    event.preventDefault();
    this.shell.select(view);
  }

  protected state(d: ContainerDetails): string {
    return stateLabel(d);
  }

  protected command = commandLine;
  protected restart = restartPolicyLabel;
  protected port = boundPortLabel;

  protected created(d: ContainerDetails): string {
    const date = new Date(d.created);
    return Number.isNaN(date.getTime()) ? d.created : date.toLocaleString();
  }
}
