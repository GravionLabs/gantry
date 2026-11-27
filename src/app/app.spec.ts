// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { BrowserTestingModule, platformBrowserTesting } from "@angular/platform-browser/testing";
import { HxStatusItem, HxStatusPopover } from "@gravionlabs/helix-desktop";
import { HxButton, HxList, HxListRow } from "@gravionlabs/helix-ui";
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
  // Only the switcher is under test: the template is cut to the status item that holds it.
  const template = readFileSync(resolve(process.cwd(), "src/app/app.html"), "utf8");
  TestBed.overrideComponent(App, {
    set: {
      template: /<hx-status-item\s[^>]*?class="endpoint"[\s\S]*?<\/hx-status-item>/.exec(
        template,
      )![0],
      templateUrl: undefined,
      styleUrl: undefined,
      imports: [HxStatusItem, HxStatusPopover, HxButton, HxList, HxListRow],
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
  const switcher = () => {
    element.querySelector<HTMLElement>("hx-status-item button")?.click();
    fixture.detectChanges();
  };
  const rows = () => [...element.querySelectorAll<HTMLButtonElement>("button[hx-list-row]")];
  return { fixture, element, endpoints, shell, switcher, rows };
}

describe("endpoint switcher", () => {
  afterEach(() => TestBed.resetTestingModule());

  it("lists one row per endpoint and marks the active one", () => {
    const { element, switcher, rows } = open([
      entry("local", "reachable"),
      entry("remote", "unreachable"),
    ]);
    switcher();

    expect(element.querySelector("hx-list")?.getAttribute("aria-label")).toBe("Endpoints");
    expect(rows().map((r) => r.textContent?.trim())).toEqual(["local", "remote"]);
    expect(rows().map((r) => r.getAttribute("aria-current"))).toEqual(["true", null]);
    expect(rows()[1]?.querySelector(".dot")?.getAttribute("data-state")).toBe("unreachable");
    expect(element.textContent).not.toContain("No endpoints found");
  });

  it("switches to the endpoint of a row and closes", () => {
    const { endpoints, switcher, rows } = open([
      entry("local", "reachable"),
      entry("remote", "reachable"),
    ]);
    switcher();

    rows()[1]?.click();

    expect(endpoints.select).toHaveBeenCalledWith("manual:remote");
    expect(endpoints.activeId()).toBe("manual:remote");
  });

  it("opens the endpoint view with the text button", () => {
    const { element, shell, switcher } = open([entry("local", "reachable")]);
    switcher();
    const manage = element.querySelector<HTMLButtonElement>("button[hx-button].manage")!;
    expect(manage.textContent?.trim()).toBe("Manage endpoints…");
    expect(manage.classList).toContain("hx-button-text");

    manage.click();

    expect(shell.activeId()).toBe("endpoints");
  });

  it("says that there are no endpoints", () => {
    const { element, switcher, rows } = open([]);
    switcher();

    expect(rows()).toHaveLength(0);
    expect(element.textContent).toContain("No endpoints found");
  });
});

describe("confirmations", () => {
  it("has the one confirm dialog that asks the questions of the views", () => {
    const template = readFileSync(resolve(process.cwd(), "src/app/app.html"), "utf8");

    expect(template.match(/<hx-confirm-dialog \/>/g)).toHaveLength(1);
  });
});
