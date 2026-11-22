import type { ITooltipParams } from "ag-grid-community";
import { describe, expect, it } from "vitest";

import type { Container, Image, Volume } from "../core/bindings";
import {
  containerPortsTooltip,
  imageIdTooltip,
  imageReferenceTooltip,
  volumeMountpointTooltip,
} from "./tooltips";

function params<T>(data: T | undefined): ITooltipParams<T> {
  return { data } as ITooltipParams<T>;
}

describe("grid tooltips", () => {
  it("returns the mountpoint of a volume", () => {
    const volume = { mountpoint: "/var/lib/docker/volumes/x" } as Volume;
    expect(volumeMountpointTooltip(params(volume))).toBe("/var/lib/docker/volumes/x");
  });

  it("returns nothing without row data", () => {
    expect(volumeMountpointTooltip(params<Volume>(undefined))).toBeUndefined();
    expect(imageIdTooltip(params<Image>(undefined))).toBeUndefined();
    expect(imageReferenceTooltip(params<Image>(undefined))).toBeUndefined();
  });

  it("falls back from the image reference to the ID", () => {
    expect(imageReferenceTooltip(params({ reference: "nginx:1", id: "sha256:a" } as Image))).toBe(
      "nginx:1",
    );
    expect(imageReferenceTooltip(params({ id: "sha256:a" } as Image))).toBe("sha256:a");
    expect(imageIdTooltip(params({ id: "sha256:a" } as Image))).toBe("sha256:a");
  });

  it("lists all ports of a container, comma separated", () => {
    const ports = [
      { privatePort: 80, publicPort: 8080, protocol: "tcp" },
      { privatePort: 53, publicPort: null, protocol: "udp" },
    ];
    expect(containerPortsTooltip(params({ ports } as Container))).toBe("8080→80/tcp, 53/udp");
    expect(containerPortsTooltip(params({ ports: [] } as unknown as Container))).toBeUndefined();
  });
});
