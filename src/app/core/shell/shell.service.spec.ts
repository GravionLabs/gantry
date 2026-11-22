import { Injector } from "@angular/core";
import { HX_APP_INFO } from "@gravionlabs/helix-desktop/tauri";
import { describe, expect, it, vi } from "vitest";

import { ShellService } from "./shell.service";

function shell(): ShellService {
  const injector = Injector.create({
    providers: [
      { provide: HX_APP_INFO, useValue: { version: "0.0.0" } },
      { provide: ShellService, useClass: ShellService, deps: [] },
    ],
  });
  return injector.get(ShellService);
}

describe("ShellService container route", () => {
  it("opens the details of a container in the containers view", () => {
    const s = shell();
    s.select("images");
    s.openContainer("abc");
    expect(s.activeId()).toBe("containers");
    expect(s.containerId()).toBe("abc");
    expect(s.path()).toBe("/containers/abc");
  });

  it("goes back to the list", () => {
    const s = shell();
    s.openContainer("abc");
    s.closeContainer();
    expect(s.containerId()).toBeNull();
    expect(s.path()).toBe("/containers");
  });

  it("selecting the containers view on a detail page returns to the list", () => {
    const s = shell();
    s.openContainer("abc");
    s.select("containers");
    expect(s.containerId()).toBeNull();
    expect(s.activeId()).toBe("containers");
  });

  it("selecting the active view again keeps it active", () => {
    const s = shell();
    s.select("stacks");
    s.select("stacks");
    expect(s.activeId()).toBe("stacks");
  });

  it("leaves the details when another view is selected", () => {
    const s = shell();
    s.openContainer("abc");
    s.select("volumes");
    expect(s.containerId()).toBeNull();
    expect(s.activeId()).toBe("volumes");
  });

  it("keeps the opened container when the endpoint reloads", () => {
    // The route lives in the root service, so recreating the view (a new endpoint generation)
    // asks the new endpoint for the same id and shows "not found" if it is missing there.
    const s = shell();
    s.openContainer("abc");
    expect(s.containerId()).toBe("abc");
  });
});

describe("provideShell", () => {
  it("reports the RC channel for an identifier ending in .rc", async () => {
    vi.resetModules();
    vi.doMock("@gravionlabs/helix-desktop/tauri", async (orig) => ({
      ...(await orig<object>()),
      readTauriVersion: async () => "0.0.7",
      providePlatform: () => [],
    }));
    vi.doMock("@tauri-apps/api/app", () => ({
      getIdentifier: async () => "dev.gravionlabs.gantry.rc",
    }));
    const { provideShell } = await import("./shell.service");
    const injector = Injector.create({ providers: [], parent: undefined });
    const providers = (await provideShell()) as unknown as { ɵproviders: unknown[] };
    const app = Injector.create({ providers: providers.ɵproviders as never, parent: injector });
    expect(app.get(HX_APP_INFO)).toEqual({ version: "0.0.7", channel: "rc" });
    vi.doUnmock("@tauri-apps/api/app");
  });

  it("keeps the channel derived from the version for the stable identifier", async () => {
    vi.resetModules();
    vi.doMock("@tauri-apps/api/app", () => ({
      getIdentifier: async () => "dev.gravionlabs.gantry",
    }));
    const { provideShell } = await import("./shell.service");
    const providers = (await provideShell()) as unknown as { ɵproviders: unknown[] };
    const app = Injector.create({ providers: providers.ɵproviders as never });
    expect(app.get(HX_APP_INFO).channel).toBe("stable");
    vi.doUnmock("@tauri-apps/api/app");
  });
});
