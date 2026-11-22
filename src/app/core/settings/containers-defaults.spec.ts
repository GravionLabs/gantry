import { describe, expect, it } from "vitest";

import { DEFAULT_SETTINGS, sanitizeSettings } from "./settings-core";

describe("containers view defaults", () => {
  it("are off by default", () => {
    expect(DEFAULT_SETTINGS.containers).toEqual({ showStats: false, groupByStack: false });
  });

  it("keep valid stored values", () => {
    expect(
      sanitizeSettings({ containers: { showStats: true, groupByStack: true } }).containers,
    ).toEqual({ showStats: true, groupByStack: true });
  });

  it("fall back to the default for invalid values", () => {
    expect(
      sanitizeSettings({ containers: { showStats: "yes", groupByStack: 1 } }).containers,
    ).toEqual(DEFAULT_SETTINGS.containers);
    expect(sanitizeSettings({ containers: [] }).containers).toEqual(DEFAULT_SETTINGS.containers);
  });
});
