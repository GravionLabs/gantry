import { DestroyRef, Injectable, inject, signal } from "@angular/core";
import { InjectionToken } from "@angular/core";

import type { Container, ContainerWatchEvent, Endpoint } from "./bindings";
import { watchContainers } from "./containers";
import { toGantryError } from "./invoke";

/** `loading` until the first snapshot; `error` when there is none and the engine cannot be read. */
export type ListPhase = "loading" | "ready" | "error";

/** The watch the list uses; replaced by a fake in tests. */
export type WatchBackend = (
  endpoint: Endpoint,
  onEvent: (event: ContainerWatchEvent) => void,
  onEnd: (error: unknown) => void,
) => () => void;

export const WATCH_BACKEND = new InjectionToken<WatchBackend>("WatchBackend", {
  providedIn: "root",
  factory: () => watchContainers,
});

/**
 * The live container list of one endpoint. Provide it in the component that shows the list: the watch
 * stops when that component is destroyed.
 */
@Injectable()
export class ContainerList {
  private readonly watch = inject(WATCH_BACKEND);
  private stop: (() => void) | null = null;
  private endpoint: Endpoint | null = null;

  readonly containers = signal<readonly Container[]>([]);
  readonly phase = signal<ListPhase>("loading");
  /** Why the list is not current: the error in the `error` phase, or the lost connection while `ready`. */
  readonly problem = signal<string | null>(null);

  constructor() {
    inject(DestroyRef).onDestroy(() => this.close());
  }

  /** Starts watching `endpoint`, replacing a previous watch. */
  start(endpoint: Endpoint): void {
    this.close();
    this.endpoint = endpoint;
    this.containers.set([]);
    this.phase.set("loading");
    this.problem.set(null);
    this.stop = this.watch(
      endpoint,
      (event) => this.onEvent(event),
      (error) => this.onEnd(error),
    );
  }

  /** Starts over after an error. */
  retry(): void {
    if (this.endpoint) this.start(this.endpoint);
  }

  private close(): void {
    this.stop?.();
    this.stop = null;
  }

  private onEvent(event: ContainerWatchEvent): void {
    if (event.type === "snapshot") {
      this.containers.set(event.containers);
      this.phase.set("ready");
      this.problem.set(null);
    } else {
      // The core keeps retrying; without data there is nothing to show but the reason.
      if (this.phase() === "loading") this.phase.set("error");
      this.problem.set(event.message);
    }
  }

  private onEnd(error: unknown): void {
    this.stop = null;
    this.phase.set(this.containers().length ? "ready" : "error");
    this.problem.set(error ? toGantryError(error).message : "The container updates stopped.");
  }
}
