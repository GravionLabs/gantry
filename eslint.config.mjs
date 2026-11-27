import { readFileSync } from "node:fs";
import tseslint from "typescript-eslint";
import angular from "angular-eslint";
import helix, { helixAllow } from "@gravionlabs/helix-lint/eslint";

// Exceptions to the helix-lint preset, each with a reason (#159): scripts/lint/helix-allow.json.
const allow = JSON.parse(
  readFileSync(new URL("./scripts/lint/helix-allow.json", import.meta.url), "utf8"),
);

/**
 * ESLint lints the Angular templates only, because oxlint cannot parse them (ADR 0004 and
 * ADR 0006 of GravionLabs/skills). TypeScript is linted by oxlint. The inline templates of the
 * grid cell renderers (`src/app/grid/cells.ts`) are linted through the inline-template processor.
 */
export default tseslint.config(
  {
    ignores: [
      "dist/**",
      ".angular/**",
      "node_modules/**",
      ".agents/**",
      ".claude/**",
      "src-tauri/**",
      "crates/**",
      "target/**",
      // The lint probe holds deliberate violations; src/testing/lint-probe.spec.ts lints it.
      "src/testing/lint-probe/**",
    ],
  },
  {
    files: ["src/**/*.ts"],
    languageOptions: { parser: tseslint.parser },
    processor: angular.processInlineTemplates,
  },
  // helix/no-raw-control: no native button, input, select, textarea or progress in a template.
  ...helix,
  ...allow.eslint.map((entry) => helixAllow(entry)),
);
