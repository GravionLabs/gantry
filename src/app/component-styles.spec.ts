import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Interim check of the component styles until the helix-lint Stylelint preset replaces it
// (docs/STYLEGUIDE.md): no control rule set, font sizes from the type scale, colors from tokens.

type Rule = "control" | "font-size" | "color" | "token";

interface Violation {
  file: string;
  selector: string;
  rule: Rule;
  text: string;
}

/** An exception: `rule` is allowed in the rule sets of `file` whose whole selector matches. */
interface Allow {
  file: string;
  selector: RegExp;
  rule: Rule;
  reason: string;
}

const DARK_SURFACE =
  "Dark log and terminal surface, independent of the theme; Helix has no token for it";

const ALLOW: Allow[] = [
  {
    file: "containers/container-logs.css",
    selector: /^(\.viewport|\.line\.stderr|\.line\.current|\.hit(\.current)?|\.empty)$/,
    rule: "color",
    reason: DARK_SURFACE,
  },
  {
    file: "containers/container-logs.css",
    selector: /^\.ansi-(fg|bg)-\d+$/,
    rule: "color",
    reason: `ANSI palette of the log output. ${DARK_SURFACE}`,
  },
  {
    file: "containers/terminal-session.css",
    selector: /^\.terminal$/,
    rule: "color",
    reason: DARK_SURFACE,
  },
];

const CONTROL = /(?<![\w.#-])(button|input|select|textarea|progress)(?![\w-])/i;
const FONT_SIZE = /^(var\(--h-font-size-(xs|sm|md|lg|xl|2xl|3xl)\)|inherit)$/;
const COLOR = /#[0-9a-f]{3,8}\b|\b(rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(/i;

const app = resolve(process.cwd(), "src/app");
const read = (file: string) => readFileSync(resolve(process.cwd(), file), "utf8");
const defined = new Set(
  [read("node_modules/@gravionlabs/helix-ui/tokens.css"), read("src/styles.scss")].flatMap((css) =>
    [...css.matchAll(/(--[\w-]+)\s*:/g)].map(([, name]) => name),
  ),
);

function check(file: string, css: string): Violation[] {
  const found: Violation[] = [];
  const code = css.replace(/\/\*[\s\S]*?\*\//g, "");
  // The innermost blocks are the rule sets; the prelude of an at-rule around them is skipped.
  for (const [, prelude, body] of code.matchAll(/([^{};]+)\{([^{}]*)\}/g)) {
    const selector = prelude.trim().replace(/\s+/g, " ");
    const add = (rule: Rule, text: string) => found.push({ file, selector, rule, text });
    if (CONTROL.test(selector.replace(/\[[^\]]*\]/g, ""))) add("control", selector);
    for (const declaration of body.split(";")) {
      const colon = declaration.indexOf(":");
      if (colon < 0) continue;
      const property = declaration.slice(0, colon).trim().toLowerCase();
      const value = declaration.slice(colon + 1).trim();
      const text = `${property}: ${value}`;
      const size = value.replace(/\s*!important$/, "");
      if (property === "font-size" && !FONT_SIZE.test(size)) add("font-size", text);
      if (property === "font" && size !== "inherit") add("font-size", text);
      if (COLOR.test(value)) add("color", text);
      for (const [, name] of value.matchAll(/var\(\s*(--(?:h|hx|helix)-[\w-]+)/g)) {
        // The mono family is declared by the stylesheet of helix-shell, not by the tokens.
        if (name !== "--helix-font-mono" && !defined.has(name)) add("token", text);
      }
    }
  }
  return found;
}

const files = readdirSync(app, { recursive: true, encoding: "utf8" })
  .filter((f) => f.endsWith(".css"))
  .map((f) => f.replaceAll("\\", "/"));
const violations = files.flatMap((f) => check(f, read(`src/app/${f}`)));
const allows = (a: Allow, v: Violation) =>
  a.file === v.file && a.rule === v.rule && a.selector.test(v.selector);

describe("component styles", () => {
  it("reads the component stylesheets and the tokens", () => {
    expect(files).toContain("app.css");
    expect(defined).toContain("--h-font-size-sm");
  });

  it.each<[Rule, string]>([
    ["control", "has no rule set for a native control"],
    ["font-size", "takes every font size from the type scale"],
    ["color", "has no hex color or color function"],
    ["token", "reads only tokens that exist"],
  ])("%s: %s", (rule) => {
    expect(violations.filter((v) => v.rule === rule && !ALLOW.some((a) => allows(a, v)))).toEqual(
      [],
    );
  });

  it("has no unused allowlist entry", () => {
    expect(ALLOW.filter((a) => !violations.some((v) => allows(a, v)))).toEqual([]);
  });

  it("reports each kind of violation", () => {
    const css = `/* #fff */
      .a input[type="text"], .b { width: 1rem }
      @media (width > 1px) { .c { font-size: 0.85em; color: var(--h-none, #111) } }
      .d { font: 12px serif; background: rgb(0 0 0) }
      .input-row hx-select, .e[data-x="button"] { font-size: var(--h-font-size-sm) }`;
    expect(check("x.css", css).map((v) => `${v.selector} ${v.rule}`)).toEqual([
      '.a input[type="text"], .b control',
      ".c font-size",
      ".c color",
      ".c token",
      ".d font-size",
      ".d color",
    ]);
  });
});
