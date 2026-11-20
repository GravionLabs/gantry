import { describe, expect, it, vi } from "vitest";

const tauri = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke, Channel: class {} }));

import { detectEndpoints } from "./endpoints";

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
