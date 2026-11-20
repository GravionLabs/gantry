import { describe, expect, it } from "vitest";
import {
  DEFAULT_VIEW,
  STATUS_ITEMS,
  VIEWS,
  findView,
  requiresEndpoint,
  resolveView,
  statusItems,
} from "./views";

describe("VIEWS", () => {
  it("has unique ids", () => {
    const ids = VIEWS.map((v) => v.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("lists the top group in the intended order", () => {
    expect(VIEWS.filter((v) => v.position === "top").map((v) => v.id)).toEqual([
      "containers",
      "stacks",
      "images",
      "volumes",
      "networks",
      "system",
    ]);
  });

  it("lists the bottom group in the intended order", () => {
    expect(VIEWS.filter((v) => v.position === "bottom").map((v) => v.id)).toEqual([
      "endpoints",
      "settings",
    ]);
  });

  it("puts every view in the sidebar and gives it a label, an icon and a description", () => {
    for (const v of VIEWS) {
      expect(v.placement).toBe("sidebar");
      expect(v.label).not.toBe("");
      expect(v.icon).not.toBe("");
      expect(v.description).not.toBe("");
    }
  });

  it("has the default view", () => {
    expect(findView(DEFAULT_VIEW)).toBeDefined();
  });

  it("falls back to the default view for an unknown id", () => {
    expect(resolveView("nope")).toBe(DEFAULT_VIEW);
    expect(resolveView(null)).toBe(DEFAULT_VIEW);
    expect(resolveView("images")).toBe("images");
  });
});

describe("STATUS_ITEMS", () => {
  it("has unique ids", () => {
    const ids = STATUS_ITEMS.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("puts the endpoint at the start and the versions at the end", () => {
    expect(statusItems("start")).toEqual(["endpoint"]);
    expect(statusItems("end")).toEqual(["engine-version", "app-version"]);
  });
});

describe("requiresEndpoint", () => {
  it("is false for the endpoint manager and the settings only", () => {
    expect(VIEWS.filter((v) => !requiresEndpoint(v.id)).map((v) => v.id)).toEqual([
      "endpoints",
      "settings",
    ]);
  });
});
