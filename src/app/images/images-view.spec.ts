// @vitest-environment happy-dom
import { signal, type WritableSignal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { BrowserTestingModule, platformBrowserTesting } from "@angular/platform-browser/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ContainerList } from "../core/container-list";
import { EndpointStore } from "../core/endpoint-store";
import type { Image } from "../core/bindings";
import { EMPTY_PULL, pruneImages, removeImage, type PullProgress } from "../core/images";
import { SETTINGS_BACKEND } from "../core/settings/settings.service";
import { renderTemplateOf } from "../../../testing/render-template";
import { confirmDialog } from "../../../testing/confirm-dialog";
import { ImagesView } from "./images-view";

vi.mock("../core/images", async (original) => ({
  ...(await original<typeof import("../core/images")>()),
  listImages: vi.fn(async () => []),
  removeImage: vi.fn(),
  pruneImages: vi.fn(),
}));

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

const endpoint = { address: "unix:///var/run/docker.sock" };
const image = {
  id: "sha256:abc",
  reference: "nginx:1.27",
  dangling: false,
  size: 100,
  containers: 0,
} as unknown as Image;

function openView() {
  TestBed.configureTestingModule({
    providers: [
      { provide: SETTINGS_BACKEND, useValue: { load: async () => ({}), save: async () => {} } },
      { provide: EndpointStore, useValue: { active: () => ({ endpoint }) } },
    ],
  });
  renderTemplateOf(ImagesView, "images/images-view.html", [
    {
      provide: ContainerList,
      useValue: { containers: signal([]), phase: signal("loading"), start: vi.fn() },
    },
  ]);
  const fixture = TestBed.createComponent(ImagesView);
  const view = fixture.componentInstance as unknown as {
    images: WritableSignal<Image[]>;
    selectedRowId: WritableSignal<string | null>;
    loaded: WritableSignal<boolean>;
  };
  const confirm = confirmDialog(fixture);
  const select = async () => {
    await confirm.render();
    // The grid is left out: the images are set while the list still loads.
    view.images.set([image]);
    view.loaded.set(false);
    view.selectedRowId.set(`${image.id}|${image.reference}`);
    await confirm.render();
  };
  return { ...confirm, select };
}

describe("image removal and prune", () => {
  beforeEach(() => {
    vi.mocked(removeImage).mockReset();
    vi.mocked(pruneImages).mockReset();
  });
  afterEach(() => {
    TestBed.resetTestingModule();
    document.body.innerHTML = "";
  });

  async function askRemove() {
    const view = openView();
    await view.select();
    await view.click("Remove…");
    return view;
  }

  it("names the image to remove and runs nothing on Cancel", async () => {
    const { dialog, answer, option } = await askRemove();

    expect(dialog()?.textContent).toContain("Remove nginx:1.27?");
    expect(dialog()?.textContent).toContain("This removes nginx:1.27 from the engine.");
    expect(option().checked).toBe(false);
    await answer("Cancel");

    expect(dialog()).toBeNull();
    expect(removeImage).not.toHaveBeenCalled();
  });

  it.each([false, true])("removes on accept with force %s", async (force) => {
    const { answer, option } = await askRemove();
    if (force) option().click();

    await answer("Remove");

    expect(removeImage).toHaveBeenCalledExactlyOnceWith(endpoint, "nginx:1.27", force);
  });

  it.each([
    ["Prune dangling…", false, "Remove the dangling images?", "No image matches right now"],
    ["Prune unused…", true, "Remove all unused images?", "nginx:1.27"],
  ])("asks before %s and prunes only on accept", async (label, all, header, named) => {
    const { select, click, dialog, answer } = openView();
    await select();
    await click(label);

    expect(dialog()?.textContent).toContain(header);
    expect(dialog()?.textContent).toContain(named);
    await answer("Cancel");
    expect(pruneImages).not.toHaveBeenCalled();

    await click(label);
    await answer("Prune");
    expect(pruneImages).toHaveBeenCalledExactlyOnceWith(endpoint, all);
  });
});
