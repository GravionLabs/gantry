// @vitest-environment happy-dom
import { signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { BrowserTestingModule, platformBrowserTesting } from "@angular/platform-browser/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ContainerList } from "../core/container-list";
import { EndpointStore } from "../core/endpoint-store";
import { SETTINGS_BACKEND } from "../core/settings/settings.service";
import { createVolume } from "../core/volumes";
import { renderTemplateOf } from "../../../testing/render-template";
import { VolumesView } from "./volumes-view";

vi.mock("../core/volumes", async (original) => ({
  ...(await original<typeof import("../core/volumes")>()),
  createVolume: vi.fn(),
  listVolumes: vi.fn(async () => []),
}));

TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting());

const endpoint = { address: "unix:///var/run/docker.sock" };

const createMock = vi.mocked(createVolume);

async function openCreateForm() {
  TestBed.configureTestingModule({
    providers: [
      { provide: SETTINGS_BACKEND, useValue: { load: async () => ({}), save: async () => {} } },
      { provide: EndpointStore, useValue: { active: () => ({ endpoint }) } },
    ],
  });
  renderTemplateOf(VolumesView, "volumes/volumes-view.html", [
    {
      provide: ContainerList,
      useValue: { containers: signal([]), phase: signal("loading"), start: vi.fn() },
    },
  ]);
  const fixture = TestBed.createComponent(VolumesView);
  document.body.append(fixture.nativeElement);
  // Two rounds: what runs after a render, such as closing the popover, needs one more render.
  const render = async () => {
    for (let round = 0; round < 2; round++) {
      await new Promise((resolve) => setTimeout(resolve));
      fixture.detectChanges();
      TestBed.tick();
    }
  };
  await render();
  const button = (label: string, root: ParentNode = document) =>
    [...root.querySelectorAll("button")].find((b) => b.textContent?.trim() === label)!;
  const toolbar = button("Create…", fixture.nativeElement as HTMLElement);
  toolbar.click();
  await render();
  const popover = () => document.querySelector<HTMLElement>('.hx-popover[role="dialog"]');
  const field = (name: string) => popover()!.querySelector<HTMLInputElement>(`[name="${name}"]`)!;
  const type = async (name: string, value: string) => {
    field(name).value = value;
    field(name).dispatchEvent(new Event("input", { bubbles: true }));
    await render();
  };
  const press = async (key: string, target: Element) => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
    await render();
  };
  /** What Enter in a field does in a browser: a click on the submit button of the form. */
  const enter = async () => {
    popover()!.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
    await render();
  };
  /** The text of the elements that describe the control. */
  const description = (control: Element) =>
    (control.getAttribute("aria-describedby") ?? "")
      .split(" ")
      .map((id) => document.getElementById(id)?.textContent?.trim())
      .join(" ");
  return { render, button, toolbar, popover, field, type, press, enter, description };
}

describe("volume create form", () => {
  beforeEach(() => {
    createMock.mockReset().mockResolvedValue(undefined as never);
  });
  afterEach(() => {
    TestBed.resetTestingModule();
    document.body.innerHTML = "";
  });

  it("opens in a popover with the first field focused", async () => {
    const { toolbar, popover, field, description } = await openCreateForm();

    expect(popover()?.textContent).toContain("Create a volume");
    expect(toolbar.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(field("name"));
    expect(description(field("driver"))).toContain("Empty for local.");
    expect(description(field("labels"))).toContain("One key=value per line");
    expect(field("labels").tagName).toBe("TEXTAREA");
    expect(field("labels").hasAttribute("hx-input")).toBe(true);
  });

  it("submits with Enter and closes the popover", async () => {
    const { toolbar, popover, type, enter } = await openCreateForm();
    await type("name", " app ");
    await type("labels", "team=core");
    await enter();

    expect(createMock).toHaveBeenCalledExactlyOnceWith(endpoint, {
      name: "app",
      driver: "",
      labels: [{ key: "team", value: "core" }],
    });
    expect(popover()).toBeNull();
    expect(document.activeElement).toBe(toolbar);
  });

  it("shows the error below the empty name field and calls no backend command", async () => {
    const { type, enter, field, popover, description } = await openCreateForm();
    const submit = popover()!.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    expect(submit.disabled).toBe(false);

    await enter();

    expect(createMock).not.toHaveBeenCalled();
    expect(field("name").getAttribute("aria-invalid")).toBe("true");
    expect(description(field("name"))).toContain("A volume needs a name.");
    expect(popover()!.querySelector("hx-message")).toBeNull();
    expect(document.activeElement).toBe(field("name"));

    await type("name", "app");
    expect(field("name").hasAttribute("aria-invalid")).toBe(false);
  });

  it("shows the loading state while creating and the refusal above the buttons", async () => {
    let refuse!: (error: unknown) => void;
    createMock.mockReturnValue(new Promise<never>((_, reject) => (refuse = reject)));
    const { render, popover, type, enter, field } = await openCreateForm();
    await type("name", "app");
    await enter();

    const submit = popover()!.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    expect(submit.getAttribute("aria-busy")).toBe("true");
    expect(submit.disabled).toBe(false);
    await enter();
    expect(createMock).toHaveBeenCalledTimes(1);

    refuse("already exists");
    await render();

    expect(submit.hasAttribute("aria-busy")).toBe(false);
    expect(popover()!.querySelector("hx-message")?.textContent).toContain(
      "Cannot create app: already exists",
    );
    expect(field("name").hasAttribute("aria-invalid")).toBe(false);
  });

  it("keeps the refusal readable when the popover was closed while creating", async () => {
    let refuse!: (error: unknown) => void;
    createMock.mockReturnValue(new Promise<never>((_, reject) => (refuse = reject)));
    const { render, popover, field, type, enter, press } = await openCreateForm();
    await type("name", "app");
    await enter();
    await press("Escape", field("name"));
    refuse("already exists");
    await render();

    expect(popover()).toBeNull();
    expect(document.body.textContent).toContain("Cannot create app: already exists");
  });

  it("closes with Esc and with Cancel, and creates nothing", async () => {
    const { render, button, toolbar, popover, field, press } = await openCreateForm();
    await press("Escape", field("name"));

    expect(popover()).toBeNull();
    expect(document.activeElement).toBe(toolbar);

    toolbar.click();
    await render();
    button("Cancel", popover()!).click();
    await render();

    expect(popover()).toBeNull();
    expect(createMock).not.toHaveBeenCalled();
  });

  it("shows a malformed label below the labels field", async () => {
    const { type, enter, field, description } = await openCreateForm();
    await type("name", "app");
    await type("labels", "=core");
    await enter();

    expect(createMock).not.toHaveBeenCalled();
    expect(field("labels").getAttribute("aria-invalid")).toBe("true");
    expect(field("name").hasAttribute("aria-invalid")).toBe(false);
    expect(description(field("labels"))).toMatch(/One key=value per line.+\S.*=core/);
    expect(document.activeElement).toBe(field("labels"));
  });
});
