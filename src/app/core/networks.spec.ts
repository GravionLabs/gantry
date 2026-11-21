import { beforeEach, describe, expect, it, vi } from "vitest";

const tauri = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: tauri.invoke,
  Channel: class {
    onmessage: ((event: unknown) => void) | undefined;
  },
}));

import type { Container, Endpoint, Network } from "./bindings";
import {
  connectable,
  connectedLabel,
  connectNetwork,
  createNetwork,
  disconnectNetwork,
  listNetworks,
  pruneCandidates,
  pruneNetworks,
  pruneSummary,
  removeNetwork,
  subnetLabel,
} from "./networks";

const endpoint: Endpoint = {
  name: "local",
  kind: "unix",
  address: "unix:///x.sock",
  tls: null,
  skipTlsVerify: false,
  readOnly: false,
};

function network(name: string, containers: string[] = [], builtin = false): Network {
  return {
    id: `id-${name}`,
    name,
    driver: "bridge",
    scope: "local",
    subnets: [],
    containers,
    builtin,
  };
}

describe("network commands", () => {
  beforeEach(() => tauri.invoke.mockReset());

  it("calls the network commands with the endpoint", async () => {
    tauri.invoke.mockResolvedValue([]);
    await listNetworks(endpoint);
    expect(tauri.invoke).toHaveBeenLastCalledWith("networks_list", { endpoint });
    const spec = { name: "app", subnet: "172.30.0.0/16" };
    await createNetwork(endpoint, spec);
    expect(tauri.invoke).toHaveBeenLastCalledWith("networks_create", { endpoint, spec });
    await removeNetwork(endpoint, "app");
    expect(tauri.invoke).toHaveBeenLastCalledWith("networks_remove", { endpoint, name: "app" });
    await pruneNetworks(endpoint);
    expect(tauri.invoke).toHaveBeenLastCalledWith("networks_prune", { endpoint });
    await connectNetwork(endpoint, "app", "web");
    expect(tauri.invoke).toHaveBeenLastCalledWith("networks_connect", {
      endpoint,
      network: "app",
      container: "web",
    });
    await disconnectNetwork(endpoint, "app", "web", true);
    expect(tauri.invoke).toHaveBeenLastCalledWith("networks_disconnect", {
      endpoint,
      network: "app",
      container: "web",
      force: true,
    });
  });
});

describe("network labels", () => {
  it("shows the subnets or a dash", () => {
    expect(subnetLabel({ subnets: ["10.0.0.0/24", "fd00::/64"] })).toBe("10.0.0.0/24, fd00::/64");
    expect(subnetLabel({ subnets: [] })).toBe("–");
  });

  it("names the connected containers", () => {
    expect(connectedLabel([])).toBe("–");
    expect(connectedLabel(["web", "db"])).toBe("web, db");
  });

  it("prunes only unused networks that are not built in, and summarizes the result", () => {
    const rows = [network("bridge", [], true), network("a", ["web"]), network("b")];
    expect(pruneCandidates(rows).map((n) => n.name)).toEqual(["b"]);
    expect(pruneSummary({ removed: ["b"] })).toBe("Removed 1 network.");
    expect(pruneSummary({ removed: [] })).toBe("Removed 0 networks.");
  });

  it("offers the containers that are not on the network yet, by name", () => {
    const containers = [{ name: "web" }, { name: "db" }, { name: "cache" }] as Container[];
    expect(connectable(network("a", ["web"]), containers).map((c) => c.name)).toEqual([
      "cache",
      "db",
    ]);
  });
});
