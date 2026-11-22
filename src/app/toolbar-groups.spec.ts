import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseTemplate, TmplAstElement, TmplAstText } from "@angular/compiler";
import { describe, expect, it } from "vitest";

// The templates are parsed with the Angular compiler (no DOM needed): the tests check the
// structure of the toolbars, not the pixels.

function elements(nodes: unknown[]): TmplAstElement[] {
  return nodes.filter((n): n is TmplAstElement => n instanceof TmplAstElement);
}

function text(el: TmplAstElement): string {
  return el.children
    .filter((n): n is TmplAstText => n instanceof TmplAstText)
    .map((n) => n.value)
    .join("")
    .trim();
}

function attr(el: TmplAstElement, name: string): string | undefined {
  return el.attributes.find((a) => a.name === name)?.value;
}

function find(nodes: unknown[], match: (el: TmplAstElement) => boolean): TmplAstElement | null {
  for (const el of elements(nodes)) {
    if (match(el)) return el;
    const inner = find(el.children, match);
    if (inner) return inner;
  }
  return null;
}

function toolbar(view: string): TmplAstElement {
  const html = readFileSync(resolve(process.cwd(), `src/app/${view}/${view}-view.html`), "utf8");
  const { nodes, errors } = parseTemplate(html, `${view}-view.html`);
  expect(errors).toBeNull();
  const bar = find(nodes, (el) => attr(el, "class") === "bar");
  expect(bar).not.toBeNull();
  return bar as TmplAstElement;
}

const views: [string, string, string[], string[]][] = [
  ["networks", "Network actions", ["Create…", "Remove…"], ["Prune unused…", "Refresh"]],
  ["volumes", "Volume actions", ["Create…", "Remove…"], ["Prune unused…", "Refresh"]],
  ["system", "System actions", ["Clean up…"], ["Refresh"]],
];

describe.each(views)("%s toolbar", (view, label, start, end) => {
  const bar = toolbar(view);
  const groups = elements(bar.children);
  const labels = (el: TmplAstElement) => elements(el.children).map(text);

  it("stays a labelled toolbar", () => {
    expect(attr(bar, "role")).toBe("toolbar");
    expect(attr(bar, "aria-label")).toBe(label);
  });

  it("holds exactly two groups and no loose buttons", () => {
    expect(groups.map((g) => g.name)).toEqual(["div", "div"]);
    expect(groups.map((g) => attr(g, "class"))).toEqual(["group group-start", "group group-end"]);
  });

  it("puts the creation and selection actions left, maintenance and refresh right", () => {
    expect(labels(groups[0] as TmplAstElement)).toEqual(start);
    expect(labels(groups[1] as TmplAstElement)).toEqual(end);
  });

  it("keeps the tab order equal to the visual order", () => {
    expect(groups.flatMap(labels)).toEqual([...start, ...end]);
  });
});

describe.each(["networks", "volumes", "system"])("%s styles", (view) => {
  const css = readFileSync(resolve(process.cwd(), `src/app/${view}/${view}-view.css`), "utf8");

  it("spreads the two groups and lets them wrap", () => {
    const bar = /\.bar\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(bar).toContain("justify-content: space-between");
    expect(bar).toContain("flex-wrap: wrap");
  });

  it("spaces the buttons of a group like the images actions", () => {
    const group = /\.group\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(group).toContain("gap: 0.4rem");
    expect(group).toContain("flex-wrap: wrap");
  });
});

describe("containers toolbar", () => {
  it("binds the severity of every action to the selection state", () => {
    const html = readFileSync(
      resolve(process.cwd(), "src/app/containers/containers-view.html"),
      "utf8",
    );
    // The toolbar sits in an @if block, which the element walker does not enter: parse it alone.
    const start = html.indexOf('<div class="actions"');
    const markup = html.slice(start, html.indexOf("</div>", start) + 6);
    const { nodes } = parseTemplate(markup, "actions.html");
    const bar = find(nodes, (el) => attr(el, "role") === "toolbar") as TmplAstElement;
    const loop = bar.children.find((n) => "item" in n) as unknown as { children: unknown[] };
    const button = find(loop.children, (el) => el.name === "button") as TmplAstElement;
    expect(button.inputs.map((i) => i.name)).toContain("severity");
    expect(attr(button, "severity")).toBeUndefined();
  });
});
