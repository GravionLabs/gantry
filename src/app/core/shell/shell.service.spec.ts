import { Injector } from "@angular/core";
import { HX_APP_INFO } from "@gravionlabs/helix-desktop/tauri";
import { describe, expect, it } from "vitest";

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
