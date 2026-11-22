import { Injector } from "@angular/core";
import { describe, expect, it, vi } from "vitest";

import { DEFAULT_SETTINGS, sanitizeSettings } from "./settings-core";
import { SETTINGS_BACKEND, SettingsService, type SettingsBackend } from "./settings.service";

function setup(stored: unknown, fail = false) {
  const save = vi.fn<SettingsBackend["save"]>(async () => {
    if (fail) throw new Error("disk full");
  });
  const load = vi.fn(async () => {
    if (stored instanceof Error) throw stored;
    return stored;
  });
  const injector = Injector.create({
    providers: [
      { provide: SETTINGS_BACKEND, useValue: { load, save } },
      { provide: SettingsService, useClass: SettingsService, deps: [] },
    ],
  });
  return { service: injector.get(SettingsService), load, save };
}

describe("sanitizeSettings", () => {
  it("gives the defaults for an empty or foreign file", () => {
    expect(sanitizeSettings({})).toEqual(DEFAULT_SETTINGS);
    expect(sanitizeSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(sanitizeSettings([1])).toEqual(DEFAULT_SETTINGS);
  });

  it("keeps a stored value", () => {
    expect(sanitizeSettings({ appearance: { theme: "dark" } }).appearance.theme).toBe("dark");
  });

  it("falls back to the default for an invalid value and drops unknown keys", () => {
    const result = sanitizeSettings({ appearance: { theme: "neon", extra: 1 }, other: true });
    expect(result).toEqual(DEFAULT_SETTINGS);
  });
});

describe("SettingsService", () => {
  it("starts with the defaults and loads a stored value once", async () => {
    const { service, load } = setup({ appearance: { theme: "light" } });
    expect(service.appearance().theme).toBe("system");
    expect(service.loaded()).toBe(false);
    await service.load();
    await service.load();
    expect(load).toHaveBeenCalledTimes(1);
    expect(service.appearance().theme).toBe("light");
    expect(service.loaded()).toBe(true);
  });

  it("keeps the defaults and reports the error when the file cannot be read", async () => {
    const { service } = setup(new Error("settings file /x: bad"));
    await service.load();
    expect(service.settings()).toEqual(DEFAULT_SETTINGS);
    expect(service.error()).toBe("settings file /x: bad");
    expect(service.loaded()).toBe(true);
  });

  it("writes a change through save_settings", async () => {
    const { service, save } = setup({});
    await service.load();
    await service.update((s) => ({ ...s, appearance: { theme: "dark" } }));
    expect(service.appearance().theme).toBe("dark");
    expect(save).toHaveBeenCalledWith({ appearance: { theme: "dark" } });
    expect(service.error()).toBeNull();
  });

  it("sanitizes a change and reports a failed write", async () => {
    const { service, save } = setup({}, true);
    await service.update((s) => ({ ...s, appearance: { theme: "neon" as never } }));
    expect(save).toHaveBeenCalledWith(DEFAULT_SETTINGS);
    expect(service.error()).toBe("disk full");
  });
});
