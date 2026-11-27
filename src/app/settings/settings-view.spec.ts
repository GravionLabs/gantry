// @vitest-environment happy-dom
import { signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { BrowserTestingModule, platformBrowserTesting } from "@angular/platform-browser/testing";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SETTINGS_BACKEND, SettingsService } from "../core/settings/settings.service";
import { HxUpdateService } from "../core/shell/shell.service";
import { renderTemplateOf } from "../../../testing/render-template";
import { SettingsView } from "./settings-view";

TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting());

async function open(load: () => Promise<unknown> = async () => ({})) {
  const save = vi.fn(async () => {});
  const state = signal<{ status: string }>({ status: "idle" });
  const check = vi.fn(async () => state.set({ status: "checking" }));
  renderTemplateOf(SettingsView, "settings/settings-view.html");
  TestBed.configureTestingModule({
    providers: [
      { provide: SETTINGS_BACKEND, useValue: { load, save } },
      { provide: HxUpdateService, useValue: { channel: "stable", state, check } },
    ],
  });
  const settings = TestBed.inject(SettingsService);
  await settings.load();
  const fixture = TestBed.createComponent(SettingsView);
  fixture.detectChanges();
  const element = fixture.nativeElement as HTMLElement;
  const rows = () => [...element.querySelectorAll<HTMLButtonElement>("button[hx-list-row]")];
  const category = (label: string) => {
    rows()
      .find((row) => row.textContent?.trim() === label)
      ?.click();
    fixture.detectChanges();
  };
  /** The control of the field with this label. */
  const control = (label: string) => {
    const found = [...element.querySelectorAll("label")].find(
      (l) => l.textContent?.trim() === label,
    );
    return element.querySelector<HTMLInputElement>(`#${found?.htmlFor}`) as HTMLInputElement;
  };
  const click = (label: string) => {
    control(label).click();
    fixture.detectChanges();
  };
  return { fixture, element, settings, save, state, check, rows, category, control, click };
}

describe("settings view", () => {
  afterEach(() => {
    TestBed.resetTestingModule();
    localStorage.clear();
  });

  it("picks a category in the list and marks it as the current page", async () => {
    const { element, rows, category } = await open();
    expect(rows()).toHaveLength(4);
    expect(rows()[0]?.getAttribute("aria-current")).toBe("page");

    category("Engine");

    expect(element.querySelector("h2")?.textContent).toBe("Engine");
    expect(rows()[3]?.getAttribute("aria-current")).toBe("page");
    expect(rows()[0]?.hasAttribute("aria-current")).toBe(false);
  });

  it("changes the theme with a radio", async () => {
    const { element, settings, save, control, click } = await open();
    expect(element.querySelector("legend")?.textContent).toContain("Theme");
    expect(control("System").checked).toBe(true);

    click("Dark");

    expect(control("Dark").matches("input[type=radio][hx-radio]")).toBe(true);
    expect(settings.appearance().theme).toBe("dark");
    expect(save).toHaveBeenCalledOnce();
  });

  it("changes the refresh interval with a radio", async () => {
    const { element, settings, category, control, click } = await open();
    category("Engine");
    expect(control("Off").checked).toBe(true);
    expect(element.querySelector(".hx-field-hint")?.textContent).toContain("Off refreshes");

    click("5 s");

    expect(settings.engine().refreshSeconds).toBe(5);
  });

  it("switches the automatic update check", async () => {
    const { settings, category, control, click } = await open();
    category("Updates");
    expect(control("Check for updates automatically").matches("input[hx-switch]")).toBe(true);

    click("Check for updates automatically");

    expect(settings.updates().autoCheck).toBe(false);
  });

  it("switches each containers view default", async () => {
    const { settings, category, control, click } = await open();
    category("Containers");
    expect(control("Group by stack").matches("input[hx-switch]")).toBe(true);

    click("Show CPU and memory");
    expect(settings.containers()).toEqual({ showStats: true, groupByStack: false });

    click("Group by stack");
    expect(settings.containers()).toEqual({ showStats: true, groupByStack: true });
  });

  it("says that the update check failed and what to do", async () => {
    const { fixture, element, state, category } = await open();
    category("Updates");
    expect(element.querySelector("hx-message")).toBeNull();

    state.set({ status: "error", message: "network down" });
    fixture.detectChanges();

    const message = element.querySelector("hx-message[severity=error][role=alert]");
    expect(message?.textContent?.trim()).toBe(
      "The update check failed. Check your connection and try again.",
    );
  });

  it("says that a setting was not saved and retries the save", async () => {
    const { fixture, element, settings, save, click } = await open();
    save.mockRejectedValueOnce(new Error("disk full"));

    click("Dark");
    await fixture.whenStable();
    fixture.detectChanges();

    const message = element.querySelector("hx-message[severity=error][role=alert]");
    expect(message?.textContent).toContain("The setting was not saved.");
    expect(message?.textContent).toContain("then retry");

    message?.querySelector<HTMLButtonElement>("button[hx-button]")?.click();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(save).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenLastCalledWith(settings.settings());
    expect(element.querySelector("hx-message")).toBeNull();
  });

  it("says that the settings could not be loaded and what to do", async () => {
    const { element } = await open(async () => {
      throw new Error("bad file");
    });

    const message = element.querySelector("hx-message[severity=error][role=alert]");
    expect(message?.textContent).toContain("could not be loaded, so the defaults apply");
    expect(message?.textContent).toContain("Restart Gantry");
    expect(message?.querySelector("button")).toBeNull();
  });

  it("shows Check now as loading while checking", async () => {
    const { fixture, element, state, check, category } = await open();
    category("Updates");
    const button = element.querySelector<HTMLButtonElement>(
      ".check-now button[hx-button]",
    ) as HTMLButtonElement;
    expect(button.getAttribute("aria-busy")).not.toBe("true");

    button.click();
    fixture.detectChanges();
    expect(check).toHaveBeenCalledOnce();
    expect(button.getAttribute("aria-busy")).toBe("true");

    button.click();
    expect(check).toHaveBeenCalledOnce();

    state.set({ status: "current" });
    fixture.detectChanges();
    expect(button.getAttribute("aria-busy")).not.toBe("true");
  });
});
