import { beforeEach, describe, expect, it, vi } from "vitest";

const tauri = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: tauri.invoke,
  Channel: class {
    onmessage: (message: unknown) => void = () => {};
  },
}));

import { GantryError, invoke, stream, toGantryError } from "./invoke";

beforeEach(() => {
  tauri.invoke.mockReset();
});

describe("invoke", () => {
  it("passes the command and arguments and returns the result", async () => {
    tauri.invoke.mockResolvedValue({ ok: true });
    await expect(invoke("do_it", { id: 1 })).resolves.toEqual({ ok: true });
    expect(tauri.invoke).toHaveBeenCalledWith("do_it", { id: 1 });
  });

  it("turns a { kind, message } rejection into a GantryError", async () => {
    tauri.invoke.mockRejectedValue({ kind: "notFound", message: "no such container" });
    const error = await invoke("inspect").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GantryError);
    expect(error).toMatchObject({
      kind: "notFound",
      message: "no such container",
      command: "inspect",
    });
  });

  it("maps unknown rejections to the engine kind", async () => {
    tauri.invoke.mockRejectedValue("plain text");
    await expect(invoke("x")).rejects.toMatchObject({ kind: "engine", message: "plain text" });
  });
});

describe("toGantryError", () => {
  it("rejects an unknown kind", () => {
    expect(toGantryError({ kind: "weird", message: "m" }).kind).toBe("engine");
  });

  it("keeps a GantryError as it is", () => {
    const error = new GantryError("conflict", "in use");
    expect(toGantryError(error)).toBe(error);
  });
});

describe("stream", () => {
  it("hands the channel to the command and forwards its messages", async () => {
    const events: number[] = [];
    tauri.invoke.mockImplementation(
      async (_command: string, args: { onEvent: { onmessage: (m: number) => void } }) => {
        args.onEvent.onmessage(1);
        args.onEvent.onmessage(2);
        return "done";
      },
    );
    const result = await stream<number, string>("logs", (e) => events.push(e), { id: "abc" });
    expect(result).toBe("done");
    expect(events).toEqual([1, 2]);
    expect(tauri.invoke).toHaveBeenCalledWith("logs", expect.objectContaining({ id: "abc" }));
  });

  it("rejects with a GantryError when the command fails", async () => {
    tauri.invoke.mockRejectedValue({ kind: "unreachable", message: "gone" });
    await expect(stream("logs", () => {})).rejects.toMatchObject({ kind: "unreachable" });
  });
});
