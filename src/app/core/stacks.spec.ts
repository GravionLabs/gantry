import { beforeEach, describe, expect, it, vi } from "vitest";

const tauri = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke, Channel: class {} }));

import type { Endpoint, Stack } from "./bindings";
import { listStacks, serviceCount, stackSummary } from "./stacks";

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
});
