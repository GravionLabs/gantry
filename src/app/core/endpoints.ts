import type { ContextList, DetectedEngine, Endpoint, TlsFiles } from "./bindings";
import { invoke } from "./invoke";

export type { ContextList, DetectedEngine, Endpoint, EngineStatus, TlsFiles } from "./bindings";

/** Finds the Docker engines on this machine through the Tauri command `endpoints_detect`. */
export function detectEndpoints(): Promise<DetectedEngine[]> {
  return invoke<DetectedEngine[]>("endpoints_detect");
}

/** Validates what the user typed for a manual endpoint (TCP, TCP+TLS, SSH) through `endpoint_build`. */
export function buildEndpoint(
  name: string,
  address: string,
  tls: TlsFiles | null,
): Promise<Endpoint> {
  return invoke<Endpoint>("endpoint_build", { name, address, tls });
}

/** The Docker CLI contexts as read-only endpoints through `endpoints_contexts`. */
export function listContexts(): Promise<ContextList> {
  return invoke<ContextList>("endpoints_contexts");
}
