import type { LogLine, LogOptions } from "./bindings";

export type { LogLine, LogOptions, LogStream } from "./bindings";

/** The most lines kept in the view; older lines are dropped so that 100k lines stay responsive. */
export const MAX_LOG_LINES = 100_000;

/** One line of the view: the raw text with its ANSI escapes and the text without them. */
export interface LogEntry {
  readonly stream: LogLine["stream"];
  readonly raw: string;
  readonly plain: string;
}

// oxlint-disable-next-line no-control-regex
const SGR = /\u001b\[([0-9;:]*)m/g;
// oxlint-disable-next-line no-control-regex
const ANY_ESCAPE = /\u001b\[[0-9;:?]*[ -/]*[@-~]|\u001b[@-Z\\-_]/g;

/** The text without ANSI escape sequences. */
export function stripAnsi(text: string): string {
  return text.replace(ANY_ESCAPE, "");
}

export function toEntry(line: LogLine): LogEntry {
  return { stream: line.stream, raw: line.text, plain: stripAnsi(line.text) };
}

/** Appends `added` and keeps the newest `max` entries. */
export function appendCapped(
  lines: readonly LogEntry[],
  added: readonly LogEntry[],
  max = MAX_LOG_LINES,
): LogEntry[] {
  const all = lines.concat(added);
  return all.length > max ? all.slice(all.length - max) : all;
}

/** The text style of a run of characters. */
export interface AnsiStyle {
  /** Classes for the 16 colors, `ansi-fg-3`, `ansi-bg-1`, `ansi-bold`, … */
  readonly classes: string;
  /** Inline colors for the 256 color and true color forms. */
  readonly style: string;
}

export interface AnsiSegment extends AnsiStyle {
  readonly text: string;
}

interface State {
  fg: string | null;
  bg: string | null;
  fgCss: string | null;
  bgCss: string | null;
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
}

const fresh = (): State => ({
  fg: null,
  bg: null,
  fgCss: null,
  bgCss: null,
  bold: false,
  dim: false,
  italic: false,
  underline: false,
});

/** The CSS color of an entry of the xterm 256 color palette above the 16 basic colors. */
function palette256(n: number): string {
  if (n >= 232) {
    const v = 8 + (n - 232) * 10;
    return `rgb(${v},${v},${v})`;
  }
  const i = n - 16;
  const level = (x: number) => (x === 0 ? 0 : 55 + x * 40);
  return `rgb(${level(Math.floor(i / 36))},${level(Math.floor(i / 6) % 6)},${level(i % 6)})`;
}

/** Applies one SGR parameter list to the state. */
function applySgr(state: State, params: number[]): void {
  for (let i = 0; i < params.length; i++) {
    const p = params[i];
    if (p === 0) Object.assign(state, fresh());
    else if (p === 1) state.bold = true;
    else if (p === 2) state.dim = true;
    else if (p === 3) state.italic = true;
    else if (p === 4) state.underline = true;
    else if (p === 22) state.bold = state.dim = false;
    else if (p === 23) state.italic = false;
    else if (p === 24) state.underline = false;
    else if (p >= 30 && p <= 37) [state.fg, state.fgCss] = [String(p - 30), null];
    else if (p >= 90 && p <= 97) [state.fg, state.fgCss] = [String(p - 90 + 8), null];
    else if (p >= 40 && p <= 47) [state.bg, state.bgCss] = [String(p - 40), null];
    else if (p >= 100 && p <= 107) [state.bg, state.bgCss] = [String(p - 100 + 8), null];
    else if (p === 39) [state.fg, state.fgCss] = [null, null];
    else if (p === 49) [state.bg, state.bgCss] = [null, null];
    else if (p === 38 || p === 48) {
      let css: string | null = null;
      let index: string | null = null;
      if (params[i + 1] === 5 && params[i + 2] !== undefined) {
        const n = params[i + 2];
        if (n < 16) index = String(n);
        else css = palette256(n);
        i += 2;
      } else if (params[i + 1] === 2 && params[i + 4] !== undefined) {
        css = `rgb(${params[i + 2]},${params[i + 3]},${params[i + 4]})`;
        i += 4;
      }
      if (p === 38) [state.fg, state.fgCss] = [index, css];
      else [state.bg, state.bgCss] = [index, css];
    }
  }
}

function styleOf(s: State): AnsiStyle {
  const classes: string[] = [];
  if (s.fg !== null) classes.push(`ansi-fg-${s.fg}`);
  if (s.bg !== null) classes.push(`ansi-bg-${s.bg}`);
  if (s.bold) classes.push("ansi-bold");
  if (s.dim) classes.push("ansi-dim");
  if (s.italic) classes.push("ansi-italic");
  if (s.underline) classes.push("ansi-underline");
  const style = [s.fgCss && `color:${s.fgCss}`, s.bgCss && `background-color:${s.bgCss}`]
    .filter(Boolean)
    .join(";");
  return { classes: classes.join(" "), style };
}

/** Splits a line into runs of equal style. Other escape sequences are dropped. */
export function parseAnsi(raw: string): AnsiSegment[] {
  const text = raw.replace(ANY_ESCAPE, (m) =>
    m.endsWith("m") && m.startsWith("\u001b[") ? m : "",
  );
  const segments: AnsiSegment[] = [];
  const state = fresh();
  let last = 0;
  const push = (end: number) => {
    if (end > last) segments.push({ text: text.slice(last, end), ...styleOf(state) });
  };
  for (const match of text.matchAll(SGR)) {
    push(match.index);
    last = match.index + match[0].length;
    const params = match[1] === "" ? [0] : match[1].split(/[;:]/).map((n) => Number(n) || 0);
    applySgr(state, params);
  }
  push(text.length);
  return segments;
}

/** A run of text to draw; `match` marks a search hit (`current` is the selected one). */
export interface LogPart extends AnsiStyle {
  readonly text: string;
  readonly match: "none" | "match" | "current";
}

const parsed = new WeakMap<LogEntry, AnsiSegment[]>();

/** The runs of a line with the hits of `query` marked (case-insensitive, over the plain text). */
export function renderLine(entry: LogEntry, query: string, isCurrent = false): LogPart[] {
  let segments = parsed.get(entry);
  if (!segments) {
    segments = entry.raw.includes("\u001b") ? parseAnsi(entry.raw) : [];
    if (!segments.length && entry.plain) segments = [{ text: entry.plain, classes: "", style: "" }];
    parsed.set(entry, segments);
  }
  if (!query) return segments.map((s) => ({ ...s, match: "none" as const }));
  const ranges = findRanges(entry.plain, query);
  if (!ranges.length) return segments.map((s) => ({ ...s, match: "none" as const }));
  const parts: LogPart[] = [];
  let offset = 0;
  for (const segment of segments) {
    const end = offset + segment.text.length;
    let at = offset;
    for (const [from, to] of ranges) {
      if (to <= at || from >= end) continue;
      const a = Math.max(from, at);
      const b = Math.min(to, end);
      if (a > at) parts.push({ ...segment, text: entry.plain.slice(at, a), match: "none" });
      parts.push({
        ...segment,
        text: entry.plain.slice(a, b),
        match: isCurrent ? "current" : "match",
      });
      at = b;
    }
    if (at < end) parts.push({ ...segment, text: entry.plain.slice(at, end), match: "none" });
    offset = end;
  }
  return parts;
}

/** The `[from, to)` ranges of the case-insensitive hits of `query` in `text`. */
export function findRanges(text: string, query: string): [number, number][] {
  if (!query) return [];
  const haystack = text.toLowerCase();
  const needle = query.toLowerCase();
  const ranges: [number, number][] = [];
  for (
    let at = haystack.indexOf(needle);
    at >= 0;
    at = haystack.indexOf(needle, at + needle.length)
  ) {
    ranges.push([at, at + needle.length]);
  }
  return ranges;
}

/** The indexes of the lines that contain `query` (case-insensitive). */
export function matchingLines(lines: readonly LogEntry[], query: string): number[] {
  if (!query) return [];
  const needle = query.toLowerCase();
  const result: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].plain.toLowerCase().includes(needle)) result.push(i);
  }
  return result;
}

/** The position after `current` in a ring of `count` matches (`-1` means none selected yet). */
export function stepMatch(current: number, count: number, direction: 1 | -1): number {
  if (count === 0) return -1;
  if (current < 0) return direction === 1 ? 0 : count - 1;
  return (current + direction + count) % count;
}

/** The text of the shown lines for the download, one line per entry, without ANSI escapes. */
export function logsText(lines: readonly LogEntry[]): string {
  return lines.map((l) => l.plain).join("\n") + (lines.length ? "\n" : "");
}

export interface TailChoice {
  readonly label: string;
  readonly value: number | null;
}

export const TAIL_CHOICES: readonly TailChoice[] = [
  { label: "100 lines", value: 100 },
  { label: "500 lines", value: 500 },
  { label: "1000 lines", value: 1000 },
  { label: "5000 lines", value: 5000 },
  { label: "All lines", value: null },
];

export interface SinceChoice {
  readonly label: string;
  /** Seconds before now; null for the beginning. */
  readonly seconds: number | null;
}

export const SINCE_CHOICES: readonly SinceChoice[] = [
  { label: "Beginning", seconds: null },
  { label: "Last 5 minutes", seconds: 300 },
  { label: "Last hour", seconds: 3600 },
  { label: "Last 24 hours", seconds: 86_400 },
];

/** The options of `docker logs` for the choices of the view. `nowMs` is the current time. */
export function buildLogOptions(
  follow: boolean,
  tail: number | null,
  sinceSeconds: number | null,
  timestamps: boolean,
  nowMs = Date.now(),
): LogOptions {
  return {
    follow,
    tail,
    since: sinceSeconds === null ? null : Math.floor(nowMs / 1000) - sinceSeconds,
    timestamps,
  };
}

/** Whether a scroll position is at the end, within `slack` pixels. */
export function isAtBottom(distanceFromBottom: number, slack = 24): boolean {
  return distanceFromBottom <= slack;
}
