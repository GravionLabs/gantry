// @vitest-environment happy-dom
import { signal, type WritableSignal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { BrowserTestingModule, platformBrowserTesting } from "@angular/platform-browser/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Stack } from "../core/bindings";
import { ContainerList } from "../core/container-list";
import { EndpointStore } from "../core/endpoint-store";
import { SETTINGS_BACKEND } from "../core/settings/settings.service";
import { ShellService } from "../core/shell/shell.service";
import { runCompose } from "../core/stacks";
import { confirmDialog } from "../../../testing/confirm-dialog";
import { renderTemplateOf } from "../../../testing/render-template";
import { StackDeploy } from "./stack-deploy";
import { StacksView } from "./stacks-view";

vi.mock("../core/stacks", async (original) => ({
  ...(await original<typeof import("../core/stacks")>()),
  checkCompose: vi.fn(async () => ({ available: true, version: "2", reason: null })),
  listStacks: vi.fn(async () => []),
  runCompose: vi.fn(() => ({ stop: () => {}, done: Promise.resolve() })),
}));

TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting());

const endpoint = { address: "unix:///var/run/docker.sock" };
const stack = { name: "shop", workingDir: "/srv/shop", configFiles: [], services: [] } as Stack;

async function askDown() {
  TestBed.configureTestingModule({
    providers: [
      { provide: SETTINGS_BACKEND, useValue: { load: async () => ({}), save: async () => {} } },
      { provide: EndpointStore, useValue: { active: () => ({ endpoint }) } },
      { provide: ShellService, useValue: {} },
    ],
  });
  // Not shown here, but imported by the view: it needs a template the tests can compile.
  renderTemplateOf(StackDeploy, "stacks/stack-deploy.html");
  renderTemplateOf(StacksView, "stacks/stacks-view.html", [
    {
      provide: ContainerList,
      useValue: { containers: signal([]), phase: signal("loading"), start: vi.fn() },
    },
  ]);
  const fixture = TestBed.createComponent(StacksView);
  const view = fixture.componentInstance as unknown as {
    stacks: WritableSignal<Stack[]>;
    selectedName: WritableSignal<string | null>;
  };
  view.stacks.set([stack]);
  view.selectedName.set(stack.name);
  const confirm = confirmDialog(fixture);
  await confirm.click("Down…");
  return { ...confirm, view };
}

describe("stack down", () => {
  beforeEach(() => vi.mocked(runCompose).mockClear());
  afterEach(() => {
    TestBed.resetTestingModule();
    document.body.innerHTML = "";
  });

  it("names the stack and runs nothing on Cancel", async () => {
    const { dialog, answer, option } = await askDown();

    expect(dialog()?.textContent).toContain("Take down shop?");
    expect(dialog()?.textContent).toContain("removes the containers and networks of shop.");
    expect(option().checked).toBe(false);
    await answer("Cancel");

    expect(dialog()).toBeNull();
    expect(runCompose).not.toHaveBeenCalled();
  });

  it.each([false, true])("takes the stack down with the volumes option %s", async (volumes) => {
    const { answer, option } = await askDown();
    if (volumes) option().click();

    await answer("Take down");

    expect(runCompose).toHaveBeenCalledExactlyOnceWith(
      endpoint,
      expect.objectContaining({ name: "shop" }),
      { type: "down", volumes },
      expect.any(Function),
    );
  });

  it("runs nothing when another stack is open by the time of the answer", async () => {
    const { view, render, answer } = await askDown();
    view.selectedName.set(null);
    await render();

    await answer("Take down");

    expect(runCompose).not.toHaveBeenCalled();
  });
});
