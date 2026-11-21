import { describe, expect, it } from "vitest";

import {
  type LogEntry,
  appendCapped,
  buildLogOptions,
  findRanges,
  isAtBottom,
  logsText,
  matchingLines,
  parseAnsi,
  renderLine,
  stepMatch,
  stripAnsi,
  toEntry,
} from "./logs";

const line = (text: string, stream: "stdout" | "stderr" = "stdout"): LogEntry =>
  toEntry({ stream, text });

describe("ANSI", () => {
  it("strips escape sequences", () => {
    expect(stripAnsi("\u001b[31mred\u001b[0m plain \u001b[2K")).toBe("red plain ");
    expect(toEntry({ stream: "stderr", text: "\u001b[1mx\u001b[0m" }).plain).toBe("x");
  });

  it("renders the 16 colors, bold and reset", () => {
    const segments = parseAnsi("a\u001b[1;31mb\u001b[0mc");
    expect(segments.map((s) => s.text)).toEqual(["a", "b", "c"]);
    expect(segments[1].classes).toBe("ansi-fg-1 ansi-bold");
    expect(segments[2].classes).toBe("");
  });

  it("renders bright colors, backgrounds and the 256 and true color forms", () => {
    expect(parseAnsi("\u001b[92;44mx")[0].classes).toBe("ansi-fg-10 ansi-bg-4");
    expect(parseAnsi("\u001b[38;5;2mx")[0].classes).toBe("ansi-fg-2");
    expect(parseAnsi("\u001b[38;5;196mx")[0].style).toBe("color:rgb(255,0,0)");
    expect(parseAnsi("\u001b[48;2;1;2;3mx")[0].style).toBe("background-color:rgb(1,2,3)");
    expect(parseAnsi("\u001b[31;39mx")[0].classes).toBe("");
  });

  it("drops other escape sequences", () => {
    expect(parseAnsi("\u001b[2Kok").map((s) => s.text)).toEqual(["ok"]);
  });
});

describe("search", () => {
  it("finds every hit, case-insensitively", () => {
    expect(findRanges("Error error ERR", "error")).toEqual([
      [0, 5],
      [6, 11],
    ]);
    expect(findRanges("abc", "")).toEqual([]);
  });

  it("lists the matching lines", () => {
    const lines = [line("one"), line("\u001b[31mtwo\u001b[0m"), line("one two")];
    expect(matchingLines(lines, "TWO")).toEqual([1, 2]);
    expect(matchingLines(lines, "")).toEqual([]);
  });

  it("marks hits across colored runs", () => {
    const parts = renderLine(line("ab\u001b[31mcd\u001b[0mef"), "bcd", true);
    expect(parts.map((p) => [p.text, p.match])).toEqual([
      ["a", "none"],
      ["b", "current"],
      ["cd", "current"],
      ["ef", "none"],
    ]);
    expect(parts[2].classes).toBe("ansi-fg-1");
  });

  it("renders a plain line without a query", () => {
    expect(renderLine(line("hello"), "")).toEqual([
      { text: "hello", classes: "", style: "", match: "none" },
    ]);
    expect(renderLine(line(""), "")).toEqual([]);
  });

  it("steps through the matches in a ring", () => {
    expect(stepMatch(-1, 3, 1)).toBe(0);
    expect(stepMatch(-1, 3, -1)).toBe(2);
    expect(stepMatch(2, 3, 1)).toBe(0);
    expect(stepMatch(0, 3, -1)).toBe(2);
    expect(stepMatch(0, 0, 1)).toBe(-1);
  });
});

describe("buffer", () => {
  it("keeps the newest lines within the cap", () => {
    const lines = ["a", "b", "c"].map((t) => line(t));
    const result = appendCapped(lines, [line("d"), line("e")], 4);
    expect(result.map((l) => l.plain)).toEqual(["b", "c", "d", "e"]);
  });

  it("handles 100k lines", () => {
    const batch = Array.from({ length: 1000 }, (_, i) => line(`line ${i}`));
    let lines: LogEntry[] = [];
    for (let i = 0; i < 120; i++) lines = appendCapped(lines, batch);
    expect(lines).toHaveLength(100_000);
    expect(matchingLines(lines, "line 999")).toHaveLength(100);
  });

  it("builds the download text without escapes", () => {
    expect(logsText([line("\u001b[31ma\u001b[0m"), line("b", "stderr")])).toBe("a\nb\n");
    expect(logsText([])).toBe("");
  });
});

describe("options", () => {
  it("turns a relative since into a timestamp", () => {
    expect(buildLogOptions(true, 500, 60, true, 1_000_000_000)).toEqual({
      follow: true,
      tail: 500,
      since: 1_000_000 - 60,
      timestamps: true,
    });
    expect(buildLogOptions(false, null, null, false).since).toBeNull();
  });

  it("detects the end of the scroll area", () => {
    expect(isAtBottom(0)).toBe(true);
    expect(isAtBottom(24)).toBe(true);
    expect(isAtBottom(200)).toBe(false);
  });
});
