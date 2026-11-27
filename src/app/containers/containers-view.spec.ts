// @vitest-environment happy-dom
import { signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { BrowserTestingModule, platformBrowserTesting } from "@angular/platform-browser/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Container } from "../core/bindings";
import { ContainerList } from "../core/container-list";
import { runContainerAction } from "../core/containers";
import { EndpointStore } from "../core/endpoint-store";
import { SETTINGS_BACKEND, SettingsService } from "../core/settings/settings.service";
import { ShellService } from "../core/shell/shell.service";
import { StatsFeed } from "../core/stats";
import { confirmDialog } from "../../../testing/confirm-dialog";
import { renderTemplateOf } from "../../../testing/render-template";
import { ContainersView } from "./containers-view";

vi.mock("../core/containers", async (original) => ({
  ...(await original<typeof import("../core/containers")>()),
  runContainerAction: vi.fn(async () => {}),
}));

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

const endpoint = { address: "unix:///var/run/docker.sock" };
const containers = [
  { id: "c1", name: "web", image: "nginx", state: "exited" },
  { id: "c2", name: "db", image: "postgres", state: "exited" },
] as unknown as Container[];

async function openRemove() {
  TestBed.configureTestingModule({
    providers: [
      { provide: SETTINGS_BACKEND, useValue: { load: async () => ({}), save: async () => {} } },
      { provide: EndpointStore, useValue: { active: () => ({ endpoint }) } },
      { provide: ShellService, useValue: {} },
    ],
  });
  renderTemplateOf(ContainersView, "containers/containers-view.html", [
    {
      provide: ContainerList,
      useValue: {
        containers: signal(containers),
        phase: signal("ready"),
        problem: signal(null),
        start: vi.fn(),
      },
    },
    {
      provide: StatsFeed,
      useValue: { samples: signal(new Map()), track: vi.fn(), clear: vi.fn() },
    },
  ]);
  const fixture = TestBed.createComponent(ContainersView);
  const view = fixture.componentInstance as unknown as {
    selectedIds: WritableSignal<ReadonlySet<string>>;
    filter: WritableSignal<string>;
  };
  // No row matches, so the grid is left out; the selection and the toolbar stay.
  view.filter.set("no match");
  view.selectedIds.set(new Set(["c1", "c2"]));
  const confirm = confirmDialog(fixture);
  await confirm.click("Remove");
  return confirm;
}

describe("container removal", () => {
  beforeEach(() => vi.mocked(runContainerAction).mockClear());
  afterEach(() => {
    TestBed.resetTestingModule();
    document.body.innerHTML = "";
  });

  it("names what is removed and focuses Cancel", async () => {
    const { dialog, option } = await openRemove();

    expect(dialog()?.textContent).toContain("Remove 2 container(s)?");
    expect(dialog()?.textContent).toContain("This permanently removes: web, db.");
    expect(document.activeElement?.textContent?.trim()).toBe("Cancel");
    expect(option().checked).toBe(false);
    expect(runContainerAction).not.toHaveBeenCalled();
  });

  it("removes nothing on Cancel", async () => {
    const { dialog, answer } = await openRemove();

    await answer("Cancel");

    expect(dialog()).toBeNull();
    expect(runContainerAction).not.toHaveBeenCalled();
  });

  it.each([false, true])("removes on accept with the volumes option %s", async (volumes) => {
    const { answer, option } = await openRemove();
    if (volumes) option().click();

    await answer("Remove");

    expect(runContainerAction).toHaveBeenCalledExactlyOnceWith(
      endpoint,
      { type: "remove", volumes },
      [
        { id: "c1", name: "web" },
        { id: "c2", name: "db" },
      ],
      expect.any(Function),
    );
  });
});
