import { describe, expect, it } from "vitest";
import { describeEngine } from "./engine";

describe("describeEngine", () => {
  it("names version, API and platform", () => {
    expect(
      describeEngine({ version: "28.1.1", apiVersion: "1.49", os: "linux", arch: "amd64" }),
    ).toBe("Docker 28.1.1 (API 1.49, linux/amd64)");
  });

  it("marks missing values as unknown", () => {
    expect(describeEngine({ version: null, apiVersion: null, os: null, arch: null })).toBe(
      "Docker unknown (API unknown)",
    );
  });
});
