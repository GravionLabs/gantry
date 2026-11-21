import { beforeEach, describe, expect, it, vi } from "vitest";

const tauri = vi.hoisted(() => ({
  invoke: vi.fn(),
  channels: [] as { onmessage: (m: unknown) => void }[],
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: tauri.invoke,
  Channel: class {
    onmessage: (message: unknown) => void = () => {};
    constructor() {
      tauri.channels.push(this);
    }
  },
}));

import type { Endpoint } from "./bindings";
import { exitMessage, openExec, resolveShell, sessionTitle, splitCommand } from "./exec";

const endpoint: Endpoint = {
  name: "ssh host",
  kind: "ssh",
  address: "ssh://me@host",
  tls: null,
  skipTlsVerify: false,
  readOnly: false,
};
const options = { command: ["/bin/sh"], user: null, cols: 80, rows: 24 };

describe("splitCommand", () => {
  it("splits on whitespace and honors quotes and escapes", () => {
    expect(splitCommand("  ls  -la /tmp ")).toEqual(["ls", "-la", "/tmp"]);
    expect(splitCommand(`sh -c "echo 'a b'"`)).toEqual(["sh", "-c", "echo 'a b'"]);
    expect(splitCommand(`echo 'it''s' a\\ b ""`)).toEqual(["echo", "its", "a b", ""]);
    expect(splitCommand("")).toEqual([]);
  });

  it("rejects an open quote", () => {
    expect(() => splitCommand(`echo "x`)).toThrow(/closing "/);
  });
});

describe("resolveShell", () => {
  it("uses the presets and trims the user", () => {
    expect(resolveShell({ shell: "sh", custom: "ignored", user: "" })).toEqual({
      command: ["/bin/sh"],
      user: null,
    });
    expect(resolveShell({ shell: "bash", custom: "", user: " root " })).toEqual({
      command: ["/bin/bash"],
      user: "root",
    });
  });

  it("splits a custom command and needs one", () => {
    expect(resolveShell({ shell: "custom", custom: "zsh -l", user: "1000:1000" })).toEqual({
      command: ["zsh", "-l"],
      user: "1000:1000",
    });
    expect(() => resolveShell({ shell: "custom", custom: "  ", user: "" })).toThrow(/command/);
  });
});

describe("labels", () => {
  it("names a tab after the program and user", () => {
    expect(sessionTitle(["/usr/bin/zsh", "-l"], null)).toBe("zsh");
    expect(sessionTitle(["/bin/sh"], "root")).toBe("sh (root)");
    expect(exitMessage(0)).toBe("Process exited with code 0");
    expect(exitMessage(null)).toBe("Process ended");
  });
});

describe("openExec", () => {
  beforeEach(() => {
    tauri.invoke.mockReset();
    tauri.channels.length = 0;
  });

  function listeners() {
    return { onOutput: vi.fn(), onExit: vi.fn(), onEnd: vi.fn() };
  }

  it("starts the session and forwards output and exit", () => {
    tauri.invoke.mockReturnValue(new Promise<void>(() => {}));
    const l = listeners();
    openExec(endpoint, "abc", options, l);
    const [command, args] = tauri.invoke.mock.calls[0];
    expect(command).toBe("exec_start");
    expect(args).toMatchObject({ id: "abc", options, sessionId: expect.any(String) });
    tauri.channels[0].onmessage({ type: "output", text: "$ " });
    tauri.channels[0].onmessage({ type: "exit", code: 2 });
    expect(l.onOutput).toHaveBeenCalledWith("$ ");
    expect(l.onExit).toHaveBeenCalledWith(2);
  });

  it("sends input and resizes with the session id and ends the process on close", () => {
    tauri.invoke.mockImplementation((command: string) =>
      command === "exec_start" ? new Promise<void>(() => {}) : Promise.resolve(),
    );
    const handle = openExec(endpoint, "abc", options, listeners());
    const sessionId = tauri.invoke.mock.calls[0][1].sessionId;
    handle.write("ls\n");
    handle.resize(100, 30);
    handle.close();
    handle.close();
    handle.write("after");
    const calls = tauri.invoke.mock.calls.slice(1);
    expect(calls).toEqual([
      ["exec_write", { sessionId, data: "ls\n" }],
      ["exec_resize", { sessionId, cols: 100, rows: 30 }],
      ["exec_close", { sessionId }],
    ]);
  });

  it("reports the end and does not close a session that ended", async () => {
    tauri.invoke.mockResolvedValue(undefined);
    const l = listeners();
    const handle = openExec(endpoint, "abc", options, l);
    await Promise.resolve();
    await Promise.resolve();
    expect(l.onEnd).toHaveBeenCalledWith(null);
    handle.close();
    expect(tauri.invoke).toHaveBeenCalledTimes(1);
  });

  it("reports a failed start and stays silent after close", async () => {
    tauri.invoke.mockRejectedValue("boom");
    const l = listeners();
    openExec(endpoint, "abc", options, l);
    await Promise.resolve();
    await Promise.resolve();
    expect(l.onEnd.mock.calls[0][0]).toMatchObject({ message: "boom" });

    tauri.invoke.mockReset();
    tauri.invoke.mockReturnValue(new Promise<void>(() => {}));
    const quiet = listeners();
    const handle = openExec(endpoint, "abc", options, quiet);
    handle.close();
    tauri.channels[1].onmessage({ type: "output", text: "late" });
    expect(quiet.onOutput).not.toHaveBeenCalled();
  });
});
