import { describe, expect, it, vi } from "vitest";

const tauri = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke, Channel: class {} }));

import { buildEndpoint, detectEndpoints, listContexts } from "./endpoints";

describe("detectEndpoints", () => {
  it("calls endpoints_detect", async () => {
    const found = [
      {
        source: "Docker",
        endpoint: { name: "Docker", kind: "unix", address: "unix:///var/run/docker.sock" },
        status: { state: "notRunning" },
      },
    ];
    tauri.invoke.mockResolvedValue(found);
    await expect(detectEndpoints()).resolves.toEqual(found);
    expect(tauri.invoke).toHaveBeenCalledWith("endpoints_detect", undefined);
  });
});

describe("buildEndpoint and listContexts", () => {
  it("calls endpoint_build with the typed values", async () => {
    tauri.invoke.mockResolvedValue({ name: "x" });
    await buildEndpoint("x", "tcp://h:2375", null);
    expect(tauri.invoke).toHaveBeenCalledWith("endpoint_build", {
      name: "x",
      address: "tcp://h:2375",
      tls: null,
    });
  });

  it("calls endpoints_contexts", async () => {
    tauri.invoke.mockResolvedValue({ contexts: [], current: "default", warnings: [] });
    await listContexts();
    expect(tauri.invoke).toHaveBeenCalledWith("endpoints_contexts", undefined);
  });
});
