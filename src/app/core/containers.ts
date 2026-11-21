import type { Container, ContainerState, ContainerWatchEvent, Endpoint } from "./bindings";
import { invoke, stream } from "./invoke";

export type { Container, ContainerWatchEvent } from "./bindings";

/** Lists the containers of an endpoint through the Tauri command `containers_list`. */
export function listContainers(endpoint: Endpoint): Promise<Container[]> {
  return invoke<Container[]>("containers_list", { endpoint });
}

/** Opens `http://localhost:<port>` in the default browser (the port is all the command takes). */
export function openLocalPort(port: number): Promise<void> {
  return invoke<void>("open_local_port", { port });
}

/**
 * Watches the containers of an endpoint: a snapshot, then a new one after every change. The core
 * reconnects by itself after an engine restart and reports it as a `reconnecting` event.
 *
 * `onEnd` runs when the command ends without being stopped, e.g. when the endpoint cannot be opened.
 * Returns the function that stops the watch.
 */
export function watchContainers(
  endpoint: Endpoint,
  onEvent: (event: ContainerWatchEvent) => void,
  onEnd: (error: unknown) => void,
): () => void {
  const watchId = crypto.randomUUID();
  let stopped = false;
  stream<ContainerWatchEvent>(
    "containers_watch",
    (event) => {
      if (!stopped) onEvent(event);
    },
    { endpoint, watchId },
  ).then(
    () => {
      if (!stopped) onEnd(null);
    },
    (error: unknown) => {
      if (!stopped) onEnd(error);
    },
  );
  return () => {
    if (stopped) return;
    stopped = true;
    void invoke("containers_unwatch", { watchId }).catch(() => {});
  };
}

/** Whether the engine runs on this machine, so that a published port is reachable on `localhost`. */
export function isLocalEndpoint(endpoint: Endpoint): boolean {
  switch (endpoint.kind) {
    case "unix":
    case "namedPipe":
      return true;
    case "ssh":
      return false;
    default: {
      const host = endpoint.address.replace(/^[a-z]+:\/\//i, "").replace(/[:/].*$/, "");
      return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
    }
  }
}

export type StateFilter = "all" | "running" | "exited";

/** `running` covers the containers that are up (also paused or restarting); `exited` is the rest. */
export function isUp(state: ContainerState): boolean {
  return state === "running" || state === "paused" || state === "restarting";
}

/** Containers whose name or image contains `text` (case-insensitive) and match the state filter. */
export function filterContainers(
  containers: readonly Container[],
  text: string,
  state: StateFilter,
): Container[] {
  const needle = text.trim().toLowerCase();
  return containers.filter((c) => {
    if (state === "running" && !isUp(c.state)) return false;
    if (state === "exited" && isUp(c.state)) return false;
    return (
      !needle || c.name.toLowerCase().includes(needle) || c.image.toLowerCase().includes(needle)
    );
  });
}

export type SortKey = "name" | "image" | "state" | "ports" | "created" | "project";
export type SortDirection = "asc" | "desc";

const text = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

function lowestPort(c: Container): number | null {
  const ports = c.ports.map((p) => p.publicPort).filter((p): p is number => p !== null);
  return ports.length ? Math.min(...ports) : null;
}

/** Compares in ascending order; a missing value (no port, no project) sorts last. */
function compare(a: Container, b: Container, key: SortKey): number {
  switch (key) {
    case "image":
      return text.compare(a.image, b.image);
    case "state":
      return text.compare(a.state, b.state);
    case "created":
      return a.created - b.created;
    case "ports": {
      const [x, y] = [lowestPort(a), lowestPort(b)];
      return x === y ? 0 : x === null ? 1 : y === null ? -1 : x - y;
    }
    case "project": {
      const [x, y] = [a.composeProject, b.composeProject];
      return x === y ? 0 : x === null ? 1 : y === null ? -1 : text.compare(x, y);
    }
    default:
      return text.compare(a.name, b.name);
  }
}

/** A sorted copy; ties fall back to the name so that the order is stable between updates. */
export function sortContainers(
  containers: readonly Container[],
  key: SortKey,
  direction: SortDirection,
): Container[] {
  const sign = direction === "asc" ? 1 : -1;
  return [...containers].sort((a, b) => {
    const result = compare(a, b, key);
    // A missing value stays last in both directions.
    const missing = key === "ports" ? lowestPort(a) === null || lowestPort(b) === null : false;
    const missingProject =
      key === "project" && (a.composeProject === null || b.composeProject === null);
    const ordered = missing || missingProject ? result : sign * result;
    return ordered || text.compare(a.name, b.name);
  });
}

/** `8080→80/tcp`, or just `80/tcp` for an exposed port. */
export function portLabel(port: Container["ports"][number]): string {
  const target = `${port.privatePort}/${port.protocol}`;
  return port.publicPort === null ? target : `${port.publicPort}→${target}`;
}

const STATE_LABEL: Record<ContainerState, string> = {
  created: "Created",
  running: "Running",
  paused: "Paused",
  restarting: "Restarting",
  exited: "Exited",
  removing: "Removing",
  dead: "Dead",
  stopping: "Stopping",
  unknown: "Unknown",
};

/** `Running`, or `Running (healthy)` for a container with a health check. */
export function stateLabel(container: Container): string {
  const state = STATE_LABEL[container.state];
  return container.health ? `${state} (${container.health})` : state;
}
