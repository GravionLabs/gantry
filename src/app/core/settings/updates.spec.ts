// @vitest-environment happy-dom
import { signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { BrowserTestingModule, platformBrowserTesting } from "@angular/platform-browser/testing";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_SETTINGS, sanitizeSettings } from "./settings-core";
import { SETTINGS_BACKEND } from "./settings.service";
import { HxUpdateService } from "../shell/shell.service";
import { UpdateSettings } from "./updates";

TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting());

function setup(stored: unknown, channel: "stable" | "rc" = "stable") {
  const state = signal<unknown>({ status: "idle" });
  const start = vi.fn(async () => {});
  const check = vi.fn(async () => {});
  const save = vi.fn(async () => {});
  TestBed.configureTestingModule({
    providers: [
      { provide: HxUpdateService, useValue: { channel, state, start, check } },
      { provide: SETTINGS_BACKEND, useValue: { load: async () => stored, save } },
    ],
  });
  return { updates: TestBed.inject(UpdateSettings), state, start, check, save };
}

describe("update settings", () => {
  afterEach(() => TestBed.resetTestingModule());

  it("is on by default and sanitizes the stored value", () => {
    expect(DEFAULT_SETTINGS.updates.autoCheck).toBe(true);
    expect(sanitizeSettings({ updates: { autoCheck: "no" } }).updates.autoCheck).toBe(true);
    expect(sanitizeSettings({ updates: { autoCheck: false } }).updates.autoCheck).toBe(false);
  });

  it("checks at startup when on", async () => {
    const { updates, start } = setup({});
    await updates.startup();
    expect(start).toHaveBeenCalledOnce();
  });

  it("does not check at startup when the stored choice is off", async () => {
    const { updates, start } = setup({ updates: { autoCheck: false } });
    await updates.startup();
    expect(start).not.toHaveBeenCalled();
  });

  it("stores the choice", async () => {
    const { updates, save } = setup({});
    await updates.setAutoCheck(false);
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ updates: { autoCheck: false } }));
  });

  it("knows the RC build, which Helix never checks automatically", async () => {
    const { updates } = setup({}, "rc");
    expect(updates.isRc).toBe(true);
  });

  it("checks on request and reports the result", () => {
    const { updates, state, check } = setup({});
    void updates.checkNow();
    expect(check).toHaveBeenCalledOnce();
    expect(updates.result()).toEqual({ kind: "none" });
    state.set({ status: "current" });
    expect(updates.result()).toEqual({ kind: "current" });
    state.set({ status: "available", update: { version: "1.2.3", notes: null, date: null } });
    expect(updates.result()).toEqual({ kind: "available", version: "1.2.3" });
    state.set({ status: "error", step: "check", message: "offline" });
    expect(updates.result()).toEqual({ kind: "error", message: "offline" });
  });
});
