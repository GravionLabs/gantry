import { beforeEach, describe, expect, it, vi } from "vitest";

const tauri = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: tauri.invoke,
  Channel: class {
    onmessage: ((event: unknown) => void) | undefined;
  },
}));

import type { Endpoint, Image } from "./bindings";
import {
  EMPTY_PULL,
  applyPullEvent,
  imageName,
  layerFraction,
  layerLabel,
  listImages,
  pruneCandidates,
  pruneImages,
  pruneSummary,
  pullImage,
  removeImage,
  removeSummary,
  shortId,
  usageLabel,
} from "./images";

const endpoint: Endpoint = {
  name: "local",
  kind: "unix",
  address: "unix:///x.sock",
  tls: null,
  skipTlsVerify: false,
  readOnly: false,
};

function image(id: string, reference: string | null, containers = 0): Image {
  return {
    id,
    reference,
    repository: reference?.split(":")[0] ?? null,
    tag: reference?.split(":")[1] ?? null,
    size: 1024,
    created: 1,
    containers,
    dangling: reference === null,
  };
}

describe("image commands", () => {
  beforeEach(() => tauri.invoke.mockReset());

  it("lists, removes and prunes through their commands", async () => {
    tauri.invoke.mockResolvedValue([]);
    await listImages(endpoint);
    expect(tauri.invoke).toHaveBeenLastCalledWith("images_list", { endpoint });
    await removeImage(endpoint, "nginx:latest", true);
    expect(tauri.invoke).toHaveBeenLastCalledWith("images_remove", {
      endpoint,
      target: "nginx:latest",
      force: true,
    });
    await pruneImages(endpoint, false);
    expect(tauri.invoke).toHaveBeenLastCalledWith("images_prune", { endpoint, all: false });
  });

  it("pulls through images_pull with a channel and stops it by watch id", async () => {
    tauri.invoke.mockResolvedValue(undefined);
    const run = pullImage(endpoint, "nginx", () => {});
    await run.done;
    const [command, args] = tauri.invoke.mock.calls[0];
    expect(command).toBe("images_pull");
    expect(args).toMatchObject({ endpoint, reference: "nginx" });
    run.stop();
    expect(tauri.invoke).toHaveBeenLastCalledWith("containers_unwatch", { watchId: args.watchId });
  });
});

describe("pull progress", () => {
  it("collects status lines and keeps one entry per layer in order of appearance", () => {
    let progress = applyPullEvent(EMPTY_PULL, { type: "status", message: "Pulling from x" });
    progress = applyPullEvent(progress, {
      type: "layer",
      id: "a",
      status: "Downloading",
      current: 10,
      total: 40,
    });
    progress = applyPullEvent(progress, {
      type: "layer",
      id: "b",
      status: "Waiting",
      current: null,
      total: null,
    });
    progress = applyPullEvent(progress, {
      type: "layer",
      id: "a",
      status: "Download complete",
      current: null,
      total: null,
    });
    expect(progress.messages).toEqual(["Pulling from x"]);
    expect(progress.layers.map((l) => l.id)).toEqual(["a", "b"]);
    expect(progress.layers[0]).toMatchObject({
      status: "Download complete",
      current: 10,
      total: 40,
    });
  });

  it("labels a layer with its transferred size while it downloads", () => {
    const layer = { id: "a", status: "Downloading", current: 1024, total: 2048 };
    expect(layerLabel(layer)).toBe("Downloading 1.00 KiB / 2.00 KiB");
    expect(layerFraction(layer)).toBe(0.5);
    expect(layerLabel({ ...layer, status: "Pull complete" })).toBe("Pull complete");
    const unknown = { id: "a", status: "Waiting", current: null, total: null };
    expect(layerLabel(unknown)).toBe("Waiting");
    expect(layerFraction(unknown)).toBeNull();
  });
});

describe("image labels", () => {
  it("shortens the ID and names dangling images", () => {
    expect(shortId("sha256:0123456789abcdef")).toBe("0123456789ab");
    expect(imageName(image("sha256:0123456789abcdef", null))).toBe("<none> (0123456789ab)");
    expect(imageName(image("sha256:a", "nginx:latest"))).toBe("nginx:latest");
  });

  it("says by how many containers an image is used", () => {
    expect(usageLabel(0)).toBe("unused");
    expect(usageLabel(1)).toBe("in use by 1 container");
    expect(usageLabel(3)).toBe("in use by 3 containers");
  });

  it("summarizes a removal and a prune", () => {
    expect(pruneSummary({ removed: 1, reclaimed: 2048 })).toBe(
      "Removed 1 image, 2.00 KiB reclaimed.",
    );
    expect(pruneSummary({ removed: 0, reclaimed: 0 })).toBe("Removed 0 images, 0 B reclaimed.");
    expect(removeSummary("nginx:latest", { untagged: ["nginx:latest"], deleted: [] })).toBe(
      "Removed nginx:latest.",
    );
    expect(removeSummary("x", { untagged: [], deleted: ["a", "b"] })).toBe(
      "Removed x (2 layers deleted).",
    );
  });
});

describe("pruneCandidates", () => {
  const images = [
    image("sha256:dangling", null),
    image("sha256:used", "nginx:latest", 1),
    image("sha256:unused", "alpine:3", 0),
    image("sha256:unused", "alpine:latest", 0),
    image("sha256:both", "busybox:1", 0),
    image("sha256:both", null),
  ];

  it("names the dangling images that have no tag at all", () => {
    expect(pruneCandidates(images, false).map((i) => i.id)).toEqual(["sha256:dangling"]);
  });

  it("names each unused image once, tagged or not, never an image in use", () => {
    expect(pruneCandidates(images, true).map((i) => i.id)).toEqual([
      "sha256:dangling",
      "sha256:unused",
      "sha256:both",
    ]);
  });
});
