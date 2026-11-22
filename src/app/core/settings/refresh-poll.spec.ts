// @vitest-environment happy-dom
import { Component } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { BrowserTestingModule, platformBrowserTesting } from "@angular/platform-browser/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { pollRefresh } from "./refresh-poll";
import { DEFAULT_SETTINGS, sanitizeSettings } from "./settings-core";
import { SETTINGS_BACKEND, SettingsService } from "./settings.service";

TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting());

const action = vi.fn();

@Component({ selector: "app-poll-host", template: "" })
class Host {
  constructor() {
    pollRefresh(action);
  }
}

async function setup(raw: unknown = {}) {
  TestBed.configureTestingModule({
    providers: [
      { provide: SETTINGS_BACKEND, useValue: { load: async () => raw, save: async () => {} } },
    ],
  });
  const settings = TestBed.inject(SettingsService);
  await settings.load();
  const fixture = TestBed.createComponent(Host);
  fixture.detectChanges();
  return { settings, fixture };
}

describe("refresh interval", () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
    vi.useFakeTimers();
    action.mockClear();
  });
  afterEach(() => vi.useRealTimers());

  it("is off by default and keeps only valid choices", () => {
    expect(DEFAULT_SETTINGS.engine.refreshSeconds).toBe(0);
    expect(sanitizeSettings({ engine: { refreshSeconds: 10 } }).engine.refreshSeconds).toBe(10);
    expect(sanitizeSettings({ engine: { refreshSeconds: 7 } }).engine.refreshSeconds).toBe(0);
    expect(sanitizeSettings({ engine: { refreshSeconds: "5" } }).engine.refreshSeconds).toBe(0);
  });

  it("does not poll while off", async () => {
    await setup();
    vi.advanceTimersByTime(120_000);
    expect(action).not.toHaveBeenCalled();
  });

  it("polls at the chosen interval and applies a change without restart", async () => {
    const { settings, fixture } = await setup({ engine: { refreshSeconds: 5 } });
    vi.advanceTimersByTime(10_000);
    expect(action).toHaveBeenCalledTimes(2);

    await settings.update((c) => ({ ...c, engine: { refreshSeconds: 2 } }));
    fixture.detectChanges();
    action.mockClear();
    vi.advanceTimersByTime(6_000);
    expect(action).toHaveBeenCalledTimes(3);

    await settings.update((c) => ({ ...c, engine: { refreshSeconds: 0 } }));
    fixture.detectChanges();
    action.mockClear();
    vi.advanceTimersByTime(60_000);
    expect(action).not.toHaveBeenCalled();
  });

  it("stops when the component is destroyed", async () => {
    const { fixture } = await setup({ engine: { refreshSeconds: 2 } });
    fixture.destroy();
    vi.advanceTimersByTime(10_000);
    expect(action).not.toHaveBeenCalled();
  });
});
