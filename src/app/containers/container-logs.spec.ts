// @vitest-environment happy-dom
import { signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { By } from "@angular/platform-browser";
import { BrowserTestingModule, platformBrowserTesting } from "@angular/platform-browser/testing";
import { HxSelect } from "@gravionlabs/helix-ui";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { LogOptions } from "../core/bindings";
import { streamContainerLogs } from "../core/containers";
import { renderTemplateOf } from "../../../testing/render-template";
import { ContainerLogs } from "./container-logs";

vi.mock("../core/containers", () => ({ streamContainerLogs: vi.fn(() => () => {}) }));

TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting());

function open() {
  renderTemplateOf(ContainerLogs, "containers/container-logs.html");
  const fixture = TestBed.createComponent(ContainerLogs);
  // The JIT compiler of the tests does not know signal inputs: set them on the instance.
  Object.assign(fixture.componentInstance, {
    endpoint: signal({ address: "unix:///var/run/docker.sock" }),
    containerId: signal("abc"),
  });
  fixture.detectChanges();
  const view = fixture.componentInstance as unknown as {
    follow: () => boolean;
    timestamps: () => boolean;
    tail: () => number | null;
    since: () => number | null;
    query: () => string;
  };
  const element = fixture.nativeElement as HTMLElement;
  const select = (label: string) =>
    fixture.debugElement
      .queryAll(By.directive(HxSelect))
      .map((d) => d.componentInstance as HxSelect<string>)
      .find((s) => s.ariaLabel() === label) as HxSelect<string>;
  /** What the select does when the user picks an option. */
  const pick = (label: string, value: string) => {
    select(label).value.set(value);
    fixture.detectChanges();
  };
  const options = () => vi.mocked(streamContainerLogs).mock.lastCall?.[2] as LogOptions;
  return { fixture, view, element, select, pick, options };
}

describe("container logs controls", () => {
  afterEach(() => {
    TestBed.resetTestingModule();
    vi.clearAllMocks();
  });

  it("drives follow and timestamps with switches", () => {
    const { fixture, view, element, options } = open();
    const [follow, timestamps] = element.querySelectorAll<HTMLInputElement>("input[hx-switch]");
    expect(follow?.checked).toBe(true);
    expect(timestamps?.checked).toBe(false);
    expect(follow?.closest("label")?.textContent).toContain("Follow");
    expect(timestamps?.closest("label")?.textContent).toContain("Timestamps");

    follow?.click();
    timestamps?.click();
    fixture.detectChanges();

    expect(view.follow()).toBe(false);
    expect(view.timestamps()).toBe(true);
    expect(options()).toMatchObject({ follow: false, timestamps: true });
  });

  it("drives the tail with a select, also for all lines", () => {
    const { view, select, pick, options } = open();
    expect(select("Show").selected()?.label).toBe("1000 lines");

    pick("Show", "all");
    expect(view.tail()).toBeNull();
    expect(select("Show").selected()?.label).toBe("All lines");
    expect(options().tail).toBeNull();

    pick("Show", "100");
    expect(view.tail()).toBe(100);
    expect(options().tail).toBe(100);
  });

  it("drives since with a select, also back to the beginning", () => {
    const { view, select, pick, options } = open();
    expect(select("Since").selected()?.label).toBe("Beginning");

    pick("Since", "3600");
    expect(view.since()).toBe(3600);
    expect(options().since).toEqual(expect.any(Number));

    pick("Since", "");
    expect(view.since()).toBeNull();
    expect(select("Since").selected()?.label).toBe("Beginning");
    expect(options().since).toBeNull();
  });

  it("drives the query with the search field", () => {
    const { fixture, view, element } = open();
    const search = element.querySelector<HTMLInputElement>(
      'input[hx-input][aria-label="Search logs"]',
    ) as HTMLInputElement;

    search.value = "boom";
    search.dispatchEvent(new Event("input"));
    fixture.detectChanges();

    expect(view.query()).toBe("boom");
    expect(element.querySelector(".count")?.textContent).toContain("No matches");
  });
});
