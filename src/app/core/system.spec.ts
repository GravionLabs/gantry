import { beforeEach, describe, expect, it, vi } from "vitest";

const tauri = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: tauri.invoke,
  Channel: class {
    onmessage: ((event: unknown) => void) | undefined;
  },
}));

import type { CleanupPreview, CleanupResult, Endpoint } from "./bindings";
import {
  CATEGORIES,
  categoryLabel,
  categoryScope,
  cleanupSummary,
  countLabel,
  cpuLabel,
  previewCleanup,
  previewTotal,
  readOverview,
  reclaimablePercent,
  reclaimedTotal,
  runCleanup,
  sizeOrDash,
} from "./system";

const endpoint: Endpoint = {
  name: "local",
  kind: "unix",
  address: "unix:///x.sock",
  tls: null,
  skipTlsVerify: false,
  readOnly: false,
};

describe("system commands", () => {
  beforeEach(() => tauri.invoke.mockReset());

  it("calls the system commands with the endpoint", async () => {
    tauri.invoke.mockResolvedValue({});
    await readOverview(endpoint);
    expect(tauri.invoke).toHaveBeenLastCalledWith("system_overview", { endpoint });
    await previewCleanup(endpoint, ["images", "volumes"]);
    expect(tauri.invoke).toHaveBeenLastCalledWith("system_cleanup_preview", {
      endpoint,
      categories: ["images", "volumes"],
    });
    await runCleanup(endpoint, ["containers"]);
    expect(tauri.invoke).toHaveBeenLastCalledWith("system_cleanup", {
      endpoint,
      categories: ["containers"],
    });
  });
});

describe("labels", () => {
  it("names every category and says what its cleanup removes", () => {
    for (const category of CATEGORIES) {
      expect(categoryLabel(category)).not.toBe("");
      expect(categoryScope(category)).not.toBe("");
    }
    expect(categoryLabel("buildCache")).toBe("Build cache");
  });

  it("shows a dash for what the engine does not report", () => {
    expect(sizeOrDash(null)).toBe("–");
    expect(sizeOrDash(2048)).toBe("2.00 KiB");
    expect(countLabel({ totalCount: null, activeCount: null })).toBe("–");
    expect(countLabel({ totalCount: 4, activeCount: null })).toBe("4");
    expect(countLabel({ totalCount: 4, activeCount: 1 })).toBe("4 (1 active)");
    expect(cpuLabel(null)).toBe("–");
    expect(cpuLabel(1)).toBe("1 CPU");
    expect(cpuLabel(8)).toBe("8 CPUs");
  });

  it("computes the reclaimable share of the used space", () => {
    expect(reclaimablePercent({ size: 200, reclaimable: 50 })).toBe(25);
    expect(reclaimablePercent({ size: 0, reclaimable: 0 })).toBe(0);
    expect(reclaimablePercent({ size: null, reclaimable: 5 })).toBe(0);
    expect(reclaimablePercent({ size: 10, reclaimable: null })).toBe(0);
    expect(reclaimablePercent({ size: 10, reclaimable: 99 })).toBe(100);
  });
});

function preview(category: CleanupPreview["category"], reclaimable: number | null): CleanupPreview {
  return { category, count: 1, names: ["x"], reclaimable };
}

describe("cleanup", () => {
  it("adds up the previewed sizes and is unknown when none is known", () => {
    expect(previewTotal([preview("images", 10), preview("containers", null)])).toBe(10);
    expect(previewTotal([preview("containers", null)])).toBeNull();
    expect(previewTotal([])).toBeNull();
  });

  const result: CleanupResult = {
    outcomes: [
      { category: "containers", removed: 3, reclaimed: 1024 },
      { category: "images", removed: 2, reclaimed: 1024 * 1024 },
    ],
    failures: [],
  };

  it("sums the freed space and names what was removed", () => {
    expect(reclaimedTotal(result)).toBe(1024 + 1024 * 1024);
    expect(cleanupSummary(result)).toBe("Freed 1.00 MiB (removed: Containers 3, Images 2).");
  });

  it("reports a failed category next to what was freed", () => {
    const partial: CleanupResult = {
      outcomes: [{ category: "images", removed: 1, reclaimed: 0 }],
      failures: [{ category: "volumes", message: "in use" }],
    };
    expect(cleanupSummary(partial)).toBe("Freed 0 B (removed: Images 1). Volumes failed: in use");
    expect(cleanupSummary({ outcomes: [], failures: [] })).toBe("Freed 0 B.");
  });
});
