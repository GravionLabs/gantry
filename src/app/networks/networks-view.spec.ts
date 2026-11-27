// @vitest-environment happy-dom
import { signal, type WritableSignal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { By } from "@angular/platform-browser";
import { BrowserTestingModule, platformBrowserTesting } from "@angular/platform-browser/testing";
import { HxSelect } from "@gravionlabs/helix-ui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Network } from "../core/bindings";
import { ContainerList } from "../core/container-list";
import { EndpointStore } from "../core/endpoint-store";
import { createNetwork, pruneNetworks, removeNetwork } from "../core/networks";
import { confirmDialog } from "../../../testing/confirm-dialog";
import { SETTINGS_BACKEND } from "../core/settings/settings.service";
import { renderTemplateOf } from "../../../testing/render-template";
import { NetworksView } from "./networks-view";

vi.mock("../core/networks", async (original) => ({
  ...(await original<typeof import("../core/networks")>()),
  createNetwork: vi.fn(),
  removeNetwork: vi.fn(),
  pruneNetworks: vi.fn(),
  listNetworks: vi.fn(async () => []),
}));

TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting());

const network = { id: "n1", name: "app-net", builtin: false, containers: [] } as unknown as Network;

function open() {
  TestBed.configureTestingModule({
    providers: [
      { provide: SETTINGS_BACKEND, useValue: { load: async () => ({}), save: async () => {} } },
      { provide: EndpointStore, useValue: { active: () => null } },
    ],
  });
  renderTemplateOf(NetworksView, "networks/networks-view.html", [
    {
      provide: ContainerList,
      useValue: {
        containers: signal([
          { id: "c2", name: "web" },
          { id: "c1", name: "db" },
        ]),
        phase: signal("loading"),
        start: vi.fn(),
      },
    },
  ]);
  const fixture = TestBed.createComponent(NetworksView);
  const view = fixture.componentInstance as unknown as {
    networks: WritableSignal<Network[]>;
    selectedId: WritableSignal<string | null>;
    toConnect: () => string;
  };
  view.networks.set([network]);
  view.selectedId.set(network.id);
  fixture.detectChanges();
  const select = fixture.debugElement.query(By.directive(HxSelect))
    .componentInstance as HxSelect<string>;
  const connect = () =>
    [...(fixture.nativeElement as HTMLElement).querySelectorAll("button")].find(
      (b) => b.textContent?.trim() === "Connect",
    ) as HTMLButtonElement;
  return { fixture, view, select, connect };
}

describe("networks view controls", () => {
  afterEach(() => TestBed.resetTestingModule());

  it("offers the containers by name under a label and starts with the placeholder", () => {
    const { view, select, connect } = open();

    expect(select.ariaLabel()).toBe("Container to connect");
    expect(select.items().map((i) => i.value)).toEqual(["db", "web"]);
    expect(select.selected()).toBeUndefined();
    expect(view.toConnect()).toBe("");
    expect(connect().disabled).toBe(true);
  });

  it("drives the container to connect with the select, also when cleared", () => {
    const { fixture, view, select, connect } = open();

    select.value.set("web");
    fixture.detectChanges();
    expect(view.toConnect()).toBe("web");
    expect(connect().disabled).toBe(false);

    select.value.set(null);
    fixture.detectChanges();
    expect(view.toConnect()).toBe("");
    expect(connect().disabled).toBe(true);
  });
});

const endpoint = { address: "unix:///var/run/docker.sock" };

const createMock = vi.mocked(createNetwork);

async function openCreateForm() {
  TestBed.configureTestingModule({
    providers: [
      { provide: SETTINGS_BACKEND, useValue: { load: async () => ({}), save: async () => {} } },
      { provide: EndpointStore, useValue: { active: () => ({ endpoint }) } },
    ],
  });
  renderTemplateOf(NetworksView, "networks/networks-view.html", [
    {
      provide: ContainerList,
      useValue: { containers: signal([]), phase: signal("loading"), start: vi.fn() },
    },
  ]);
  const fixture = TestBed.createComponent(NetworksView);
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

describe("network create form", () => {
  beforeEach(() => {
    createMock.mockReset().mockResolvedValue(undefined as never);
  });
  afterEach(() => {
    TestBed.resetTestingModule();
    document.body.innerHTML = "";
  });

  it("opens in a popover with the first field focused", async () => {
    const { toolbar, popover, field, description } = await openCreateForm();

    expect(popover()?.textContent).toContain("Create a network");
    expect(toolbar.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(field("name"));
    expect(description(field("subnet"))).toContain("172.30.0.0/16");
  });

  it("submits with Enter and closes the popover", async () => {
    const { toolbar, popover, type, enter } = await openCreateForm();
    await type("name", " app ");
    await type("subnet", " 172.30.0.0/16 ");
    await enter();

    expect(createMock).toHaveBeenCalledExactlyOnceWith(endpoint, {
      name: "app",
      subnet: "172.30.0.0/16",
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
    expect(description(field("name"))).toContain("A network needs a name.");
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
});

function openView() {
  TestBed.configureTestingModule({
    providers: [
      { provide: SETTINGS_BACKEND, useValue: { load: async () => ({}), save: async () => {} } },
      { provide: EndpointStore, useValue: { active: () => ({ endpoint }) } },
    ],
  });
  renderTemplateOf(NetworksView, "networks/networks-view.html", [
    {
      provide: ContainerList,
      useValue: { containers: signal([]), phase: signal("loading"), start: vi.fn() },
    },
  ]);
  const fixture = TestBed.createComponent(NetworksView);
  const view = fixture.componentInstance as unknown as {
    networks: WritableSignal<Network[]>;
    selectedId: WritableSignal<string | null>;
    loaded: WritableSignal<boolean>;
  };
  const confirm = confirmDialog(fixture);
  const select = async () => {
    await confirm.render();
    // The grid is left out: the networks are set while the list still loads.
    view.networks.set([network]);
    view.loaded.set(false);
    view.selectedId.set(network.id);
    await confirm.render();
  };
  return { ...confirm, select };
}

describe("network removal and prune", () => {
  beforeEach(() => {
    vi.mocked(removeNetwork).mockReset();
    vi.mocked(pruneNetworks).mockReset();
  });
  afterEach(() => {
    TestBed.resetTestingModule();
    document.body.innerHTML = "";
  });

  it("names the network to remove and removes only on accept", async () => {
    const { select, click, dialog, answer } = openView();
    await select();
    await click("Remove…");

    expect(dialog()?.textContent).toContain("Remove app-net?");
    expect(dialog()?.textContent).toContain("This deletes the network app-net.");
    await answer("Cancel");
    expect(removeNetwork).not.toHaveBeenCalled();

    await click("Remove…");
    await answer("Remove");
    expect(removeNetwork).toHaveBeenCalledExactlyOnceWith(endpoint, "n1");
  });

  it("names the unused networks and prunes only on accept", async () => {
    const { select, click, dialog, answer } = openView();
    await select();
    await click("Prune unused…");

    expect(dialog()?.textContent).toContain("Remove all unused networks?");
    expect(dialog()?.textContent).toContain("This removes 1 network: app-net.");
    await answer("Cancel");
    expect(pruneNetworks).not.toHaveBeenCalled();

    await click("Prune unused…");
    await answer("Prune");
    expect(pruneNetworks).toHaveBeenCalledExactlyOnceWith(endpoint);
  });
});
