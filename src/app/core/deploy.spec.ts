import { beforeEach, describe, expect, it, vi } from "vitest";

const tauri = vi.hoisted(() => ({ invoke: vi.fn(), open: vi.fn(), store: new Map() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke, Channel: class {} }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: tauri.open }));
vi.mock("@tauri-apps/plugin-store", () => ({
  load: async () => ({
    get: async (k: string) => tauri.store.get(k),
    set: async (k: string, v: unknown) => void tauri.store.set(k, v),
    save: async () => {},
  }),
}));

import {
  RECENT_LIMIT,
  addRecent,
  deployProject,
  pickFile,
  previewComposeFile,
  tauriRecentDeploys,
  type RecentDeploy,
} from "./deploy";

const entry = (composeFile: string, name = "x"): RecentDeploy => ({
  composeFile,
  envFile: null,
  name,
});

beforeEach(() => {
  tauri.invoke.mockReset();
  tauri.open.mockReset();
  tauri.store.clear();
});

describe("addRecent", () => {
  it("puts the newest first and replaces the same file", () => {
    const list = addRecent([entry("/a"), entry("/b")], entry("/b", "new"));
    expect(list.map((r) => r.composeFile)).toEqual(["/b", "/a"]);
    expect(list[0].name).toBe("new");
  });

  it("keeps only the newest entries", () => {
    let list: readonly RecentDeploy[] = [];
    for (let i = 0; i < RECENT_LIMIT + 3; i++) list = addRecent(list, entry(`/f${i}`));
    expect(list).toHaveLength(RECENT_LIMIT);
    expect(list[0].composeFile).toBe(`/f${RECENT_LIMIT + 2}`);
  });
});

describe("recent deploys store", () => {
  it("remembers entries per endpoint", async () => {
    const recent = tauriRecentDeploys();
    await recent.remember("unix:///a", entry("/one"));
    await recent.remember("ssh://b", entry("/two"));
    await recent.remember("unix:///a", entry("/three"));
    expect((await recent.list("unix:///a")).map((r) => r.composeFile)).toEqual(["/three", "/one"]);
    expect((await recent.list("ssh://b")).map((r) => r.composeFile)).toEqual(["/two"]);
    expect(await recent.list("tcp://none")).toEqual([]);
  });

  it("ignores malformed stored entries", async () => {
    tauri.store.set("byEndpoint", { "unix:///a": [{ composeFile: 1 }, entry("/ok")] });
    expect(await tauriRecentDeploys().list("unix:///a")).toEqual([entry("/ok")]);
  });
});

describe("commands", () => {
  it("picks a file and reports a cancelled dialog as null", async () => {
    tauri.open.mockResolvedValueOnce("/srv/compose.yml").mockResolvedValueOnce(null);
    expect(await pickFile("Pick", ["yml"])).toBe("/srv/compose.yml");
    expect(tauri.open).toHaveBeenCalledWith(
      expect.objectContaining({ multiple: false, directory: false }),
    );
    expect(await pickFile("Pick")).toBeNull();
  });

  it("calls the preview and project commands", async () => {
    tauri.invoke.mockResolvedValue("ok");
    await previewComposeFile("/c.yml");
    expect(tauri.invoke).toHaveBeenCalledWith("compose_preview", { path: "/c.yml" });
    await deployProject("/c.yml", null, "shop");
    expect(tauri.invoke).toHaveBeenLastCalledWith("compose_deploy_project", {
      composeFile: "/c.yml",
      envFile: null,
      name: "shop",
    });
  });
});
