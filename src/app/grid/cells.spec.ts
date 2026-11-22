import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  parseTemplate,
  TmplAstElement,
  TmplAstForLoopBlock,
  TmplAstIfBlock,
} from "@angular/compiler";
import { describe, expect, it } from "vitest";

// The environment has no DOM: the template and styles of the cell are read from its source and the
// template is parsed with the Angular compiler.

const source = readFileSync(resolve(process.cwd(), "src/app/grid/cells.ts"), "utf8");
const component = source.slice(
  source.indexOf('selector: "app-container-ports-cell"'),
  source.indexOf("export class ContainerPortsCell"),
);
const template = /template: `([\s\S]*?)`,\n {2}styles/.exec(component)?.[1] ?? "";
const styles = /styles: `([\s\S]*?)`,\n\}\)/.exec(component)?.[1] ?? "";

function walk(nodes: unknown[], visit: (n: unknown) => void): void {
  for (const n of nodes) {
    visit(n);
    if (n instanceof TmplAstElement) walk(n.children, visit);
    if (n instanceof TmplAstForLoopBlock) walk(n.children, visit);
    if (n instanceof TmplAstIfBlock) for (const b of n.branches) walk(b.children, visit);
  }
}

function classOf(el: TmplAstElement): string | undefined {
  return el.attributes.find((a) => a.name === "class")?.value;
}

describe("ContainerPortsCell template", () => {
  const { nodes, errors } = parseTemplate(template, "cells.ts");
  const elements: TmplAstElement[] = [];
  walk(nodes, (n) => {
    if (n instanceof TmplAstElement) elements.push(n);
  });

  it("parses", () => {
    expect(errors).toBeNull();
  });

  it("draws a published TCP port of a local engine as a link that opens the port", () => {
    const links = elements.filter((e) => e.name === "a" && classOf(e) === "port");
    expect(links).toHaveLength(1);
    expect(links[0].outputs.map((o) => o.name)).toEqual(["click"]);
    expect(template).toMatch(/local\(\) && p\.protocol === "tcp" && p\.publicPort !== null/);
  });

  it("draws every other port as plain text", () => {
    const plain = elements.filter((e) => e.name === "span" && classOf(e) === "port");
    expect(plain).toHaveLength(1);
    expect(plain[0].outputs).toHaveLength(0);
  });

  it("separates the ports by a comma, but not after the last", () => {
    const sep = elements.filter((e) => classOf(e) === "sep");
    expect(sep).toHaveLength(1);
    expect(template).toMatch(/@if \(!\$last\)\s*\{\s*<span class="sep">, <\/span>/);
  });
});

describe("ContainerPortsCell styles", () => {
  it("has no border and underlines links on hover and focus", () => {
    expect(styles).not.toContain("border:");
    expect(styles).toMatch(
      /a\.port:hover,\s*a\.port:focus-visible\s*\{\s*text-decoration: underline/,
    );
  });

  it("colors links primary and keeps plain ports in the default color", () => {
    expect(styles).toMatch(/a\.port\s*\{\s*color: var\(--h-primary-color\)/);
    expect(styles).toMatch(/\.port\s*\{\s*color: inherit/);
  });

  it("ends an overflowing list with an ellipsis and shows the focus", () => {
    expect(styles).toContain("text-overflow: ellipsis");
    expect(styles).toMatch(/a\.port:focus-visible\s*\{\s*outline:/);
  });
});
