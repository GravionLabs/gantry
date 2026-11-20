import type { Endpoint, EngineInfo } from "./bindings";
import { invoke } from "./invoke";

export type { EngineInfo } from "./bindings";

/** Reads the version of the default local engine through the Tauri command `engine_ping`. */
export function pingEngine(): Promise<EngineInfo> {
  return invoke<EngineInfo>("engine_ping");
}

/** Activates the endpoint (reusing its connection, e.g. `ssh://`) and reads its engine version. */
export function pingEndpoint(endpoint: Pick<Endpoint, "name" | "address">): Promise<EngineInfo> {
  return invoke<EngineInfo>("endpoint_ping", { name: endpoint.name, address: endpoint.address });
}

/** One-line description of an engine, e.g. `Docker 28.1.1 (API 1.49, linux/amd64)`. */
export function describeEngine(info: EngineInfo): string {
  const platform = info.os && info.arch ? `, ${info.os}/${info.arch}` : "";
  const api = info.apiVersion ? `API ${info.apiVersion}` : "API unknown";
  return `Docker ${info.version ?? "unknown"} (${api}${platform})`;
}
