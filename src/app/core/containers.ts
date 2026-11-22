import type {
  ActionEvent,
  ActionTarget,
  Container,
  ContainerAction,
  ContainerDetails,
  ContainerState,
  ContainerWatchEvent,
  Endpoint,
  LogEvent,
  LogLine,
  LogOptions,
} from "./bindings";
import { invoke, stream } from "./invoke";

export type { Container, ContainerDetails, ContainerWatchEvent } from "./bindings";

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

/**
 * Streams the logs of a container: lines arrive in batches. `onEnd` runs when the stream ends on
 * its own (not following, or an error such as a missing container). A followed log runs until the
 * returned function stops it.
 */
export function streamContainerLogs(
  endpoint: Endpoint,
  id: string,
  options: LogOptions,
  onLines: (lines: LogLine[]) => void,
  onEnd: (error: unknown) => void,
): () => void {
  const watchId = crypto.randomUUID();
  let stopped = false;
  stream<LogEvent>(
    "containers_logs",
    (event) => {
      if (!stopped && event.type === "lines") onLines(event.lines);
    },
    { endpoint, id, options, watchId },
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

/**
 * The comparator of a grid column. The grid reverses the result for a descending sort, so a missing
 * value (no port, no project) is reversed here first and stays last in both directions. Ties fall
 * back to the name so that the order is stable between updates.
 */
export function compareContainers(
  a: Container,
  b: Container,
  key: SortKey,
  descending = false,
): number {
  const missing =
    (key === "ports" && (lowestPort(a) === null || lowestPort(b) === null)) ||
    (key === "project" && (a.composeProject === null || b.composeProject === null));
  const result = compare(a, b, key);
  const ordered = missing && descending ? -result : result;
  return ordered || text.compare(a.name, b.name);
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
export function stateLabel(container: Pick<Container, "state" | "health">): string {
  const state = STATE_LABEL[container.state];
  return container.health ? `${state} (${container.health})` : state;
}

export type { ActionEvent, ContainerAction } from "./bindings";

/** The kinds of action, without the options of `remove`. */
export type ActionKind = ContainerAction["type"];

export const ACTION_LABEL: Record<ActionKind, string> = {
  start: "Start",
  stop: "Stop",
  restart: "Restart",
  pause: "Pause",
  unpause: "Unpause",
  kill: "Kill",
  remove: "Remove",
};

/** The order of the toolbar. */
export const ACTION_KINDS: readonly ActionKind[] = [
  "start",
  "stop",
  "restart",
  "pause",
  "unpause",
  "kill",
  "remove",
];

/** Severity of a toolbar action: grey when disabled, danger for destructive ones, else primary. */
export function actionSeverity(
  kind: ActionKind,
  enabled: boolean,
): "primary" | "danger" | "secondary" {
  if (!enabled) return "secondary";
  return kind === "kill" || kind === "remove" ? "danger" : "primary";
}

/** Whether an action makes sense for a container in `state`; the engine has the final say. */
export function canApply(kind: ActionKind, state: ContainerState): boolean {
  switch (kind) {
    case "start":
      return state === "created" || state === "exited";
    case "stop":
    case "restart":
    case "kill":
      return state === "running" || state === "paused" || state === "restarting";
    case "pause":
      return state === "running";
    case "unpause":
      return state === "paused";
    default:
      return state !== "removing";
  }
}

/** The containers an action applies to, as the targets of the command. */
export function actionTargets(kind: ActionKind, containers: readonly Container[]): ActionTarget[] {
  return containers.filter((c) => canApply(kind, c.state)).map((c) => ({ id: c.id, name: c.name }));
}

/**
 * Runs a lifecycle action for several containers through `containers_action`. `onEvent` gets the
 * progress per container; resolves with the number of containers that failed.
 */
export function runContainerAction(
  endpoint: Endpoint,
  action: ContainerAction,
  targets: readonly ActionTarget[],
  onEvent: (event: ActionEvent) => void,
): Promise<number> {
  return stream<ActionEvent, number>("containers_action", onEvent, { endpoint, action, targets });
}

/** Reads everything `docker inspect` shows for one container through `containers_inspect`. */
export function inspectContainer(endpoint: Endpoint, id: string): Promise<ContainerDetails> {
  return invoke<ContainerDetails>("containers_inspect", { endpoint, id });
}

/** The command line as one string; an argument with whitespace is quoted. `–` when it is empty. */
export function commandLine(args: readonly string[]): string {
  if (!args.length) return "–";
  return args.map((a) => (a === "" || /\s/.test(a) ? JSON.stringify(a) : a)).join(" ");
}

/** `unless-stopped`, or `on-failure (max 3 retries)`. */
export function restartPolicyLabel(policy: ContainerDetails["restartPolicy"]): string {
  if (policy.name !== "on-failure" || policy.maxRetries === 0) return policy.name;
  return `${policy.name} (max ${policy.maxRetries} retries)`;
}

/** The shown form of a value that is masked until the user reveals it. */
export function maskValue(value: string): string {
  return value === "" ? "" : "••••••••";
}

/** A published port as `host:8080→80/tcp`; the host address is left out for `0.0.0.0` and `::`. */
export function boundPortLabel(port: ContainerDetails["ports"][number]): string {
  const label = portLabel(port);
  return port.ip && port.ip !== "0.0.0.0" && port.ip !== "::" ? `${port.ip}:${label}` : label;
}

/** The path of the detail route of a container. */
export function containerPath(id: string): string {
  return `/containers/${encodeURIComponent(id)}`;
}

/** The container id of a `/containers/:id` path; null for any other path. */
export function parseContainerPath(path: string): string | null {
  const match = /^\/containers\/([^/]+)\/?$/.exec(path);
  return match ? decodeURIComponent(match[1]) : null;
}

/** The raw inspect JSON with the values of `Config.Env` masked, unless `reveal` is set. */
export function rawJson(raw: string, reveal: boolean): string {
  if (reveal) return raw;
  try {
    const parsed = JSON.parse(raw) as { Config?: { Env?: unknown } };
    const env = parsed.Config?.Env;
    if (Array.isArray(env)) {
      parsed.Config!.Env = env.map((entry) => {
        if (typeof entry !== "string") return entry;
        const i = entry.indexOf("=");
        return i < 0 ? entry : `${entry.slice(0, i + 1)}${maskValue(entry.slice(i + 1))}`;
      });
    }
    return JSON.stringify(parsed, null, 2);
  } catch {
    return raw;
  }
}
