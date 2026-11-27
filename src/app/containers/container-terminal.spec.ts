// @vitest-environment happy-dom
import { Input, ViewChild, signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { By } from "@angular/platform-browser";
import { BrowserTestingModule, platformBrowserTesting } from "@angular/platform-browser/testing";
import { HxSelect } from "@gravionlabs/helix-ui";
import { afterEach, describe, expect, it, vi } from "vitest";

import { openExec, resolveShell } from "../core/exec";
import { renderTemplateOf } from "../../../testing/render-template";
import { ContainerTerminal } from "./container-terminal";
import { TerminalSession } from "./terminal-session";

/** The `close` of every exec session, in the order they were opened. */
const closes = vi.hoisted(() => [] as ReturnType<typeof vi.fn>[]);

vi.mock("../core/exec", async (original) => {
  const exec = await original<typeof import("../core/exec")>();
  return {
    ...exec,
    resolveShell: vi.fn(exec.resolveShell),
    openExec: vi.fn(() => {
      const close = vi.fn();
      closes.push(close);
      return { write: vi.fn(), resize: vi.fn(), close };
    }),
  };
});
// The xterm surface needs a real layout.
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    loadAddon() {}
    open() {}
    focus() {}
    write() {}
    dispose() {}
    onData() {}
    onResize() {}
  },
}));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    proposeDimensions() {
      return undefined;
    }
    fit() {}
  },
}));

TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting());

// The JIT compiler of the tests does not know signal inputs and queries: declare those of the
// session as Angular's JIT transform would, so the real component runs.
for (const name of ["endpoint", "containerId", "command", "user", "active"]) {
  Input({ isSignal: true, alias: name } as Input)(TerminalSession.prototype, name);
}
ViewChild("host", { isSignal: true } as object)(TerminalSession.prototype, "host");

const endpoint = { address: "unix:///var/run/docker.sock" };

function open() {
  renderTemplateOf(ContainerTerminal, "containers/container-terminal.html");
  renderTemplateOf(TerminalSession, "containers/terminal-session.html");
  const fixture = TestBed.createComponent(ContainerTerminal);
  Object.assign(fixture.componentInstance, {
    endpoint: signal(endpoint),
    containerId: signal("abc"),
    running: signal(true),
  });
  const element = fixture.nativeElement as HTMLElement;
  const render = () => {
    fixture.detectChanges();
    TestBed.tick();
  };
  render();
  const all = <T extends Element = HTMLElement>(selector: string) =>
    Array.from(element.querySelectorAll<T>(selector));
  const field = (label: string) => {
    const found = all("label").find((l) => l.textContent?.trim() === label) as HTMLLabelElement;
    return element.querySelector<HTMLInputElement>(`#${found.getAttribute("for")}`)!;
  };
  const type = (label: string, value: string) => {
    const input = field(label);
    input.value = value;
    input.dispatchEvent(new Event("input"));
    render();
  };
  const pickShell = (value: string) => {
    const select = fixture.debugElement.query(By.directive(HxSelect))
      .componentInstance as HxSelect<string>;
    select.value.set(value);
    render();
  };
  const openTerminal = () => {
    all<HTMLButtonElement>("button")
      .find((b) => b.textContent?.trim() === "Open terminal")!
      .click();
    render();
  };
  const tabs = () => all('[role="tab"]');
  const selected = () => tabs().map((t) => t.getAttribute("aria-selected"));
  const hidden = () => all("app-terminal-session").map((s) => s.hidden);
  return {
    element,
    render,
    all,
    field,
    type,
    pickShell,
    openTerminal,
    tabs,
    selected,
    hidden,
  };
}

describe("container terminal", () => {
  afterEach(() => {
    TestBed.resetTestingModule();
    vi.clearAllMocks();
    closes.length = 0;
  });

  it("labels the shell, command and user fields", () => {
    const { element, field, pickShell } = open();
    expect(element.querySelector("hx-select")?.textContent).toContain("/bin/sh");
    expect(field("Shell").closest("hx-select")).not.toBeNull();
    expect(field("User").hasAttribute("hx-input")).toBe(true);
    expect(element.querySelector("input.command")).toBeNull();

    pickShell("custom");

    expect(field("Command").hasAttribute("hx-input")).toBe(true);
    expect(field("Command").classList).toContain("mono");
  });

  it("opens a terminal with the chosen shell and user", () => {
    const { type, pickShell, openTerminal, tabs } = open();
    pickShell("bash");
    type("User", "root");
    openTerminal();

    expect(resolveShell).toHaveBeenCalledWith({ shell: "bash", custom: "", user: "root" });
    expect(openExec).toHaveBeenCalledTimes(1);
    expect(openExec).toHaveBeenCalledWith(
      endpoint,
      "abc",
      { command: ["/bin/bash"], user: "root", cols: 80, rows: 24 },
      expect.anything(),
    );
    expect(tabs().map((t) => t.textContent?.trim())).toEqual(["bash (root)"]);
  });

  it("opens a custom command with Enter", () => {
    const { render, field, type, pickShell } = open();
    pickShell("custom");
    type("Command", "/bin/zsh -l");
    field("Command").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    render();

    expect(vi.mocked(openExec).mock.lastCall?.[2]).toMatchObject({
      command: ["/bin/zsh", "-l"],
      user: null,
    });
  });

  it("switches tabs without opening or ending a session", () => {
    const { render, openTerminal, tabs, selected, hidden } = open();
    openTerminal();
    openTerminal();
    expect(selected()).toEqual(["false", "true"]);
    expect(hidden()).toEqual([true, false]);

    tabs()[0]!.click();
    render();

    expect(selected()).toEqual(["true", "false"]);
    expect(hidden()).toEqual([false, true]);

    tabs()[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }));
    render();

    expect(hidden()).toEqual([true, false]);
    expect(openExec).toHaveBeenCalledTimes(2);
    expect(closes.map((c) => c.mock.calls.length)).toEqual([0, 0]);
  });

  it("ends the process of the tab that is closed", () => {
    const { render, all, openTerminal, selected, element } = open();
    openTerminal();
    openTerminal();
    const buttons = () => all<HTMLButtonElement>(".hx-tab-bar-close");
    expect(buttons().map((b) => b.getAttribute("aria-label"))).toEqual([
      "Close sh and end its process",
      "Close sh and end its process",
    ]);

    buttons()[0]!.click();
    render();

    expect(closes.map((c) => c.mock.calls.length)).toEqual([1, 0]);
    expect(selected()).toEqual(["true"]);
    expect(buttons()[0]!.getAttribute("aria-label")).toBe("Close sh and end its process");

    buttons()[0]!.click();
    render();

    expect(closes.map((c) => c.mock.calls.length)).toEqual([1, 1]);
    expect(element.querySelector("hx-tab-bar")).toBeNull();
    expect(element.textContent).toContain("No terminal open");
  });
});
