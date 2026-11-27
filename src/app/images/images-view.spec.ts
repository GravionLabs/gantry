// @vitest-environment happy-dom
import { signal, type WritableSignal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { BrowserTestingModule, platformBrowserTesting } from "@angular/platform-browser/testing";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ContainerList } from "../core/container-list";
import { EndpointStore } from "../core/endpoint-store";
import { EMPTY_PULL, type PullProgress } from "../core/images";
import { SETTINGS_BACKEND } from "../core/settings/settings.service";
import { renderTemplateOf } from "../../../testing/render-template";
import { ImagesView } from "./images-view";

TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting());

function open() {
  TestBed.configureTestingModule({
    providers: [
      { provide: SETTINGS_BACKEND, useValue: { load: async () => ({}), save: async () => {} } },
      { provide: EndpointStore, useValue: { active: () => null } },
    ],
  });
  renderTemplateOf(ImagesView, "images/images-view.html", [
    {
      provide: ContainerList,
      useValue: { containers: signal([]), phase: signal("loading"), start: vi.fn() },
    },
  ]);
  const fixture = TestBed.createComponent(ImagesView);
  fixture.detectChanges();
  const view = fixture.componentInstance as unknown as {
    reference: () => string;
    pulling: WritableSignal<string | null>;
    pullProgress: WritableSignal<PullProgress>;
  };
  return { fixture, view, element: fixture.nativeElement as HTMLElement };
}

describe("images view controls", () => {
  afterEach(() => TestBed.resetTestingModule());

  it("drives the reference with the pull field", () => {
    const { fixture, view, element } = open();
    const input = element.querySelector<HTMLInputElement>(
      'input[hx-input][aria-label="Image to pull"]',
    ) as HTMLInputElement;

    input.value = "nginx:1.27";
    input.dispatchEvent(new Event("input"));
    fixture.detectChanges();

    expect(view.reference()).toBe("nginx:1.27");
  });

  it("shows the share of a layer in a labelled progress bar", () => {
    const { fixture, view, element } = open();

    view.pulling.set("nginx:1.27");
    view.pullProgress.set({
      ...EMPTY_PULL,
      layers: [
        { id: "a1", status: "Downloading", current: 25, total: 100 },
        { id: "b2", status: "Waiting", current: null, total: null },
      ],
    });
    fixture.detectChanges();

    const bars = element.querySelectorAll("hx-progress-bar");
    expect(bars).toHaveLength(1);
    expect(bars[0]?.getAttribute("aria-label")).toBe("Layer a1");
    expect(bars[0]?.getAttribute("aria-valuenow")).toBe("25");
    expect(bars[0]?.textContent?.trim()).toBe("");
  });
});
