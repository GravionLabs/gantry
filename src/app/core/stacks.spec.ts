import { beforeEach, describe, expect, it, vi } from "vitest";

const tauri = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: tauri.invoke,
  Channel: class {
    onmessage: ((event: unknown) => void) | undefined;
  },
}));

import type { Container, Endpoint, Stack } from "./bindings";
import {
  actionCommand,
  checkCompose,
  composeProject,
  finishedMessage,
  listStacks,
  runCompose,
  serviceCount,
  stackRows,
  stackSummary,
  toggleStack,
} from "./stacks";

const endpoint: Endpoint = {
  name: "local",
  kind: "unix",
  address: "unix:///x.sock",
  tls: null,
  skipTlsVerify: false,
  readOnly: false,
};

const stack: Stack = {
  name: "shop",
  workingDir: "/srv/shop",
  configFiles: ["/srv/shop/compose.yml"],
  running: 2,
  total: 3,
  services: [
    { name: "db", containers: [] },
    { name: "web", containers: [] },
  ],
};

describe("stacks", () => {
  beforeEach(() => tauri.invoke.mockReset());

  it("lists the stacks through the stacks_list command", async () => {
    tauri.invoke.mockResolvedValue([stack]);
    await expect(listStacks(endpoint)).resolves.toEqual([stack]);
    expect(tauri.invoke).toHaveBeenCalledWith("stacks_list", { endpoint });
  });

  it("summarizes the state and counts the services", () => {
    expect(stackSummary(stack)).toBe("2/3 running");
    expect(serviceCount(stack)).toBe(2);
  });

  it("passes the name, directory and files of a stack to the CLI", () => {
    expect(composeProject(stack)).toEqual({
      name: "shop",
      workingDir: "/srv/shop",
      configFiles: ["/srv/shop/compose.yml"],
    });
  });

  it("checks the availability through compose_check", async () => {
    const availability = { available: false, version: null, reason: "no plugin" };
    tauri.invoke.mockResolvedValue(availability);
    const project = composeProject(stack);
    await expect(checkCompose(project)).resolves.toEqual(availability);
    expect(tauri.invoke).toHaveBeenCalledWith("compose_check", { project });
  });

  it("runs an action through compose_run with a channel and stops it by watch id", async () => {
    tauri.invoke.mockResolvedValue(undefined);
    const project = composeProject(stack);
    const run = runCompose(endpoint, project, { type: "down", volumes: true }, () => {});
    await run.done;
    const [command, args] = tauri.invoke.mock.calls[0];
    expect(command).toBe("compose_run");
    expect(args).toMatchObject({ endpoint, project, action: { type: "down", volumes: true } });
    run.stop();
    expect(tauri.invoke).toHaveBeenLastCalledWith("containers_unwatch", {
      watchId: args.watchId,
    });
  });

  it("names the commands and the way they ended", () => {
    expect(actionCommand({ type: "up" })).toBe("docker compose up -d");
    expect(actionCommand({ type: "down", volumes: true })).toBe("docker compose down -v");
    expect(actionCommand({ type: "down", volumes: false })).toBe("docker compose down");
    const up = { type: "up" } as const;
    const ended = (success: boolean, code: number | null) =>
      finishedMessage(up, { type: "finished", success, code });
    expect(ended(true, 0)).toBe("docker compose up -d finished.");
    expect(ended(false, 1)).toBe("docker compose up -d failed with exit code 1.");
    expect(ended(false, null)).toBe("docker compose up -d was stopped.");
  });
});

function container(name: string): Container {
  return {
    id: `id-${name}`,
    name,
    image: "nginx",
    state: "running",
    health: null,
    status: "Up",
    ports: [],
    created: 0,
    composeProject: "shop",
  };
}

describe("stackRows", () => {
  const shop: Stack = {
    ...stack,
    services: [
      { name: "db", containers: [container("shop-db-1")] },
      { name: "web", containers: [container("shop-web-1"), container("shop-web-2")] },
    ],
  };
  const api: Stack = { ...stack, name: "api", services: [] };

  it("lists the stacks by name, all collapsed", () => {
    const rows = stackRows([shop, api], new Set());
    expect(rows.map((r) => [r.kind, r.id])).toEqual([
      ["stack", "stack:api"],
      ["stack", "stack:shop"],
    ]);
    expect(rows.every((r) => r.kind === "stack" && !r.expanded)).toBe(true);
  });

  it("puts the containers of an expanded stack below it, in service order", () => {
    const rows = stackRows([shop, api], new Set(["shop", "gone"]));
    expect(
      rows.map((r) => (r.kind === "stack" ? r.stack.name : `${r.service}/${r.container.name}`)),
    ).toEqual(["api", "shop", "db/shop-db-1", "web/shop-web-1", "web/shop-web-2"]);
    expect(rows[1]).toMatchObject({ kind: "stack", expanded: true });
    expect(rows[2]).toMatchObject({
      kind: "container",
      stack: "shop",
      id: "container:id-shop-db-1",
    });
  });

  it("opens and closes a stack without changing the input", () => {
    const none = new Set<string>();
    const open = toggleStack(none, "shop");
    expect([...open]).toEqual(["shop"]);
    expect(none.size).toBe(0);
    expect(toggleStack(open, "shop").size).toBe(0);
  });
});
