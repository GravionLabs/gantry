import { beforeEach, describe, expect, it, vi } from "vitest";

const tauri = vi.hoisted(() => ({
  invoke: vi.fn(),
  channels: [] as { onmessage: (m: unknown) => void }[],
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: tauri.invoke,
  Channel: class {
    onmessage: (message: unknown) => void = () => {};
    constructor() {
      tauri.channels.push(this);
    }
  },
}));

import type { Container, Endpoint } from "./bindings";
import { GantryError } from "./invoke";
import {
  ACTION_KINDS,
  actionTargets,
  boundPortLabel,
  actionLook,
  canApply,
  compareContainers,
  commandLine,
  containerPath,
  inspectContainer,
  maskValue,
  parseContainerPath,
  rawJson,
  restartPolicyLabel,
  filterContainers,
  isLocalEndpoint,
  portLabel,
  runContainerAction,
  stateLabel,
  streamContainerLogs,
  watchContainers,
  type SortKey,
} from "./containers";

function container(name: string, extra: Partial<Container> = {}): Container {
  return {
    id: `id-${name}`,
    name,
    image: "nginx:latest",
    state: "running",
    health: null,
    status: "Up",
    ports: [],
    created: 1_700_000_000,
    composeProject: null,
    ...extra,
  };
}

function endpoint(kind: Endpoint["kind"], address: string): Endpoint {
  return { name: "e", kind, address, tls: null, skipTlsVerify: false, readOnly: false };
}

const port = (publicPort: number | null, privatePort = 80) => ({
  ip: "0.0.0.0",
  privatePort,
  publicPort,
  protocol: "tcp",
});

describe("isLocalEndpoint", () => {
  it.each([
    [endpoint("unix", "unix:///var/run/docker.sock"), true],
    [endpoint("namedPipe", "npipe:////./pipe/docker_engine"), true],
    [endpoint("tcp", "tcp://localhost:2375"), true],
    [endpoint("tcp", "tcp://127.0.0.1:2375"), true],
    [endpoint("tcp", "tcp://build.example.com:2375"), false],
    [endpoint("tcp", "tcp://localhost.example.com:2375"), false],
    [endpoint("ssh", "ssh://me@localhost"), false],
  ])("%j is local: %s", (e, expected) => {
    expect(isLocalEndpoint(e)).toBe(expected);
  });
});

describe("filterContainers", () => {
  const list = [
    container("web", { image: "nginx" }),
    container("db", { image: "postgres:17", state: "exited" }),
    container("job", { image: "alpine", state: "created" }),
    container("pause", { image: "alpine", state: "paused" }),
  ];

  it("matches the name or the image, ignoring case", () => {
    expect(filterContainers(list, "WEB", "all").map((c) => c.name)).toEqual(["web"]);
    expect(filterContainers(list, "postgres", "all").map((c) => c.name)).toEqual(["db"]);
  });

  it("splits running (including paused) from exited (including created)", () => {
    expect(filterContainers(list, "", "running").map((c) => c.name)).toEqual(["web", "pause"]);
    expect(filterContainers(list, "", "exited").map((c) => c.name)).toEqual(["db", "job"]);
    expect(filterContainers(list, "  ", "all")).toHaveLength(4);
  });
});

/** Sorts like the grid: the comparator ascending, its result reversed for a descending sort. */
function sortContainers(list: Container[], key: SortKey, direction: "asc" | "desc"): Container[] {
  const desc = direction === "desc";
  return [...list].sort((a, b) => (desc ? -1 : 1) * compareContainers(a, b, key, desc));
}

describe("compareContainers", () => {
  it("sorts by name naturally and reverses", () => {
    const list = [container("web10"), container("web2"), container("api")];
    expect(sortContainers(list, "name", "asc").map((c) => c.name)).toEqual([
      "api",
      "web2",
      "web10",
    ]);
    expect(sortContainers(list, "name", "desc").map((c) => c.name)).toEqual([
      "web10",
      "web2",
      "api",
    ]);
  });

  it("sorts by created and breaks ties by name", () => {
    const list = [
      container("b", { created: 2 }),
      container("a", { created: 2 }),
      container("c", { created: 1 }),
    ];
    expect(sortContainers(list, "created", "asc").map((c) => c.name)).toEqual(["c", "a", "b"]);
  });

  it("keeps containers without a port or a project last in both directions", () => {
    const list = [
      container("none"),
      container("high", { ports: [port(9000)], composeProject: "z" }),
      container("low", { ports: [port(80), port(8080)], composeProject: "a" }),
    ];
    expect(sortContainers(list, "ports", "asc").map((c) => c.name)).toEqual([
      "low",
      "high",
      "none",
    ]);
    expect(sortContainers(list, "ports", "desc").map((c) => c.name)).toEqual([
      "high",
      "low",
      "none",
    ]);
    expect(sortContainers(list, "project", "desc").map((c) => c.name)).toEqual([
      "high",
      "low",
      "none",
    ]);
  });
});

describe("labels", () => {
  it("shows published and exposed ports", () => {
    expect(portLabel(port(8080))).toBe("8080→80/tcp");
    expect(portLabel(port(null, 443))).toBe("443/tcp");
  });

  it("adds the health to the state", () => {
    expect(stateLabel(container("a"))).toBe("Running");
    expect(stateLabel(container("a", { health: "unhealthy" }))).toBe("Running (unhealthy)");
    expect(stateLabel(container("a", { state: "exited" }))).toBe("Exited");
  });
});

describe("watchContainers", () => {
  beforeEach(() => {
    tauri.invoke.mockReset();
    tauri.channels.length = 0;
  });

  it("forwards events and stops with the same watch id", async () => {
    let finish: () => void = () => {};
    tauri.invoke.mockImplementation((command: string) =>
      command === "containers_watch" ? new Promise<void>((r) => (finish = r)) : Promise.resolve(),
    );
    const events: unknown[] = [];
    const onEnd = vi.fn();
    const e = endpoint("unix", "unix:///x.sock");
    const stop = watchContainers(e, (event) => events.push(event), onEnd);

    const [command, args] = tauri.invoke.mock.calls[0];
    expect(command).toBe("containers_watch");
    expect(args).toMatchObject({ endpoint: e, watchId: expect.any(String) });
    tauri.channels[0].onmessage({ type: "snapshot", containers: [] });
    expect(events).toEqual([{ type: "snapshot", containers: [] }]);

    stop();
    stop();
    const unwatch = tauri.invoke.mock.calls.filter(([c]) => c === "containers_unwatch");
    expect(unwatch).toEqual([["containers_unwatch", { watchId: args.watchId }]]);
    tauri.channels[0].onmessage({ type: "snapshot", containers: [] });
    finish();
    await Promise.resolve();
    expect(events).toHaveLength(1);
    expect(onEnd).not.toHaveBeenCalled();
  });

  it("reports a watch that fails by itself", async () => {
    tauri.invoke.mockRejectedValue({ kind: "unreachable", message: "no socket" });
    const onEnd = vi.fn();
    watchContainers(endpoint("unix", "unix:///x.sock"), () => {}, onEnd);
    await vi.waitFor(() => expect(onEnd).toHaveBeenCalled());
    expect(onEnd.mock.calls[0][0]).toMatchObject({ kind: "unreachable" });
  });
});

describe("actions", () => {
  it("offers an action only for states it fits", () => {
    expect(canApply("start", "exited")).toBe(true);
    expect(canApply("start", "running")).toBe(false);
    expect(canApply("pause", "running")).toBe(true);
    expect(canApply("pause", "paused")).toBe(false);
    expect(canApply("unpause", "paused")).toBe(true);
    expect(canApply("stop", "exited")).toBe(false);
    expect(canApply("remove", "running")).toBe(true);
    expect(canApply("remove", "removing")).toBe(false);
  });

  it("targets only the containers the action applies to", () => {
    const list = [
      container("a"),
      container("b", { state: "exited" }),
      container("c", { state: "paused" }),
    ];
    expect(actionTargets("stop", list).map((t) => t.name)).toEqual(["a", "c"]);
    expect(actionTargets("start", list)).toEqual([{ id: "id-b", name: "b" }]);
  });

  it("streams the progress of the command and resolves with the failure count", async () => {
    tauri.channels.length = 0;
    tauri.invoke.mockImplementationOnce(async () => {
      tauri.channels[0].onmessage({ type: "started", id: "id-a" });
      return 1;
    });
    const events: unknown[] = [];
    const targets = [{ id: "id-a", name: "a" }];
    const failed = await runContainerAction(
      endpoint("unix", "unix:///x"),
      { type: "remove", volumes: true },
      targets,
      (e) => events.push(e),
    );
    expect(failed).toBe(1);
    expect(events).toEqual([{ type: "started", id: "id-a" }]);
    expect(tauri.invoke).toHaveBeenLastCalledWith(
      "containers_action",
      expect.objectContaining({ action: { type: "remove", volumes: true }, targets }),
    );
  });
});

describe("container details", () => {
  beforeEach(() => {
    tauri.invoke.mockReset();
  });

  it("inspects through containers_inspect", async () => {
    tauri.invoke.mockResolvedValue({ id: "abc" });
    const e = { name: "local" } as Endpoint;
    await expect(inspectContainer(e, "abc")).resolves.toEqual({ id: "abc" });
    expect(tauri.invoke).toHaveBeenCalledWith("containers_inspect", { endpoint: e, id: "abc" });
  });

  it("maps a missing container to a notFound error", async () => {
    tauri.invoke.mockRejectedValue({ kind: "notFound", message: "No such container" });
    const error = await inspectContainer({} as Endpoint, "gone").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GantryError);
    expect((error as GantryError).kind).toBe("notFound");
  });

  it("formats a command line", () => {
    expect(commandLine([])).toBe("–");
    expect(commandLine(["nginx", "-g", "daemon off;", ""])).toBe('nginx -g "daemon off;" ""');
  });

  it("formats a restart policy", () => {
    expect(restartPolicyLabel({ name: "always", maxRetries: 0 })).toBe("always");
    expect(restartPolicyLabel({ name: "on-failure", maxRetries: 0 })).toBe("on-failure");
    expect(restartPolicyLabel({ name: "on-failure", maxRetries: 3 })).toBe(
      "on-failure (max 3 retries)",
    );
  });

  it("masks a value but not its absence", () => {
    expect(maskValue("secret")).toBe("••••••••");
    expect(maskValue("")).toBe("");
    expect(maskValue("secret")).not.toContain("secret");
  });

  it("shows a specific host address in a port label", () => {
    const port = { ip: "127.0.0.1", privatePort: 80, publicPort: 8080, protocol: "tcp" };
    expect(boundPortLabel(port)).toBe("127.0.0.1:8080→80/tcp");
    expect(boundPortLabel({ ...port, ip: "0.0.0.0" })).toBe("8080→80/tcp");
    expect(boundPortLabel({ ...port, ip: "::" })).toBe("8080→80/tcp");
  });

  it("builds and parses the detail route", () => {
    expect(containerPath("abc")).toBe("/containers/abc");
    expect(parseContainerPath("/containers/abc")).toBe("abc");
    expect(parseContainerPath(containerPath("a/b"))).toBe("a/b");
    expect(parseContainerPath("/containers")).toBeNull();
    expect(parseContainerPath("/images/abc")).toBeNull();
  });

  it("masks the environment values of the raw JSON until revealed", () => {
    const raw = JSON.stringify({ Config: { Env: ["DB_PASSWORD=hunter2", "EMPTY=", "NOEQ"] } });
    const masked = rawJson(raw, false);
    expect(masked).not.toContain("hunter2");
    expect(masked).toContain("DB_PASSWORD=");
    expect(JSON.parse(masked).Config.Env[2]).toBe("NOEQ");
    expect(rawJson(raw, true)).toBe(raw);
    expect(rawJson("not json", false)).toBe("not json");
  });
});

describe("streamContainerLogs", () => {
  beforeEach(() => {
    tauri.invoke.mockReset();
    tauri.channels.length = 0;
  });

  const options = { follow: true, tail: 100, since: null, timestamps: false };

  it("forwards line batches and stops with the same watch id", async () => {
    tauri.invoke.mockImplementation((command: string) =>
      command === "containers_logs" ? new Promise<void>(() => {}) : Promise.resolve(),
    );
    const batches: unknown[] = [];
    const onEnd = vi.fn();
    const stop = streamContainerLogs(
      endpoint("unix", "unix:///x.sock"),
      "abc",
      options,
      (lines) => batches.push(lines),
      onEnd,
    );
    const [command, args] = tauri.invoke.mock.calls[0];
    expect(command).toBe("containers_logs");
    expect(args).toMatchObject({ id: "abc", options, watchId: expect.any(String) });

    const lines = [{ stream: "stdout", text: "hi" }];
    tauri.channels[0].onmessage({ type: "lines", lines });
    expect(batches).toEqual([lines]);

    stop();
    stop();
    const unwatch = tauri.invoke.mock.calls.filter(([c]) => c === "containers_unwatch");
    expect(unwatch).toEqual([["containers_unwatch", { watchId: args.watchId }]]);
    tauri.channels[0].onmessage({ type: "lines", lines });
    expect(batches).toHaveLength(1);
    expect(onEnd).not.toHaveBeenCalled();
  });

  it("reports the end and a failure", async () => {
    tauri.invoke.mockResolvedValueOnce(undefined);
    const onEnd = vi.fn();
    streamContainerLogs(endpoint("unix", "u"), "a", options, () => {}, onEnd);
    await Promise.resolve();
    await Promise.resolve();
    expect(onEnd).toHaveBeenCalledWith(null);

    tauri.invoke.mockRejectedValueOnce({ kind: "notFound", message: "gone" });
    const onEnd2 = vi.fn();
    streamContainerLogs(endpoint("unix", "u"), "a", options, () => {}, onEnd2);
    await new Promise((r) => setTimeout(r));
    expect(onEnd2).toHaveBeenCalledWith(expect.objectContaining({ kind: "notFound" }));
  });
});

describe("actionLook", () => {
  it("keeps a disabled action outlined and grey", () => {
    for (const kind of ACTION_KINDS) {
      expect(actionLook(kind, false)).toEqual({ variant: "outlined", severity: "secondary" });
    }
  });

  it("fills an enabled action: primary, and danger for kill and remove", () => {
    expect(actionLook("start", true)).toEqual({ variant: "filled", severity: "primary" });
    expect(actionLook("unpause", true)).toEqual({ variant: "filled", severity: "primary" });
    expect(actionLook("kill", true)).toEqual({ variant: "filled", severity: "danger" });
    expect(actionLook("remove", true)).toEqual({ variant: "filled", severity: "danger" });
  });
});
