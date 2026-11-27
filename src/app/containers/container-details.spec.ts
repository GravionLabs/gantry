// @vitest-environment happy-dom
import { NO_ERRORS_SCHEMA, signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { BrowserTestingModule, platformBrowserTesting } from "@angular/platform-browser/testing";
import {
  HxButton,
  HxMessage,
  HxTab,
  HxTabContent,
  HxTabList,
  HxTabPanel,
  HxTabPanels,
  HxTabs,
} from "@gravionlabs/helix-ui";
import { afterEach, describe, expect, it, vi } from "vitest";

import { EndpointStore } from "../core/endpoint-store";
import { ShellService } from "../core/shell/shell.service";
import { renderTemplateOf } from "../../../testing/render-template";
import { ContainerDetailsView } from "./container-details";

vi.mock("../core/containers", async (original) => ({
  ...(await original<typeof import("../core/containers")>()),
  inspectContainer: vi.fn(async () => ({
    id: "abc",
    name: "web",
    image: "nginx",
    imageId: "sha256:1",
    state: "running",
    created: "2026-01-01T00:00:00Z",
    command: [],
    entrypoint: [],
    restartPolicy: { name: "no", maximumRetryCount: 0 },
    health: null,
    ports: [],
    composeProject: null,
    env: [{ name: "TOKEN", value: "secret" }],
    mounts: [],
    networks: [],
    labels: [{ key: "team", value: "core" }],
    raw: '{"Id":"abc"}',
  })),
}));

TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting());

async function open() {
  TestBed.configureTestingModule({
    providers: [
      {
        provide: EndpointStore,
        useValue: {
          active: signal({ endpoint: { address: "unix:///var/run/docker.sock" } }),
          activeName: signal("local"),
        },
      },
      { provide: ShellService, useValue: {} },
    ],
  });
  renderTemplateOf(ContainerDetailsView, "containers/container-details.html");
  // The logs, stats and terminal views have their own specs: here they stay empty elements.
  TestBed.overrideComponent(ContainerDetailsView, {
    set: {
      imports: [
        HxButton,
        HxMessage,
        HxTab,
        HxTabContent,
        HxTabList,
        HxTabPanel,
        HxTabPanels,
        HxTabs,
      ],
      schemas: [NO_ERRORS_SCHEMA],
    },
  });
  const fixture = TestBed.createComponent(ContainerDetailsView);
  Object.assign(fixture.componentInstance, { id: signal("abc") });
  const element = fixture.nativeElement as HTMLElement;
  const render = async () => {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  };
  await render();
  await render();
  const tabs = () => Array.from(element.querySelectorAll<HTMLElement>('[role="tab"]'));
  const tab = (label: string) => tabs().find((t) => t.textContent?.trim() === label)!;
  const show = async (label: string) => {
    tab(label).click();
    await render();
  };
  /** The panels that are shown. */
  const panels = () =>
    Array.from(element.querySelectorAll<HTMLElement>('[role="tabpanel"]')).filter((p) => !p.hidden);
  return { element, render, tabs, tab, show, panels };
}

/** What identifies the content of each tab. */
const CONTENT: readonly (readonly [string, string])[] = [
  ["Logs", "app-container-logs"],
  ["Terminal", "app-container-terminal"],
  ["Stats", "app-container-stats"],
  ["Environment", "table"],
  ["Mounts", ".state"],
  ["Networks", ".state"],
  ["Labels", "table"],
  ["Raw JSON", "pre.raw"],
  ["Overview", "dl.facts"],
];

describe("container details tabs", () => {
  afterEach(() => TestBed.resetTestingModule());

  it("starts on the overview with one tab per view", async () => {
    const { tabs, panels } = await open();
    expect(tabs().map((t) => t.textContent?.trim())).toEqual([
      "Overview",
      "Logs",
      "Terminal",
      "Stats",
      "Environment",
      "Mounts",
      "Networks",
      "Labels",
      "Raw JSON",
    ]);
    expect(panels()).toHaveLength(1);
    expect(panels()[0]!.querySelector("dl.facts")).not.toBeNull();
  });

  it("shows the panel of the chosen tab", async () => {
    const { tab, show, panels } = await open();
    for (const [label, content] of CONTENT) {
      await show(label);

      expect(tab(label).getAttribute("aria-selected")).toBe("true");
      expect(panels()).toHaveLength(1);
      expect(panels()[0]!.id).toBe(tab(label).getAttribute("aria-controls"));
      expect(panels()[0]!.querySelector(content), label).not.toBeNull();
    }
  });

  it("moves between the tabs with the arrow keys", async () => {
    const { render, tab, panels } = await open();
    tab("Overview").dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
    );
    await render();

    expect(tab("Logs").getAttribute("aria-selected")).toBe("true");
    expect(panels()[0]!.querySelector("app-container-logs")).not.toBeNull();
  });

  it("keeps the terminal alive and drops the other views when their tab is left", async () => {
    const { element, show } = await open();
    expect(element.querySelector("app-container-terminal")).toBeNull();

    await show("Terminal");
    const terminal = element.querySelector("app-container-terminal");
    await show("Logs");
    expect(element.querySelector("app-container-terminal")).toBe(terminal);

    await show("Overview");
    expect(element.querySelector("app-container-logs")).toBeNull();
    expect(element.querySelector("app-container-terminal")).toBe(terminal);
  });
});
