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

async function open() {
  renderTemplateOf(ContainerLogs, "containers/container-logs.html");
  const fixture = TestBed.createComponent(ContainerLogs);
  // The JIT compiler of the tests does not know signal inputs: set them on the instance.
  Object.assign(fixture.componentInstance, {
    endpoint: signal({ address: "unix:///var/run/docker.sock" }),
    containerId: signal("abc"),
  });
  fixture.detectChanges();
  // `hx-field` wires its label after the first render.
  await fixture.whenStable();
  const view = fixture.componentInstance as unknown as {
    follow: () => boolean;
    timestamps: () => boolean;
    tail: () => number | null;
    since: () => number | null;
    query: () => string;
  };
  const element = fixture.nativeElement as HTMLElement;
  const label = (text: string) =>
    [...element.querySelectorAll("label")].find(
      (l) => l.textContent?.trim() === text,
    ) as HTMLLabelElement;
  /** The control the visible label with this text points at. */
  const control = <T extends HTMLElement = HTMLInputElement>(text: string) =>
    element.querySelector<T>(`[id="${label(text)?.htmlFor}"]`) as T;
  const select = (text: string) =>
    fixture.debugElement
      .queryAll(By.directive(HxSelect))
      .find((d) => (d.nativeElement as HTMLElement).contains(control(text)))
      ?.componentInstance as HxSelect<string>;
  /** What the select does when the user picks an option. */
  const pick = (label: string, value: string) => {
    select(label).value.set(value);
    fixture.detectChanges();
  };
  const options = () => vi.mocked(streamContainerLogs).mock.lastCall?.[2] as LogOptions;
  return { fixture, view, element, label, control, select, pick, options };
}

describe("container logs controls", () => {
  afterEach(() => {
    TestBed.resetTestingModule();
    vi.clearAllMocks();
  });

  it("reaches every control of the toolbar by its visible label", async () => {
    const { element, control } = await open();
    const expected = {
      Follow: "input[hx-switch]",
      Show: "hx-select button",
      Since: "hx-select button",
      Timestamps: "input[hx-switch]",
      "Search logs": 'input[hx-input][type="search"]',
    };

    for (const [text, selector] of Object.entries(expected)) {
      expect(control(text)?.matches(selector), text).toBe(true);
    }
    expect(new Set(Object.keys(expected).map((text) => control(text))).size).toBe(5);
    expect(
      element.querySelector(".options [aria-hidden='true']:not(.hx-select-chevron)"),
    ).toBeNull();
    for (const text of Object.keys(expected)) {
      expect(control(text).hasAttribute("aria-label"), text).toBe(false);
    }
  });

  it("opens a select by clicking its label", async () => {
    const { fixture, label, control } = await open();
    for (const text of ["Show", "Since"]) {
      label(text).click();
      fixture.detectChanges();
      expect(control(text).getAttribute("aria-expanded"), text).toBe("true");
    }
  });

  it("drives follow and timestamps with switches", async () => {
    const { fixture, view, label, control, options } = await open();
    const follow = control("Follow");
    const timestamps = control("Timestamps");
    expect(follow.checked).toBe(true);
    expect(timestamps.checked).toBe(false);

    label("Follow").click();
    label("Timestamps").click();
    fixture.detectChanges();

    expect(view.follow()).toBe(false);
    expect(view.timestamps()).toBe(true);
    expect(options()).toMatchObject({ follow: false, timestamps: true });
  });

  it("drives the tail with a select, also for all lines", async () => {
    const { view, select, pick, options } = await open();
    expect(select("Show").selected()?.label).toBe("1000 lines");

    pick("Show", "all");
    expect(view.tail()).toBeNull();
    expect(select("Show").selected()?.label).toBe("All lines");
    expect(options().tail).toBeNull();

    pick("Show", "100");
    expect(view.tail()).toBe(100);
    expect(options().tail).toBe(100);
  });

  it("drives since with a select, also back to the beginning", async () => {
    const { view, select, pick, options } = await open();
    expect(select("Since").selected()?.label).toBe("Beginning");

    pick("Since", "3600");
    expect(view.since()).toBe(3600);
    expect(options().since).toEqual(expect.any(Number));

    pick("Since", "");
    expect(view.since()).toBeNull();
    expect(select("Since").selected()?.label).toBe("Beginning");
    expect(options().since).toBeNull();
  });

  it("drives the query with the search field", async () => {
    const { fixture, view, element, control } = await open();
    const search = control("Search logs");

    search.value = "boom";
    search.dispatchEvent(new Event("input"));
    fixture.detectChanges();

    expect(view.query()).toBe("boom");
    expect(element.querySelector(".count")?.textContent).toContain("No matches");
  });

  it("steps through the matches with Enter and Shift+Enter in the search field", async () => {
    vi.mocked(streamContainerLogs).mockImplementationOnce((_endpoint, _id, _options, onLines) => {
      onLines(["boom one", "quiet", "boom two"].map((text) => ({ stream: "stdout", text })));
      return () => {};
    });
    const { fixture, element, control } = await open();
    const search = control("Search logs");
    const press = (shiftKey: boolean) => {
      search.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", shiftKey }));
      fixture.detectChanges();
      return element.querySelector(".count")?.textContent?.trim();
    };
    search.value = "boom";
    search.dispatchEvent(new Event("input"));
    fixture.detectChanges();

    expect(press(false)).toBe("1 / 2");
    expect(press(false)).toBe("2 / 2");
    expect(press(true)).toBe("1 / 2");
  });
});
