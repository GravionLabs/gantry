// @vitest-environment happy-dom
import { signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { BrowserTestingModule, platformBrowserTesting } from "@angular/platform-browser/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EndpointStore } from "../core/endpoint-store";
import { SETTINGS_BACKEND } from "../core/settings/settings.service";
import { previewCleanup, readOverview, runCleanup } from "../core/system";
import { renderTemplateOf } from "../../../testing/render-template";
import { SystemView } from "./system-view";

vi.mock("../core/system", async (original) => ({
  ...(await original<typeof import("../core/system")>()),
  readOverview: vi.fn(),
  previewCleanup: vi.fn(),
  runCleanup: vi.fn(),
}));

TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting());

const endpoint = { address: "unix:///var/run/docker.sock" };
const previews = [
  { category: "containers" as const, count: 2, names: ["web", "db"], reclaimable: 1 },
];

/** A promise that the test settles itself. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

async function openCleanup() {
  const active = signal({ endpoint });
  TestBed.configureTestingModule({
    providers: [
      { provide: SETTINGS_BACKEND, useValue: { load: async () => ({}), save: async () => {} } },
      { provide: EndpointStore, useValue: { active } },
    ],
  });
  renderTemplateOf(SystemView, "system/system-view.html");
  const fixture = TestBed.createComponent(SystemView);
  const host = fixture.nativeElement as HTMLElement;
  document.body.append(host);
  // Two rounds: what opens or closes after a render needs one more render.
  const render = async () => {
    for (let round = 0; round < 2; round++) {
      await new Promise((resolve) => setTimeout(resolve));
      fixture.detectChanges();
      TestBed.tick();
    }
  };
  const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
  const button = (label: string, root: ParentNode = dialog()!) => {
    const found = [...root.querySelectorAll("button")].find((b) => b.textContent?.trim() === label);
    if (!found) throw new Error(`No button "${label}"`);
    return found;
  };
  const click = async (label: string) => {
    button(label).click();
    await render();
  };
  const boxes = () => [...dialog()!.querySelectorAll<HTMLInputElement>("input[hx-checkbox]")];
  const select = async (index: number) => {
    boxes()[index]!.click();
    await render();
  };
  const escape = async () => {
    document.activeElement!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", keyCode: 27, bubbles: true }),
    );
    await render();
  };
  await render();
  const open = async () => {
    button("Clean up…", host).click();
    await render();
  };
  await open();
  /** Makes another endpoint the active one. */
  const switchEndpoint = async () => {
    active.set({ endpoint: { address: "ssh://user@host" } });
    await render();
  };
  return { host, render, dialog, button, click, select, escape, open, switchEndpoint };
}

describe("system cleanup", () => {
  beforeEach(() => {
    vi.mocked(readOverview).mockResolvedValue({
      engine: {
        version: "29",
        apiVersion: "1.52",
        os: "linux",
        arch: "amd64",
        cpus: 4,
        memory: 1,
        storageDriver: "overlay2",
      },
      usage: [],
    });
    vi.mocked(previewCleanup).mockReset().mockResolvedValue(previews);
    vi.mocked(runCleanup).mockReset().mockResolvedValue({ outcomes: [], failures: [] });
  });
  afterEach(() => {
    TestBed.resetTestingModule();
    document.body.innerHTML = "";
  });

  it("opens in a dialog of size md, with no inline panel", async () => {
    const { host, dialog } = await openCleanup();

    expect(dialog()?.textContent).toContain("Clean up unused data");
    expect(document.querySelector(".hx-dialog-panel")?.classList).toContain("hx-dialog-size-md");
    expect(host.querySelector("input[hx-checkbox], [role=alertdialog]")).toBeNull();
  });

  it("labels every category and offers no preview without a selection", async () => {
    const { dialog, button } = await openCleanup();

    expect([...dialog()!.querySelectorAll("label")].map((l) => l.textContent?.trim())).toEqual([
      "Containers",
      "Images",
      "Volumes",
      "Build cache",
    ]);
    expect(button("Preview").disabled).toBe(true);
  });

  it("previews the selection, then removes it on Remove", async () => {
    const { dialog, button, select, click } = await openCleanup();
    await select(0);

    await click("Preview");

    expect(previewCleanup).toHaveBeenCalledExactlyOnceWith(endpoint, ["containers"]);
    expect(dialog()?.querySelector('[role="status"]')?.textContent).toContain("web, db");
    expect(button("Remove").classList).toContain("hx-button-danger");
    expect(runCleanup).not.toHaveBeenCalled();

    await click("Remove");

    expect(runCleanup).toHaveBeenCalledExactlyOnceWith(endpoint, ["containers"]);
    expect(dialog()).toBeNull();
  });

  it("asks for the preview on submit and never removes on it", async () => {
    const { dialog, select, render } = await openCleanup();
    await select(0);
    const submit = async () => {
      dialog()!
        .querySelector("form")!
        .dispatchEvent(new Event("submit", { cancelable: true }));
      await render();
    };

    await submit();
    await submit();

    expect(previewCleanup).toHaveBeenCalledTimes(1);
    expect(runCleanup).not.toHaveBeenCalled();
  });

  it.each(["Cancel", "Escape"])("removes nothing and closes on %s", async (way) => {
    const { dialog, select, click, escape } = await openCleanup();
    await select(0);
    await click("Preview");

    await (way === "Escape" ? escape() : click(way));

    expect(dialog()).toBeNull();
    expect(runCleanup).not.toHaveBeenCalled();
  });

  it("can start again after Escape during a preview", async () => {
    const pending = deferred<typeof previews>();
    vi.mocked(previewCleanup).mockReturnValue(pending.promise);
    const { host, dialog, button, select, click, escape, render, open } = await openCleanup();
    await select(0);
    await click("Preview");
    expect(button("Preview").classList).toContain("hx-button-loading");

    await escape();
    pending.resolve(previews);
    await render();

    expect(dialog()).toBeNull();
    expect(button("Clean up…", host).disabled).toBe(false);
    await open();
    expect(dialog()?.querySelector('[role="status"]')).toBeNull();
  });

  it("cannot be closed while the cleanup runs", async () => {
    const pending = deferred<{ outcomes: []; failures: [] }>();
    vi.mocked(runCleanup).mockReturnValue(pending.promise);
    const { dialog, button, select, click, escape, render } = await openCleanup();
    await select(0);
    await click("Preview");

    await click("Remove");

    expect(button("Remove").classList).toContain("hx-button-loading");
    expect(button("Cancel").disabled).toBe(true);
    expect(dialog()?.querySelector(".hx-dialog-close")).toBeNull();
    await escape();
    expect(dialog()).not.toBeNull();

    pending.resolve({ outcomes: [], failures: [] });
    await render();

    expect(dialog()).toBeNull();
  });

  it("stays busy until a removal ends, also after an endpoint switch", async () => {
    const pending = deferred<{ outcomes: []; failures: [] }>();
    vi.mocked(runCleanup).mockReturnValue(pending.promise);
    const { host, dialog, button, select, click, render, switchEndpoint } = await openCleanup();
    await select(0);
    await click("Preview");
    await click("Remove");

    await switchEndpoint();

    expect(dialog()).toBeNull();
    expect(button("Clean up…", host).disabled).toBe(true);
    pending.resolve({ outcomes: [], failures: [] });
    await render();
    expect(button("Clean up…", host).disabled).toBe(false);
  });
});
