// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { BrowserTestingModule, platformBrowserTesting } from "@angular/platform-browser/testing";
import { HxStatusItem } from "@gravionlabs/helix-desktop";
import { HxButton, HxList, HxListRow, HxPopover } from "@gravionlabs/helix-ui";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App } from "./app";
import { type EndpointEntry, EndpointStore } from "./core/endpoint-store";
import { SettingsService } from "./core/settings/settings.service";
import { ThemeService } from "./core/settings/theme";
import { UpdateSettings } from "./core/settings/updates";
import { ShellService } from "./core/shell/shell.service";

TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting());

const entry = (name: string, state: EndpointEntry["status"]["state"]) =>
  ({
    id: `manual:${name}`,
    endpoint: { name },
    status: { state },
  }) as unknown as EndpointEntry;

function open(list: EndpointEntry[]) {
  const activeId = signal<string | null>("manual:local");
  const endpoints = {
    entries: signal(list),
    activeId,
    activeName: signal("local"),
    connection: signal("connected"),
    engineVersion: signal(null),
    generation: signal(0),
    select: vi.fn((id: string) => activeId.set(id)),
    init: vi.fn(),
  };
  const shell = { items: [], activeId: signal("volumes"), containerId: signal(null) };
  // Only the switcher is under test: the template is cut to its status item and its popover.
  const template = readFileSync(resolve(process.cwd(), "src/app/app.html"), "utf8");
  TestBed.overrideComponent(App, {
    set: {
      template: [
        /<hx-status-item\s[^>]*?class="endpoint"[\s\S]*?<\/hx-status-item>/,
        /<hx-popover\s[\s\S]*?<\/hx-popover>/,
      ]
        .map((part) => part.exec(template)![0])
        .join("\n"),
      templateUrl: undefined,
      styleUrl: undefined,
      imports: [HxStatusItem, HxButton, HxList, HxListRow, HxPopover],
    },
  });
  TestBed.configureTestingModule({
    providers: [
      { provide: EndpointStore, useValue: endpoints },
      { provide: ShellService, useValue: shell },
      { provide: SettingsService, useValue: { load: vi.fn() } },
      { provide: UpdateSettings, useValue: { startup: vi.fn() } },
      { provide: ThemeService, useValue: {} },
    ],
  });
  const fixture = TestBed.createComponent(App);
  // Focus needs an element of the document.
  document.body.append(fixture.nativeElement);
  fixture.detectChanges();
  const element = fixture.nativeElement as HTMLElement;
  const trigger = () => element.querySelector<HTMLButtonElement>("hx-status-item button")!;
  // The popover is an overlay of the document, outside the element of the fixture.
  const popover = () => document.querySelector<HTMLElement>(".hx-popover");
  const switcher = async () => {
    trigger().click();
    fixture.detectChanges();
    await fixture.whenStable();
  };
  const rows = () => [...document.querySelectorAll<HTMLButtonElement>("button[hx-list-row]")];
  const text = (row: Element, part: string) =>
    row.querySelector(`.hx-list-row-${part}`)?.textContent?.trim();
  return { fixture, element, endpoints, shell, trigger, popover, switcher, rows, text };
}

describe("endpoint switcher", () => {
  afterEach(() => TestBed.resetTestingModule());

  it("lists one row per endpoint and marks the active one", async () => {
    const { popover, switcher, rows, text } = open([
      entry("local", "reachable"),
      entry("remote", "unreachable"),
    ]);
    await switcher();

    expect(popover()?.querySelector("hx-list")?.getAttribute("aria-label")).toBe("Endpoints");
    expect(rows().map((r) => text(r, "label"))).toEqual(["local", "remote"]);
    expect(rows().map((r) => r.getAttribute("aria-current"))).toEqual(["true", null]);
    expect(rows()[1]?.querySelector(".dot")?.getAttribute("data-state")).toBe("unreachable");
    expect(popover()?.textContent).not.toContain("No endpoints found");
  });

  it("names the status of each row in text", async () => {
    const { switcher, rows, text } = open([
      entry("a", "reachable"),
      entry("b", "unreachable"),
      entry("c", "denied"),
      entry("d", "checking"),
    ]);
    await switcher();

    expect(rows().map((r) => text(r, "meta"))).toEqual([
      "Reachable",
      "Unreachable",
      "Permission denied",
      "Checking…",
    ]);
  });

  it("says on the status bar button whether the switcher is open", async () => {
    const { fixture, trigger, switcher } = open([entry("local", "reachable")]);
    await fixture.whenStable();
    expect(trigger().getAttribute("aria-haspopup")).toBe("dialog");
    expect(trigger().getAttribute("aria-expanded")).toBe("false");

    await switcher();
    expect(trigger().getAttribute("aria-expanded")).toBe("true");

    await switcher();
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
  });

  it("returns the focus to the status bar button after Escape", async () => {
    const { fixture, trigger, popover, switcher, rows } = open([entry("local", "reachable")]);
    await switcher();
    expect(document.activeElement).toBe(rows()[0]);

    rows()[0]?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    fixture.detectChanges();
    await fixture.whenStable();

    expect(popover()).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it("switches to the endpoint of a row, closes and returns the focus", async () => {
    const { fixture, endpoints, trigger, popover, switcher, rows } = open([
      entry("local", "reachable"),
      entry("remote", "reachable"),
    ]);
    await switcher();

    rows()[1]?.focus();
    rows()[1]?.click();
    fixture.detectChanges();
    await fixture.whenStable();

    expect(endpoints.select).toHaveBeenCalledWith("manual:remote");
    expect(endpoints.activeId()).toBe("manual:remote");
    expect(popover()).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it("opens the endpoint view with the text button", async () => {
    const { shell, switcher } = open([entry("local", "reachable")]);
    await switcher();
    const manage = document.querySelector<HTMLButtonElement>("button[hx-button].manage")!;
    expect(manage.textContent?.trim()).toBe("Manage endpoints…");
    expect(manage.classList).toContain("hx-button-text");

    manage.click();

    expect(shell.activeId()).toBe("endpoints");
  });

  it("says that there are no endpoints", async () => {
    const { popover, switcher, rows } = open([]);
    await switcher();

    expect(rows()).toHaveLength(0);
    expect(popover()?.textContent).toContain("No endpoints found");
  });
});

describe("empty state of a resource view", () => {
  afterEach(() => TestBed.resetTestingModule());

  function render(active: EndpointEntry | null, error: string) {
    const endpoints = {
      active: signal(active),
      activeName: signal(active?.endpoint.name ?? "No endpoint"),
      activeError: signal(error),
      retry: vi.fn(),
      init: vi.fn(),
    };
    const shell = { items: [], activeView: signal({ label: "Volumes" }), select: vi.fn() };
    const template = readFileSync(resolve(process.cwd(), "src/app/app.html"), "utf8");
    TestBed.overrideComponent(App, {
      set: {
        template: /<section class="empty" role="alert"[\s\S]*?<\/section>/.exec(template)![0],
        templateUrl: undefined,
        styleUrl: undefined,
        imports: [HxButton],
      },
    });
    TestBed.configureTestingModule({
      providers: [
        { provide: EndpointStore, useValue: endpoints },
        { provide: ShellService, useValue: shell },
        { provide: SettingsService, useValue: { load: vi.fn() } },
        { provide: UpdateSettings, useValue: { startup: vi.fn() } },
        { provide: ThemeService, useValue: {} },
      ],
    });
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    const element = fixture.nativeElement as HTMLElement;
    const heading = element.querySelector("h1")?.textContent?.trim();
    const text = element.querySelector("p")?.textContent?.trim();
    const buttons = [...element.querySelectorAll("button")].map((b) => b.textContent?.trim());
    return { heading, text, buttons };
  }

  it("says that there is no endpoint, names the next action and keeps both buttons", () => {
    const next = "Start Docker or add an endpoint under Manage endpoints, then retry.";

    const { heading, text, buttons } = render(null, next);

    expect(heading).toBe("No endpoint available");
    expect(text).toBe(next);
    expect(buttons).toEqual(["Retry", "Manage endpoints"]);
  });

  it("names the endpoint that does not answer", () => {
    const { heading, text, buttons } = render(entry("build", "unreachable"), "build is down");

    expect(heading).toBe("build is unreachable");
    expect(text).toBe("build is down");
    expect(buttons).toEqual(["Retry", "Manage endpoints"]);
  });
});

describe("confirmations", () => {
  it("has the one confirm dialog that asks the questions of the views", () => {
    const template = readFileSync(resolve(process.cwd(), "src/app/app.html"), "utf8");

    expect(template.match(/<hx-confirm-dialog \/>/g)).toHaveLength(1);
  });
});
