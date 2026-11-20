import type { Endpoint, EngineInfo } from "./bindings";
import { invoke } from "./invoke";

export type { EngineInfo } from "./bindings";

/** Connects to an endpoint and reads its engine version through the Tauri command `endpoint_test`. */
export function pingEndpoint(endpoint: Endpoint): Promise<EngineInfo> {
  return invoke<EngineInfo>("endpoint_test", { endpoint });
}

/** Activates the endpoint (reusing its connection, e.g. `ssh://`) and reads its engine version. */
export function activateEndpoint(endpoint: Endpoint): Promise<EngineInfo> {
  return invoke<EngineInfo>("endpoint_activate", { endpoint });
}

/** One-line description of an engine, e.g. `Docker 28.1.1 (API 1.49, linux/amd64)`. */
export function describeEngine(info: EngineInfo): string {
  const platform = info.os && info.arch ? `, ${info.os}/${info.arch}` : "";
  const api = info.apiVersion ? `API ${info.apiVersion}` : "API unknown";
  return `Docker ${info.version ?? "unknown"} (${api}${platform})`;
}
