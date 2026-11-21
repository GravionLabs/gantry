import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), Channel: class {} }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("@tauri-apps/plugin-store", () => ({ load: vi.fn() }));

import { defaultName } from "./stack-deploy";

describe("defaultName", () => {
  it("proposes the normalized name of the directory", () => {
    expect(defaultName("/srv/My Shop/compose.yml")).toBe("myshop");
    expect(defaultName("C:\\apps\\_Blog-2\\compose.yml")).toBe("blog-2");
    expect(defaultName("compose.yml")).toBe("");
  });
});
