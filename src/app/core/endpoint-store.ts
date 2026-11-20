import { Injectable, InjectionToken, computed, inject, signal } from "@angular/core";

import type { ContextList, DetectedEngine, Endpoint, EngineInfo, TlsFiles } from "./bindings";
import { ENDPOINT_PERSISTENCE } from "./endpoint-persistence";
import { buildEndpoint, detectEndpoints, listContexts } from "./endpoints";
import { pingEndpoint } from "./engine";
import { GantryError, toGantryError } from "./invoke";

/** Where an endpoint comes from. Only manual endpoints can be changed in Gantry. */
export type EndpointOrigin = "detected" | "context" | "manual";

/** `checking` until the first answer; `denied` when the engine refuses access. */
export type EndpointState = "checking" | "reachable" | "unreachable" | "denied";

export interface EndpointStatus {
  readonly state: EndpointState;
  readonly info: EngineInfo | null;
  /** Why the endpoint is unreachable or denied. */
  readonly error: string | null;
}

/** One row of the endpoint list. */
export interface EndpointEntry {
  /** `<origin>:<name>`; stable across restarts, it is what the active endpoint is persisted as. */
  readonly id: string;
  readonly origin: EndpointOrigin;
  readonly endpoint: Endpoint;
  readonly status: EndpointStatus;
}

/** The status bar view of the active endpoint. */
export type ConnectionState = "connecting" | "connected" | "unreachable";

/** The commands the store needs; replaced by a fake in tests. */
export interface EndpointBackend {
  detect(): Promise<DetectedEngine[]>;
  contexts(): Promise<ContextList>;
  ping(endpoint: Endpoint): Promise<EngineInfo>;
  build(name: string, address: string, tls: TlsFiles | null): Promise<Endpoint>;
}

export const ENDPOINT_BACKEND = new InjectionToken<EndpointBackend>("EndpointBackend", {
  providedIn: "root",
  factory: () => ({
    detect: detectEndpoints,
    contexts: listContexts,
    ping: pingEndpoint,
    build: buildEndpoint,
  }),
});

const CHECKING: EndpointStatus = { state: "checking", info: null, error: null };

/** "Unix socket", "Named pipe", "TCP", "TCP+TLS" or "SSH". */
export function kindLabel(endpoint: Endpoint): string {
  switch (endpoint.kind) {
    case "unix":
      return "Unix socket";
    case "namedPipe":
      return "Named pipe";
    case "ssh":
      return "SSH";
    default:
      return endpoint.tls ? "TCP+TLS" : "TCP";
  }
}

export function endpointId(origin: EndpointOrigin, name: string): string {
  return `${origin}:${name}`;
}

function statusOfDetected(engine: DetectedEngine): EndpointStatus {
  const status = engine.status;
  switch (status.state) {
    case "reachable":
      return { state: "reachable", info: status.info, error: null };
    case "permissionDenied":
      return { state: "denied", info: null, error: status.hint };
    default:
      return { state: "unreachable", info: null, error: "The engine is not running." };
  }
}

/**
 * All endpoints (detected, imported contexts, manual), the active one and its persistence.
 *
 * The active endpoint is restored from the preferences. When it is gone, or nothing was saved, the first
 * reachable endpoint is used. An active endpoint that exists but does not answer stays active: the views
 * show an error with retry instead of silently acting on another engine.
 */
@Injectable({ providedIn: "root" })
export class EndpointStore {
  private readonly backend = inject(ENDPOINT_BACKEND);
  private readonly persistence = inject(ENDPOINT_PERSISTENCE);

  private readonly manual = signal<readonly Endpoint[]>([]);
  private readonly detected = signal<readonly DetectedEngine[]>([]);
  private readonly contexts = signal<readonly Endpoint[]>([]);
  /** Statuses of contexts and manual endpoints, by id (detected ones carry theirs). */
  private readonly probed = signal<ReadonlyMap<string, EndpointStatus>>(new Map());

  readonly activeId = signal<string | null>(null);
  /** Counts switches and retries; a view that depends on the endpoint is recreated when it changes. */
  readonly generation = signal(0);
  readonly loading = signal(false);
  readonly warnings = signal<readonly string[]>([]);

  readonly entries = computed<EndpointEntry[]>(() => {
    const statuses = this.probed();
    const status = (id: string): EndpointStatus => statuses.get(id) ?? CHECKING;
    const detected = this.detected().map((engine) => {
      const id = endpointId("detected", engine.endpoint.name);
      return {
        id,
        origin: "detected" as const,
        endpoint: engine.endpoint,
        status: statusOfDetected(engine),
      };
    });
    const contexts = this.contexts().map((endpoint) => {
      const id = endpointId("context", endpoint.name);
      return { id, origin: "context" as const, endpoint, status: status(id) };
    });
    const manual = this.manual().map((endpoint) => {
      const id = endpointId("manual", endpoint.name);
      return { id, origin: "manual" as const, endpoint, status: status(id) };
    });
    return [...detected, ...contexts, ...manual];
  });

  readonly active = computed(() => this.entries().find((e) => e.id === this.activeId()) ?? null);

  readonly connection = computed<ConnectionState>(() => {
    switch (this.active()?.status.state) {
      case "reachable":
        return "connected";
      case "unreachable":
      case "denied":
        return "unreachable";
      case undefined:
        return this.loading() ? "connecting" : "unreachable";
      default:
        return "connecting";
    }
  });

  /** The name for the status bar. */
  readonly activeName = computed(() => this.active()?.endpoint.name ?? "No endpoint");
  readonly activeError = computed(
    () => this.active()?.status.error ?? (this.loading() ? null : "No endpoint is available."),
  );
  readonly engineVersion = computed(() => this.active()?.status.info?.version ?? null);

  /** Reads the preferences, finds the engines and picks the active endpoint. */
  async init(): Promise<void> {
    const prefs = await this.persistence.load().catch(() => ({ manual: [], active: null }));
    this.manual.set(prefs.manual);
    this.activeId.set(prefs.active);
    await this.refresh();
  }

  /** Detects again, re-reads the contexts and probes every endpoint. */
  async refresh(): Promise<void> {
    this.loading.set(true);
    try {
      const [detected, contexts] = await Promise.all([
        this.backend.detect().catch(() => []),
        this.backend.contexts().catch(() => null),
      ]);
      this.detected.set(detected);
      this.contexts.set(contexts?.contexts ?? []);
      this.warnings.set(contexts?.warnings ?? []);
      this.probed.set(new Map());
      await Promise.all(
        this.entries()
          .filter((e) => e.origin !== "detected")
          .map((e) => this.probe(e)),
      );
      this.resolveActive();
    } finally {
      this.loading.set(false);
    }
  }

  /** Makes an endpoint the one every view acts on and reloads the open view. */
  select(id: string): void {
    if (!this.entries().some((e) => e.id === id)) return;
    this.activeId.set(id);
    this.generation.update((n) => n + 1);
    void this.save();
  }

  /** Probes the active endpoint again and reloads the open view. */
  async retry(): Promise<void> {
    const id = this.activeId();
    if (id) await this.recheck(id);
    else await this.refresh();
    this.generation.update((n) => n + 1);
  }

  /** Probes one endpoint again ("Test connection" on a row); a detected one is detected again. */
  async recheck(id: string): Promise<void> {
    const entry = this.entries().find((e) => e.id === id);
    if (!entry) return;
    if (entry.origin === "detected") await this.refresh();
    else await this.probe(entry);
  }

  /** Tests what the form holds without adding it ("Test connection"). */
  async testDraft(name: string, address: string, tls: TlsFiles | null): Promise<EngineInfo> {
    return this.backend.ping(await this.backend.build(name, address, tls));
  }

  /** Adds a manual endpoint. Rejects with a `GantryError` for bad input or a name in use. */
  async add(name: string, address: string, tls: TlsFiles | null): Promise<void> {
    const endpoint = await this.backend.build(name, address, tls);
    this.assertFreeName(endpoint.name);
    this.manual.update((list) => [...list, endpoint]);
    await this.save();
    await this.probe(this.entryOf("manual", endpoint.name));
    this.resolveActive();
  }

  /** Replaces a manual endpoint; the active selection follows a rename. */
  async update(id: string, name: string, address: string, tls: TlsFiles | null): Promise<void> {
    const old = this.entries().find((e) => e.id === id && e.origin === "manual");
    if (!old) throw new GantryError("notFound", "The endpoint no longer exists.");
    const endpoint = await this.backend.build(name, address, tls);
    if (endpoint.name !== old.endpoint.name) this.assertFreeName(endpoint.name);
    this.manual.update((list) => list.map((e) => (e.name === old.endpoint.name ? endpoint : e)));
    const newId = endpointId("manual", endpoint.name);
    if (this.activeId() === id) this.activeId.set(newId);
    this.dropStatus(id);
    await this.save();
    await this.probe(this.entryOf("manual", endpoint.name));
    if (this.activeId() === newId) this.generation.update((n) => n + 1);
  }

  /** Removes a manual endpoint; when it was active, the first reachable one takes over. */
  async remove(id: string): Promise<void> {
    const entry = this.entries().find((e) => e.id === id && e.origin === "manual");
    if (!entry) return;
    this.manual.update((list) => list.filter((e) => e.name !== entry.endpoint.name));
    this.dropStatus(id);
    if (this.activeId() === id) {
      this.activeId.set(null);
      this.resolveActive();
      this.generation.update((n) => n + 1);
    }
    await this.save();
  }

  private entryOf(origin: EndpointOrigin, name: string): EndpointEntry {
    return this.entries().find((e) => e.id === endpointId(origin, name))!;
  }

  private assertFreeName(name: string): void {
    if (this.manual().some((e) => e.name === name)) {
      throw new GantryError("conflict", `An endpoint named "${name}" already exists.`);
    }
  }

  private dropStatus(id: string): void {
    this.probed.update((map) => {
      const next = new Map(map);
      next.delete(id);
      return next;
    });
  }

  private setStatus(id: string, status: EndpointStatus): void {
    this.probed.update((map) => new Map(map).set(id, status));
  }

  private async probe(entry: EndpointEntry): Promise<void> {
    this.setStatus(entry.id, CHECKING);
    try {
      const info = await this.backend.ping(entry.endpoint);
      this.setStatus(entry.id, { state: "reachable", info, error: null });
    } catch (error) {
      const e = toGantryError(error);
      const state = e.kind === "permissionDenied" ? "denied" : "unreachable";
      this.setStatus(entry.id, { state, info: null, error: e.message });
    }
  }

  /** Keeps the active endpoint when it exists, else takes the first reachable one. */
  private resolveActive(): void {
    if (this.active()) return;
    const first = this.entries().find((e) => e.status.state === "reachable");
    const next = first?.id ?? null;
    if (next !== this.activeId()) {
      this.activeId.set(next);
      this.generation.update((n) => n + 1);
      void this.save();
    }
  }

  private async save(): Promise<void> {
    await this.persistence
      .save({ manual: this.manual(), active: this.activeId() })
      .catch(() => undefined);
  }
}
