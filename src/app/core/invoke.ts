import { Channel, invoke as tauriInvoke } from "@tauri-apps/api/core";
import type { ErrorKind, ErrorPayload } from "./bindings";

const ERROR_KINDS: readonly ErrorKind[] = [
  "unreachable",
  "permissionDenied",
  "notFound",
  "conflict",
  "invalidInput",
  "engine",
];

/** Error thrown by every command; mirrors `gantry_core::ErrorPayload`. */
export class GantryError extends Error implements ErrorPayload {
  constructor(
    readonly kind: ErrorKind,
    message: string,
    readonly command?: string,
  ) {
    super(message);
    this.name = "GantryError";
  }
}

function isPayload(value: unknown): value is ErrorPayload {
  if (typeof value !== "object" || value === null) return false;
  const { kind, message } = value as Record<string, unknown>;
  return (
    typeof message === "string" &&
    typeof kind === "string" &&
    ERROR_KINDS.includes(kind as ErrorKind)
  );
}

/** Turns whatever a command rejected with into a `GantryError`. */
export function toGantryError(error: unknown, command?: string): GantryError {
  if (error instanceof GantryError) return error;
  if (isPayload(error)) return new GantryError(error.kind, error.message, command);
  const message =
    typeof error === "string"
      ? error
      : error instanceof Error
        ? error.message
        : JSON.stringify(error);
  return new GantryError("engine", message, command);
}

/** Calls a Tauri command; a failure is always a `GantryError`. */
export async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await tauriInvoke<T>(command, args);
  } catch (error) {
    throw toGantryError(error, command);
  }
}

/**
 * Calls a command that streams events through a Tauri channel (logs, events, stats, exec).
 *
 * The command receives the channel as the argument `onEvent` (`on_event: Channel<T>` in Rust).
 * Resolves with the command's result once it ends; rejects with a `GantryError`.
 */
export function stream<E, R = void>(
  command: string,
  onEvent: (event: E) => void,
  args: Record<string, unknown> = {},
): Promise<R> {
  const channel = new Channel<E>();
  channel.onmessage = onEvent;
  return invoke<R>(command, { ...args, onEvent: channel });
}
