import type { Endpoint, ExecEvent, ExecOptions } from "./bindings";
import { invoke, stream } from "./invoke";

export type { ExecEvent, ExecOptions } from "./bindings";

/** The shells offered for a new terminal; `custom` takes a command line. */
export const SHELL_CHOICES = [
  { id: "sh", label: "/bin/sh", command: ["/bin/sh"] },
  { id: "bash", label: "/bin/bash", command: ["/bin/bash"] },
  { id: "custom", label: "Custom command", command: null },
] as const;

export type ShellId = (typeof SHELL_CHOICES)[number]["id"];

/**
 * Splits a command line into arguments. Spaces separate arguments; single and double quotes group
 * them and a backslash escapes the next character outside single quotes. Throws on an open quote.
 */
export function splitCommand(line: string): string[] {
  const args: string[] = [];
  let current = "";
  let started = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote === "'") {
      if (ch === "'") quote = null;
      else current += ch;
    } else if (ch === "\\" && i + 1 < line.length) {
      current += line[++i];
      started = true;
    } else if (quote === '"') {
      if (ch === '"') quote = null;
      else current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
    } else if (/\s/.test(ch)) {
      if (started) args.push(current);
      current = "";
      started = false;
    } else {
      current += ch;
      started = true;
    }
  }
  if (quote) throw new Error(`Missing closing ${quote} in the command`);
  if (started) args.push(current);
  return args;
}

/** What the user chose for a terminal. */
export interface ShellChoice {
  readonly shell: ShellId;
  /** The command line when `shell` is `custom`. */
  readonly custom: string;
  /** Empty for the container's own user. */
  readonly user: string;
}

/** The command and user of a terminal; throws an `Error` with a message for the user. */
export function resolveShell(choice: ShellChoice): { command: string[]; user: string | null } {
  const preset = SHELL_CHOICES.find((s) => s.id === choice.shell);
  const command = preset?.command ? [...preset.command] : splitCommand(choice.custom);
  if (command.length === 0) throw new Error("Enter a command to run");
  const user = choice.user.trim();
  return { command, user: user === "" ? null : user };
}

/** The tab title of a terminal: the program, with the user when one is set. */
export function sessionTitle(command: readonly string[], user: string | null): string {
  const program = command[0]?.split("/").pop() || "shell";
  return user ? `${program} (${user})` : program;
}

/** The message shown when the process ended. */
export function exitMessage(code: number | null): string {
  return code === null ? "Process ended" : `Process exited with code ${code}`;
}

/** A running exec session. */
export interface ExecHandle {
  /** Sends keyboard input. */
  write(data: string): void;
  /** Tells the process the new size of the terminal. */
  resize(cols: number, rows: number): void;
  /** Ends the process by closing the session; a no-op once it has ended. */
  close(): void;
}

export interface ExecListeners {
  onOutput(text: string): void;
  /** The process ended by itself. */
  onExit(code: number | null): void;
  /** The session failed or ended; `error` is null for a normal end. */
  onEnd(error: unknown): void;
}

/** Starts `options.command` with a terminal in a container. */
export function openExec(
  endpoint: Endpoint,
  id: string,
  options: ExecOptions,
  listeners: ExecListeners,
): ExecHandle {
  const sessionId = crypto.randomUUID();
  let closed = false;
  let ended = false;
  stream<ExecEvent>(
    "exec_start",
    (event) => {
      if (closed) return;
      if (event.type === "output") listeners.onOutput(event.text);
      else listeners.onExit(event.code);
    },
    { endpoint, id, options, sessionId },
  ).then(
    () => {
      ended = true;
      if (!closed) listeners.onEnd(null);
    },
    (error: unknown) => {
      ended = true;
      if (!closed) listeners.onEnd(error);
    },
  );
  const send = (command: string, args: Record<string, unknown>) => {
    if (!closed && !ended) void invoke(command, { sessionId, ...args }).catch(() => {});
  };
  return {
    write: (data) => send("exec_write", { data }),
    resize: (cols, rows) => send("exec_resize", { cols, rows }),
    close: () => {
      if (closed) return;
      closed = true;
      if (!ended) void invoke("exec_close", { sessionId }).catch(() => {});
    },
  };
}
