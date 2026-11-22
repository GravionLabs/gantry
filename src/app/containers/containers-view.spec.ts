// @vitest-environment happy-dom
import { signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { BrowserTestingModule, platformBrowserTesting } from "@angular/platform-browser/testing";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ContainerList } from "../core/container-list";
import { EndpointStore } from "../core/endpoint-store";
import { SETTINGS_BACKEND, SettingsService } from "../core/settings/settings.service";
import { ShellService } from "../core/shell/shell.service";
import { StatsFeed } from "../core/stats";
import { ContainersView } from "./containers-view";

TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting());

async function open(stored: unknown) {
  TestBed.configureTestingModule({
    providers: [
      { provide: SETTINGS_BACKEND, useValue: { load: async () => stored, save: async () => {} } },
      { provide: EndpointStore, useValue: { active: () => null } },
      { provide: ShellService, useValue: {} },
      { provide: ContainerList, useValue: { containers: signal([]), start: vi.fn() } },
      {
        provide: StatsFeed,
        useValue: { samples: signal(new Map()), track: vi.fn(), clear: vi.fn() },
      },
    ],
  });
  await TestBed.inject(SettingsService).load();
  const view = TestBed.runInInjectionContext(() => new ContainersView()) as unknown as {
    grouped: () => boolean;
    showStats: () => boolean;
    setGrouped: (e: Event) => void;
  };
  return view;
}

const checkbox = (checked: boolean) => ({ target: { checked } }) as unknown as Event;

describe("containers view defaults", () => {
  afterEach(() => TestBed.resetTestingModule());

  it("starts with CPU and memory and grouping off", async () => {
    const view = await open({});
    expect(view.showStats()).toBe(false);
    expect(view.grouped()).toBe(false);
  });

  it("applies the stored defaults when it opens", async () => {
    const view = await open({ containers: { showStats: true, groupByStack: true } });
    expect(view.showStats()).toBe(true);
    expect(view.grouped()).toBe(true);
  });

  it("changes only the current view when toggled", async () => {
    const view = await open({ containers: { groupByStack: true } });
    view.setGrouped(checkbox(false));
    expect(view.grouped()).toBe(false);
    expect(TestBed.inject(SettingsService).containers().groupByStack).toBe(true);
  });
});
