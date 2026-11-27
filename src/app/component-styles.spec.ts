import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(resolve(process.cwd(), "src/app/settings/settings-view.css"), "utf8");

/** The declarations of the rule with exactly this selector. */
const rule = (selector: string) =>
  new RegExp(`(?:^|\\})\\s*\\${selector}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? "";

describe("settings styles", () => {
  it("set no opacity on text", () => {
    expect(css).not.toMatch(/\bopacity\s*:/);
  });

  it.each([".hint", ".note"])("mute %s with the muted color token", (selector) => {
    expect(rule(selector)).toMatch(/(?:^|;)\s*color:\s*var\(--h-text-muted-color\);/);
  });
});
