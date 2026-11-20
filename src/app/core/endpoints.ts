import type { DetectedEngine } from "./bindings";
import { invoke } from "./invoke";

export type { DetectedEngine, EngineStatus } from "./bindings";

/** Finds the Docker engines on this machine through the Tauri command `endpoints_detect`. */
export function detectEndpoints(): Promise<DetectedEngine[]> {
  return invoke<DetectedEngine[]>("endpoints_detect");
}
