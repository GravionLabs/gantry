import { describe, expect, it, vi } from "vitest";

const tauri = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke, Channel: class {} }));

import { describeEngine, pingEndpoint, pingEngine } from "./engine";
import { GantryError } from "./invoke";

describe("pingEngine", () => {
  it("calls engine_ping", async () => {
    const info = { version: "28", apiVersion: "1.49", os: "linux", arch: "amd64" };
    tauri.invoke.mockResolvedValue(info);
    await expect(pingEngine()).resolves.toEqual(info);
    expect(tauri.invoke).toHaveBeenCalledWith("engine_ping", undefined);
  });

  it("fails with a typed error", async () => {
    tauri.invoke.mockRejectedValue({ kind: "unreachable", message: "no socket" });
    const error = await pingEngine().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GantryError);
    expect(error).toMatchObject({ kind: "unreachable" });
  });
});

describe("pingEndpoint", () => {
  it("calls endpoint_ping with name and address", async () => {
    tauri.invoke.mockResolvedValue({});
    await pingEndpoint({ name: "build", address: "ssh://deploy@build-01" });
    expect(tauri.invoke).toHaveBeenCalledWith("endpoint_ping", {
      name: "build",
      address: "ssh://deploy@build-01",
    });
  });
});

describe("describeEngine", () => {
  it("names version, API and platform", () => {
    expect(
      describeEngine({ version: "28.1.1", apiVersion: "1.49", os: "linux", arch: "amd64" }),
    ).toBe("Docker 28.1.1 (API 1.49, linux/amd64)");
  });

  it("marks missing values as unknown", () => {
    expect(describeEngine({ version: null, apiVersion: null, os: null, arch: null })).toBe(
      "Docker unknown (API unknown)",
    );
  });
});
