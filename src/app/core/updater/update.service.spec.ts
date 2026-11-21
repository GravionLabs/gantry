import { getVersion } from "@tauri-apps/api/app";
import { relaunch } from "@tauri-apps/plugin-process";
import { check } from "@tauri-apps/plugin-updater";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/app", () => ({ getVersion: vi.fn() }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: vi.fn() }));
vi.mock("@tauri-apps/plugin-updater", () => ({ check: vi.fn(), Update: class {} }));

import { UpdateService } from "./update.service";

function fakeUpdate(version: string, download = vi.fn().mockResolvedValue(undefined)) {
  return { version, body: "notes", downloadAndInstall: download };
}

describe("UpdateService", () => {
  let updater: UpdateService;

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(getVersion).mockResolvedValue("1.0.0");
    updater = new UpdateService();
  });

  it("makes no network call until a check is requested", async () => {
    await updater.init();
    expect(updater.version()).toBe("1.0.0");
    expect(check).not.toHaveBeenCalled();
    expect(updater.phase()).toBe("idle");
  });

  it("offers a newer version with its notes", async () => {
    vi.mocked(check).mockResolvedValue(fakeUpdate("1.1.0") as never);
    await updater.check();
    expect(updater.phase()).toBe("available");
    expect(updater.update()?.version).toBe("1.1.0");
    expect(updater.update()?.body).toBe("notes");
  });

  it("reports up to date when there is no update", async () => {
    vi.mocked(check).mockResolvedValue(null);
    await updater.check();
    expect(updater.phase()).toBe("idle");
    expect(updater.upToDate()).toBe(true);
  });

  it("ignores a pre-release answer on a stable version", async () => {
    vi.mocked(check).mockResolvedValue(fakeUpdate("1.1.0-rc1") as never);
    await updater.check();
    expect(updater.update()).toBeNull();
    expect(updater.upToDate()).toBe(true);
  });

  it("offers no update to an RC build and does not ask the endpoint", async () => {
    vi.mocked(getVersion).mockResolvedValue("1.0.0-rc1");
    await updater.check();
    expect(check).not.toHaveBeenCalled();
    expect(updater.enabled()).toBe(false);
    expect(updater.update()).toBeNull();
    expect(updater.phase()).toBe("idle");
  });

  it("names the failed check step", async () => {
    vi.mocked(check).mockRejectedValue(new Error("offline"));
    await updater.check();
    expect(updater.phase()).toBe("error");
    expect(updater.failedStep()).toBe("check");
    expect(updater.error()).toBe("Check for updates failed: offline");
  });

  it("installs and restarts", async () => {
    const download = vi.fn().mockResolvedValue(undefined);
    vi.mocked(check).mockResolvedValue(fakeUpdate("1.1.0", download) as never);
    await updater.check();
    await updater.install();
    expect(download).toHaveBeenCalledOnce();
    expect(relaunch).toHaveBeenCalledOnce();
  });

  it("tracks the download progress", async () => {
    const download = vi.fn(async (cb: (e: unknown) => void) => {
      cb({ event: "Started", data: { contentLength: 200 } });
      cb({ event: "Progress", data: { chunkLength: 50 } });
      expect(updater.percent()).toBe(25);
    });
    vi.mocked(check).mockResolvedValue(fakeUpdate("1.1.0", download as never) as never);
    await updater.check();
    await updater.install();
  });

  it("keeps the update after a failed install and retries without a new check", async () => {
    const download = vi
      .fn()
      .mockRejectedValueOnce(new Error("bad signature"))
      .mockResolvedValue(undefined);
    vi.mocked(check).mockResolvedValue(fakeUpdate("1.1.0", download) as never);
    await updater.check();
    await updater.install();
    expect(updater.phase()).toBe("error");
    expect(updater.failedStep()).toBe("update");
    expect(updater.error()).toBe("Update failed: bad signature");
    expect(updater.update()?.version).toBe("1.1.0");

    await updater.install();
    expect(check).toHaveBeenCalledOnce();
    expect(download).toHaveBeenCalledTimes(2);
    expect(relaunch).toHaveBeenCalledOnce();
  });
});
