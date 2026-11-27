import { readFileSync } from "node:fs";
import { ESLint } from "eslint";
import { helixAllow as eslintAllow } from "@gravionlabs/helix-lint/eslint";
import { helixAllow as stylelintAllow } from "@gravionlabs/helix-lint/stylelint";
import stylelint from "stylelint";
import { describe, expect, it } from "vitest";

/**
 * `src/testing/lint-probe/` holds deliberate violations of the helix-lint preset (#159), left out
 * of `pnpm lint`. This spec lints them and expects every rule, so a rule that stops reporting
 * fails here instead of linting nothing. The inline template and inline styles of a component
 * (`src/app/grid/cells.ts` has them) are linted from a string, so no probe component is compiled.
 */
const PROBE = "src/testing/lint-probe";
// Both linters load their plugins; under load that exceeds the default 5 s.
const TIMEOUT = 60_000;

const INLINE = `import { Component } from "@angular/core";
@Component({
  selector: "app-probe",
  template: \`<button type="button">Raw</button>\`,
  styles: \`
    .probe { color: #123456; font-size: 13px; }
    input { margin: 0; }
  \`,
})
export class ProbeComponent {}
`;

interface AllowFile {
  eslint: { files: string[]; rules: string[]; reason: string }[];
  stylelint: { files: string[]; rules: string[]; reason: string }[];
}

describe("lint probe", () => {
  it(
    "ESLint reports the raw controls of a template file",
    async () => {
      const [result] = await new ESLint({ ignore: false }).lintFiles([`${PROBE}/probe.html`]);
      expect(result.messages.map((m) => `${m.ruleId} ${m.line}`)).toEqual([
        "helix/no-raw-control 2",
        "helix/no-raw-control 3",
        "helix/no-raw-control 4",
        "helix/no-raw-control 5",
        "helix/no-raw-control 6",
      ]);
    },
    TIMEOUT,
  );

  it(
    "ESLint reports a raw control in an inline template",
    async () => {
      const [result] = await new ESLint({ ignore: false }).lintText(INLINE, {
        filePath: "src/testing/inline-probe.ts",
      });
      expect(result.messages.map((m) => m.ruleId)).toEqual(["helix/no-raw-control"]);
    },
    TIMEOUT,
  );

  it(
    "Stylelint reports the hex color, rgb(), the off-scale font size, the styled native control and the .btn classes in a stylesheet",
    async () => {
      const { results } = await stylelint.lint({ files: `${PROBE}/probe.css`, ignorePath: [] });
      expect(results[0].warnings.map((w) => `${w.rule} ${w.line}`).sort()).toEqual(
        [
          "color-no-hex 3",
          "declaration-property-value-allowed-list 4",
          "function-disallowed-list 5",
          "selector-disallowed-list 9",
          "declaration-property-value-disallowed-list 10",
          "selector-disallowed-list 12",
          "selector-disallowed-list 15",
          "selector-disallowed-list 18",
        ].sort(),
      );
    },
    TIMEOUT,
  );

  it(
    "Stylelint reports the same rules in inline styles",
    async () => {
      const { results } = await stylelint.lint({
        code: INLINE,
        codeFilename: "src/testing/inline-probe.ts",
        ignorePath: [],
      });
      expect(results[0].warnings.map((w) => w.rule).sort()).toEqual([
        "color-no-hex",
        "declaration-property-value-allowed-list",
        "selector-disallowed-list",
      ]);
    },
    TIMEOUT,
  );

  it("every allowlist entry names a file, a rule and a reason; an entry without one throws", () => {
    const allow = JSON.parse(readFileSync("scripts/lint/helix-allow.json", "utf8")) as AllowFile;
    for (const entry of [...allow.eslint, ...allow.stylelint]) {
      expect(entry.reason.trim().length).toBeGreaterThan(10);
      // One file and one rule per entry: a glob or a list would hide new violations.
      expect(entry.files).toHaveLength(1);
      expect(entry.rules).toHaveLength(1);
      for (const file of entry.files) expect(file).not.toContain("*");
    }
    const bare = { files: ["src/app/x.css"], rules: ["helix/no-raw-control"] };
    expect(() => eslintAllow(bare)).toThrow(/reason/);
    expect(() => stylelintAllow(bare)).toThrow(/reason/);
  });
});
