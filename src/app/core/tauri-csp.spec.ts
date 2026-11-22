import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

type Csp = Record<string, string>;
interface TauriConfig {
  app: {
    security: {
      csp: Csp;
      devCsp?: Csp;
      dangerousDisableAssetCspModification?: boolean | string[];
    };
  };
}

const config = JSON.parse(
  readFileSync(resolve(process.cwd(), "src-tauri/tauri.conf.json"), "utf8"),
) as TauriConfig;
const security = config.app.security;

const policies: [string, Csp | undefined][] = [
  ["csp", security.csp],
  ["devCsp", security.devCsp],
];

describe("tauri.conf.json CSP", () => {
  it("keeps Tauri from rewriting style-src", () => {
    const setting = security.dangerousDisableAssetCspModification;
    expect(Array.isArray(setting) && setting.includes("style-src")).toBe(true);
  });

  describe.each(policies)("%s", (_name, policy) => {
    it("is defined", () => {
      expect(policy).toBeDefined();
    });

    it("allows inline styles", () => {
      expect(policy?.["style-src"]?.split(/\s+/)).toContain("'unsafe-inline'");
    });

    it("forbids inline scripts", () => {
      expect(policy?.["script-src"]?.split(/\s+/) ?? []).not.toContain("'unsafe-inline'");
    });
  });
});
