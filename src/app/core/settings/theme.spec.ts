// @vitest-environment happy-dom
import { TestBed } from "@angular/core/testing";
import { BrowserTestingModule, platformBrowserTesting } from "@angular/platform-browser/testing";
import { HxTheme } from "@gravionlabs/helix-ui";
import { afterEach, describe, expect, it, vi } from "vitest";

import { THEMES, type Theme } from "./settings-core";
import { SETTINGS_BACKEND } from "./settings.service";
import { SettingsService } from "./settings.service";
import { SYSTEM_SCHEME, ThemeService, resolveDark } from "./theme";

function setup(stored: Theme | undefined, systemDark: boolean) {
  const setDark = vi.fn<(dark: boolean) => void>();
  const save = vi.fn(async () => {});
  let notify: (dark: boolean) => void = () => {};
  TestBed.configureTestingModule({
    providers: [
      { provide: HxTheme, useValue: { setDark } },
      {
        provide: SETTINGS_BACKEND,
        useValue: {
          load: async () => (stored ? { appearance: { theme: stored } } : {}),
          save,
        },
      },
      {
        provide: SYSTEM_SCHEME,
        useValue: {
          dark: systemDark,
          onChange: (l: (d: boolean) => void) => (notify = l),
        },
      },
    ],
  });
  return { setDark, save, notify: (dark: boolean) => notify(dark) };
}

TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting());

describe("resolveDark", () => {
  it("follows the system for System", () => {
    expect(resolveDark("system", true)).toBe(true);
    expect(resolveDark("system", false)).toBe(false);
  });
  it("ignores the system for Light and Dark", () => {
    expect(resolveDark("light", true)).toBe(false);
    expect(resolveDark("dark", false)).toBe(true);
  });
});

describe("ThemeService", () => {
  afterEach(() => TestBed.resetTestingModule());

  it("offers System, Light and Dark", () => {
    expect(THEMES).toEqual(["system", "light", "dark"]);
  });

  it("uses System by default", () => {
    const { setDark } = setup(undefined, true);
    TestBed.inject(ThemeService);
    TestBed.tick();
    expect(setDark).toHaveBeenLastCalledWith(true);
  });

  it("follows a change of the system under System", () => {
    const { setDark, notify } = setup(undefined, false);
    TestBed.inject(ThemeService);
    TestBed.tick();
    expect(setDark).toHaveBeenLastCalledWith(false);
    notify(true);
    TestBed.tick();
    expect(setDark).toHaveBeenLastCalledWith(true);
  });

  it.each([
    ["light", true, false],
    ["dark", false, true],
  ] as const)("applies %s at once and stores it", async (theme, systemDark, dark) => {
    const { setDark, save } = setup(undefined, systemDark);
    const service = TestBed.inject(ThemeService);
    TestBed.tick();
    await service.setTheme(theme);
    TestBed.tick();
    expect(setDark).toHaveBeenLastCalledWith(dark);
    expect(save).toHaveBeenCalledWith({ appearance: { theme } });
  });

  it.each([
    ["light", false],
    ["dark", true],
  ] as const)("restores %s on startup", async (stored, dark) => {
    const { setDark } = setup(stored, !dark);
    TestBed.inject(ThemeService);
    await TestBed.inject(SettingsService).load();
    TestBed.tick();
    expect(setDark).toHaveBeenLastCalledWith(dark);
  });
});
