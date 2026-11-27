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

describe("app styles", () => {
  it("read no palette step", () => {
    const app = readFileSync(resolve(process.cwd(), "src/app/app.css"), "utf8");

    expect(app).not.toMatch(
      /--h-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|primary|surface)-\d+\b/,
    );
  });
});

const TOKEN_STYLES = [
  "app.css",
  "volumes/volumes-view.css",
  "networks/networks-view.css",
  "system/system-view.css",
  "settings/settings-view.css",
  "containers/container-logs.css",
  "containers/container-terminal.css",
  "containers/terminal-session.css",
];

/** Literals that stay, each with a reason; an entry that matches nothing fails the test. */
const LITERAL_EXCEPTIONS = [
  {
    file: "app.css",
    declaration: ".dot { border-radius: 50% }",
    reason: "The status dot is a circle; no radius step draws one at every size",
  },
];

const SPACING = /^(?:scroll-)?(?:margin|padding)(?:-[a-z]+)*$|^(?:grid-)?(?:row-|column-)?gap$/;
const RADIUS = /^border(?:-[a-z]+)*-radius$/;
const SPACE_VALUE = /^(?:0|var\(--h-space-[1-8]\))$/;
const RADIUS_VALUE = /^var\(--h-border-radius-(?:none|xs|sm|md|lg|xl)\)$/;

/** The spacing and radius declarations with a value that is no token step, as `selector { … }`. */
function literals(source: string): string[] {
  const rules = source.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{};]+)\{([^{}]*)\}/g);
  return [...rules].flatMap(([, selector, body]) =>
    body.split(";").flatMap((declaration) => {
      const colon = declaration.indexOf(":");
      const property = declaration.slice(0, colon).trim().toLowerCase();
      const value = declaration.slice(colon + 1).trim();
      const allowed = SPACING.test(property)
        ? SPACE_VALUE
        : RADIUS.test(property)
          ? RADIUS_VALUE
          : null;
      if (colon < 0 || !allowed || value.split(/\s+/).every((part) => allowed.test(part)))
        return [];
      return [`${selector.trim().replace(/\s+/g, " ")} { ${property}: ${value} }`];
    }),
  );
}

describe("spacing and radius check", () => {
  it.each([
    "gap: 0.6rem",
    "row-gap: 4px",
    "column-gap: 1em",
    "padding: var(--h-space-3) 1rem",
    "padding-inline-start: 2px",
    "margin: 0 auto",
    "margin-top: -1px",
    "margin-top: calc(var(--h-space-1) * 3)",
    "padding: var(--h-space-2, 0.5rem)",
    "padding: var(--h-space-9)",
    "border-radius: 0.5rem",
    "border-top-left-radius: 4px",
    "border-radius: var(--h-space-2)",
  ])("reports %s", (declaration) => {
    expect(literals(`.a { color: red; ${declaration}; }`)).toEqual([`.a { ${declaration} }`]);
  });

  it("reports a literal in a nested rule and in the last declaration without a semicolon", () => {
    expect(literals("@media (width < 40rem) { .a, .b { gap: 1px } }")).toEqual([
      ".a, .b { gap: 1px }",
    ]);
  });

  it("accepts token steps, 0, other properties and comments", () => {
    const source = `
      /* gap: 1rem; */
      .a {
        gap: var(--h-space-1) var(--h-space-8);
        margin: 0 0 var(--h-space-2);
        padding: 0;
        border-radius: var(--h-border-radius-md);
        width: 20rem;
        border: 1px solid;
      }
      .b {}`;

    expect(literals(source)).toEqual([]);
  });
});

describe("spacing and radii of the migrated views", () => {
  it.each(TOKEN_STYLES)("%s uses only token steps", (file) => {
    const source = readFileSync(resolve(process.cwd(), "src/app", file), "utf8");
    const excepted = LITERAL_EXCEPTIONS.filter((entry) => entry.file === file);

    expect(literals(source)).toEqual(excepted.map((entry) => entry.declaration));
  });

  it("gives a reason for every exception, each in a checked file", () => {
    for (const { file, reason } of LITERAL_EXCEPTIONS) {
      expect(TOKEN_STYLES).toContain(file);
      expect(reason).not.toBe("");
    }
  });
});
