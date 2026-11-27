// @vitest-environment happy-dom
import { signal, type WritableSignal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { By } from "@angular/platform-browser";
import { BrowserTestingModule, platformBrowserTesting } from "@angular/platform-browser/testing";
import { HxSelect } from "@gravionlabs/helix-ui";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Network } from "../core/bindings";
import { ContainerList } from "../core/container-list";
import { EndpointStore } from "../core/endpoint-store";
import { SETTINGS_BACKEND } from "../core/settings/settings.service";
import { renderTemplateOf } from "../../../testing/render-template";
import { NetworksView } from "./networks-view";

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
