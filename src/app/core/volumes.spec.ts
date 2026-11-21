import { beforeEach, describe, expect, it, vi } from "vitest";

const tauri = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: tauri.invoke,
  Channel: class {
    onmessage: ((event: unknown) => void) | undefined;
  },
}));

import type { Endpoint, Volume } from "./bindings";
import {
  createVolume,
  listVolumes,
  parseLabels,
  pruneCandidates,
  pruneSummary,
  pruneVolumes,
  removeVolume,
  sizeLabel,
  volumeUsageLabel,
} from "./volumes";

const endpoint: Endpoint = {
  name: "local",
  kind: "unix",
  address: "unix:///x.sock",
  tls: null,
  skipTlsVerify: false,
  readOnly: false,
};

function volume(name: string, containers: string[] = [], size: number | null = null): Volume {
  return {
    name,
    driver: "local",
    mountpoint: `/v/${name}`,
    size,
    created: null,
    labels: [],
    containers,
  };
}

describe("volume commands", () => {
  beforeEach(() => tauri.invoke.mockReset());

  it("calls the volume commands with the endpoint", async () => {
    tauri.invoke.mockResolvedValue([]);
    await listVolumes(endpoint);
    expect(tauri.invoke).toHaveBeenLastCalledWith("volumes_list", { endpoint });
    const spec = { name: "data", driver: "", labels: [{ key: "a", value: "b" }] };
    await createVolume(endpoint, spec);
    expect(tauri.invoke).toHaveBeenLastCalledWith("volumes_create", { endpoint, spec });
    await removeVolume(endpoint, "data", false);
    expect(tauri.invoke).toHaveBeenLastCalledWith("volumes_remove", {
      endpoint,
      name: "data",
      force: false,
    });
    await pruneVolumes(endpoint);
    expect(tauri.invoke).toHaveBeenLastCalledWith("volumes_prune", { endpoint });
  });
});

describe("parseLabels", () => {
  it("reads one key=value per line, keeping '=' inside the value", () => {
    expect(parseLabels("team=core\n\n  env = prod \nflag\nurl=a=b")).toEqual([
      { key: "team", value: "core" },
      { key: "env", value: " prod" },
      { key: "flag", value: "" },
      { key: "url", value: "a=b" },
    ]);
    expect(parseLabels("")).toEqual([]);
  });

  it("rejects a line without a key", () => {
    expect(() => parseLabels("=value")).toThrow("has no label key");
  });
});

describe("volume labels", () => {
  it("shows the size or a dash", () => {
    expect(sizeLabel(volume("a", [], 2048))).toBe("2.00 KiB");
    expect(sizeLabel(volume("a"))).toBe("–");
  });

  it("names the containers that use a volume", () => {
    expect(volumeUsageLabel([])).toBe("unused");
    expect(volumeUsageLabel(["web", "db"])).toBe("in use by web, db");
  });

  it("prunes only unused volumes and summarizes the result", () => {
    expect(pruneCandidates([volume("a", ["web"]), volume("b")]).map((v) => v.name)).toEqual(["b"]);
    expect(pruneSummary({ removed: ["a"], reclaimed: 2048 })).toBe(
      "Removed 1 volume, 2.00 KiB reclaimed.",
    );
    expect(pruneSummary({ removed: [], reclaimed: null })).toBe(
      "Removed 0 volumes, 0 B reclaimed.",
    );
  });
});
