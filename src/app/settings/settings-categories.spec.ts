import { describe, expect, it } from "vitest";

import {
  DEFAULT_CATEGORY,
  SETTINGS_CATEGORIES,
  readSelectedCategory,
  resolveCategory,
  writeSelectedCategory,
} from "./settings-categories";

function memory(initial?: string) {
  let value = initial ?? null;
  return {
    getItem: () => value,
    setItem: (_: string, v: string) => {
      value = v;
    },
  };
}

describe("settings categories", () => {
  it("lists the four sections in order", () => {
    expect(SETTINGS_CATEGORIES.map((c) => c.label)).toEqual([
      "Appearance",
      "Updates",
      "Containers",
      "Engine",
    ]);
  });

  it("resolves an unknown category to the first", () => {
    expect(resolveCategory("engine")).toBe("engine");
    expect(resolveCategory("nope")).toBe(DEFAULT_CATEGORY);
    expect(resolveCategory(null)).toBe(DEFAULT_CATEGORY);
  });

  it("round-trips the selected page and survives bad storage", () => {
    const storage = memory();
    writeSelectedCategory(storage, "updates");
    expect(readSelectedCategory(storage)).toBe("updates");
    expect(readSelectedCategory(memory("{broken"))).toBe(DEFAULT_CATEGORY);
    expect(readSelectedCategory(memory())).toBe(DEFAULT_CATEGORY);
  });
});
