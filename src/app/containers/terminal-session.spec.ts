// @vitest-environment happy-dom
import { Input, ViewChild, signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { BrowserTestingModule, platformBrowserTesting } from "@angular/platform-browser/testing";
import { afterEach, describe, expect, it, vi } from "vitest";

import { type ExecListeners, openExec } from "../core/exec";
import { renderTemplateOf } from "../../../testing/render-template";
import { TerminalSession } from "./terminal-session";

/** The exec sessions, in the order they were opened. */
const sessions = vi.hoisted(
  () =>
    [] as {
      listeners: ExecListeners;
      write: ReturnType<typeof vi.fn>;
      resize: ReturnType<typeof vi.fn>;
      close: ReturnType<typeof vi.fn>;
    }[],
);
/** What the xterm surface was told, and the input it sends. */
const xterm = vi.hoisted(() => ({
  reset: vi.fn(),
  focus: vi.fn(),
  data: [] as ((data: string) => void)[],
}));

vi.mock("../core/exec", async (original) => ({
  ...(await original<typeof import("../core/exec")>()),
  openExec: vi.fn((_endpoint, _id, _options, listeners: ExecListeners) => {
    const handle = { write: vi.fn(), resize: vi.fn(), close: vi.fn() };
    sessions.push({ listeners, ...handle });
    return handle;
  }),
}));
// The xterm surface needs a real layout.
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    reset = xterm.reset;
    focus = xterm.focus;
    loadAddon() {}
    open() {}
    write() {}
    dispose() {}
    onData(listener: (data: string) => void) {
      xterm.data.push(listener);
    }
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

// The JIT compiler of the tests does not know signal inputs and queries: declare them as Angular's
// JIT transform would, so the real component runs.
for (const name of ["endpoint", "containerId", "command", "user", "active"]) {
  Input({ isSignal: true, alias: name } as Input)(TerminalSession.prototype, name);
}
ViewChild("host", { isSignal: true } as object)(TerminalSession.prototype, "host");

const endpoint = { address: "unix:///var/run/docker.sock" };

function open() {
  renderTemplateOf(TerminalSession, "containers/terminal-session.html");
  const fixture = TestBed.createComponent(TerminalSession);
  Object.assign(fixture.componentInstance, {
    endpoint: signal(endpoint),
    containerId: signal("abc"),
    command: signal(["/bin/bash"]),
    user: signal("root"),
    active: signal(true),
  });
  const element = fixture.nativeElement as HTMLElement;
  const render = () => {
    fixture.detectChanges();
    TestBed.tick();
  };
  render();
  const message = () => element.querySelector("hx-message");
  const retry = () =>
    Array.from(element.querySelectorAll("button")).find((b) => b.textContent?.trim() === "Retry");
  return { element, render, message, retry };
}

describe("terminal session", () => {
  afterEach(() => {
    TestBed.resetTestingModule();
    vi.clearAllMocks();
    sessions.length = 0;
    xterm.data.length = 0;
  });

  it("shows the engine's text of a failed session with Retry", () => {
    const { element, render, message, retry } = open();
    expect(message()).toBeNull();

    sessions[0]!.listeners.onEnd({ kind: "engine", message: "no such file or directory" });
    render();

    expect(message()?.getAttribute("severity")).toBe("error");
    expect(message()?.getAttribute("role")).toBe("alert");
    expect(message()?.textContent).toContain("Cannot run the command: no such file or directory");
    expect(retry()).toBeDefined();
    expect(element.querySelector(".notice")).toBeNull();
  });

  it("starts the same command again on Retry and sends input to the new session", () => {
    const { render, message, retry } = open();
    sessions[0]!.listeners.onExit(126);
    sessions[0]!.listeners.onEnd({ kind: "engine", message: "exec failed" });
    render();

    retry()!.click();
    render();

    expect(openExec).toHaveBeenCalledTimes(2);
    expect(vi.mocked(openExec).mock.calls[1]!.slice(0, 3)).toEqual(
      vi.mocked(openExec).mock.calls[0]!.slice(0, 3),
    );
    expect(message()).toBeNull();
    expect(xterm.reset).toHaveBeenCalled();
    expect(xterm.focus).toHaveBeenCalled();

    expect(xterm.data).toHaveLength(1);
    xterm.data[0]!("ls");
    expect(sessions[1]!.write).toHaveBeenCalledWith("ls");
    expect(sessions[0]!.write).not.toHaveBeenCalled();

    sessions[1]!.listeners.onEnd({ kind: "engine", message: "still failing" });
    render();
    expect(message()?.textContent).toContain("still failing");
  });

  it("keeps the quiet notice of a session that ended normally", () => {
    const { element, render, message, retry } = open();
    sessions[0]!.listeners.onExit(0);
    sessions[0]!.listeners.onEnd(null);
    render();

    expect(element.querySelector(".notice")?.textContent).toContain(
      "Process exited with code 0. Close the tab or open a new terminal.",
    );
    expect(element.querySelector(".notice")?.getAttribute("role")).toBe("status");
    expect(message()).toBeNull();
    expect(retry()).toBeUndefined();
  });
});
