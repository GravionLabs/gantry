import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Every `hx-dialog` of the app has a size class (docs/STYLEGUIDE.md, Dialogs). The table below
// names each dialog by its template and header: a new dialog is added to it with its size.
const SIZES: Record<string, string> = {
  "system/system-view.html: Clean up unused data": "md",
};

const root = resolve(process.cwd(), "src");
const files = readdirSync(root, { recursive: true, encoding: "utf8" });
const read = (file: string) => readFileSync(join(root, file), "utf8");

/** The opening tags of the dialogs in the templates, inline ones included. */
const dialogs = files
  .filter((f) => f.endsWith(".html") || (f.endsWith(".ts") && !f.endsWith(".spec.ts")))
  .flatMap((file) =>
    [...read(file).matchAll(/<hx-dialog(?=[\s/>])(?:"[^"]*"|'[^']*'|[^'">])*>/g)].map(([tag]) => ({
      file: file.replaceAll("\\", "/").replace(/^app\//, ""),
      tag,
    })),
  );

const attribute = (tag: string, name: string) => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];

describe("dialog sizes", () => {
  it("gives every hx-dialog its size class", () => {
    const sizes = Object.fromEntries(
      dialogs.map(({ file, tag }) => [
        `${file}: ${attribute(tag, "header")}`,
        attribute(tag, "size"),
      ]),
    );
    expect(sizes).toEqual(SIZES);
  });

  it("sets no free width", () => {
    for (const { tag } of dialogs) expect(tag).not.toMatch(/\s\[?width\]?=/);
  });

  it("leaves the width of a dialog to Helix", () => {
    const styles = files.filter((f) => f.endsWith(".css") || f.endsWith(".scss"));
    for (const file of styles) expect(read(file), file).not.toMatch(/hx-dialog/);
  });
});
