import { invoke } from "@tauri-apps/api/core";

/** Mirrors `gantry_core::EngineInfo`. */
export interface EngineInfo {
  version: string | null;
  apiVersion: string | null;
  os: string | null;
  arch: string | null;
}

/** Reads the version of the default local engine through the Tauri command `engine_ping`. */
export function pingEngine(): Promise<EngineInfo> {
  return invoke<EngineInfo>("engine_ping");
}

/** One-line description of an engine, e.g. `Docker 28.1.1 (API 1.49, linux/amd64)`. */
export function describeEngine(info: EngineInfo): string {
  const platform = info.os && info.arch ? `, ${info.os}/${info.arch}` : "";
  const api = info.apiVersion ? `API ${info.apiVersion}` : "API unknown";
  return `Docker ${info.version ?? "unknown"} (${api}${platform})`;
}
