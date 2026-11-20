import { describe, expect, it, vi } from "vitest";

const tauri = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke, Channel: class {} }));

import { describeEngine, pingEndpoint } from "./engine";
import { GantryError } from "./invoke";

const endpoint = {
  name: "local",
  kind: "unix" as const,
  address: "unix:///var/run/docker.sock",
  tls: null,
  skipTlsVerify: false,
  readOnly: false,
};

describe("pingEndpoint", () => {
  it("calls endpoint_test with the endpoint", async () => {
    const info = { version: "28", apiVersion: "1.49", os: "linux", arch: "amd64" };
    tauri.invoke.mockResolvedValue(info);
    await expect(pingEndpoint(endpoint)).resolves.toEqual(info);
    expect(tauri.invoke).toHaveBeenCalledWith("endpoint_test", { endpoint });
  });

  it("fails with a typed error", async () => {
    tauri.invoke.mockRejectedValue({ kind: "unreachable", message: "no socket" });
    const error = await pingEndpoint(endpoint).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GantryError);
    expect(error).toMatchObject({ kind: "unreachable" });
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
