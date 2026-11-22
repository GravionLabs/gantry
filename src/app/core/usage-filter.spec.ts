import { describe, expect, it } from "vitest";

import { countLabel, matchesUsage } from "./usage-filter";

describe("matchesUsage", () => {
  it("matches by the number of containers", () => {
    expect(matchesUsage("all", 0)).toBe(true);
    expect(matchesUsage("all", 3)).toBe(true);
    expect(matchesUsage("used", 1)).toBe(true);
    expect(matchesUsage("used", 0)).toBe(false);
    expect(matchesUsage("unused", 0)).toBe(true);
    expect(matchesUsage("unused", 1)).toBe(false);
  });
});

describe("countLabel", () => {
  it("shows the total for All and shown of total otherwise", () => {
    expect(countLabel(5, 5, "all")).toBe("5");
    expect(countLabel(2, 5, "used")).toBe("2 of 5");
    expect(countLabel(0, 5, "unused")).toBe("0 of 5");
  });
});
