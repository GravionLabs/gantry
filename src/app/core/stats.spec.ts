import { Injector } from "@angular/core";
import { describe, expect, it, vi } from "vitest";

import type { Endpoint } from "./bindings";
import {
  STATS_BACKEND,
  StatsFeed,
  type Stats,
  type StatsBackend,
  formatBytes,
  formatMemory,
  formatPercent,
  normalizeSample,
  memoryPercent,
  pushHistory,
  sparklinePoints,
} from "./stats";

const endpoint: Endpoint = {
  name: "local",
  kind: "unix",
  address: "unix:///x.sock",
  tls: null,
  skipTlsVerify: false,
  readOnly: false,
};

const sample = (over: Partial<Stats> = {}): Stats => ({
  cpuPercent: 12.5,
  memoryUsage: 50 * 1024 * 1024,
  memoryLimit: 100 * 1024 * 1024,
  networkRx: 0,
  networkTx: 0,
  blockRead: 0,
  blockWrite: 0,
  ...over,
});

describe("formatting", () => {
  it("formats bytes with binary units", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1023)).toBe("1023 B");
    expect(formatBytes(1536)).toBe("1.50 KiB");
    expect(formatBytes(52428800)).toBe("50.0 MiB");
    expect(formatBytes(3 * 1024 ** 3)).toBe("3.00 GiB");
  });

  it("formats percentages", () => {
    expect(formatPercent(3.14159)).toBe("3.1 %");
    expect(formatPercent(160)).toBe("160 %");
  });

  it("formats memory against the limit", () => {
    expect(formatMemory(sample())).toBe("50.0 MiB / 100 MiB");
    expect(formatMemory(sample({ memoryLimit: 0 }))).toBe("50.0 MiB");
    expect(memoryPercent(sample())).toBe(50);
    expect(memoryPercent(sample({ memoryLimit: 0 }))).toBeNull();
  });
});

describe("normalizeSample", () => {
  it("turns a null (non-finite) value into 0", () => {
    const raw = { ...sample(), cpuPercent: null as unknown as number };
    expect(normalizeSample(raw).cpuPercent).toBe(0);
    expect(normalizeSample(raw).memoryLimit).toBe(100 * 1024 * 1024);
  });
});

describe("history", () => {
  it("keeps the last values", () => {
    expect(pushHistory([1, 2, 3], 4, 3)).toEqual([2, 3, 4]);
    expect(pushHistory([], 1, 3)).toEqual([1]);
  });

  it("scales a sparkline into the box, with the largest value at the top", () => {
    expect(sparklinePoints([], 100, 10)).toBe("");
    expect(sparklinePoints([0, 5, 10], 100, 10)).toBe("0,10 50,5 100,0");
    expect(sparklinePoints([5], 100, 10, 10)).toBe("0,5");
  });
});

describe("StatsFeed", () => {
  function setup() {
    const streams = new Map<
      string,
      { onSample: (s: Stats) => void; onEnd: (e: unknown) => void; stop: () => void }
    >();
    const backend: StatsBackend = (_e, id, onSample, onEnd) => {
      const stop = vi.fn();
      streams.set(id, { onSample, onEnd, stop });
      return stop;
    };
    const injector = Injector.create({
      providers: [{ provide: STATS_BACKEND, useValue: backend }, { provide: StatsFeed }],
    });
    return { feed: injector.get(StatsFeed), streams };
  }

  it("starts one stream per id and stops those that leave", () => {
    const { feed, streams } = setup();
    feed.track(endpoint, new Set(["a", "b"]));
    expect([...streams.keys()]).toEqual(["a", "b"]);
    const stopA = streams.get("a")!.stop;
    feed.track(endpoint, new Set(["b", "c"]));
    expect(stopA).toHaveBeenCalledOnce();
    expect(streams.get("b")!.stop).not.toHaveBeenCalled();
    expect([...streams.keys()]).toEqual(["a", "b", "c"]);
  });

  it("does not start a second stream for a tracked id", () => {
    const { feed, streams } = setup();
    feed.track(endpoint, new Set(["a"]));
    const first = streams.get("a");
    feed.track(endpoint, new Set(["a"]));
    expect(streams.get("a")).toBe(first);
  });

  it("keeps the latest sample and forgets it when the id leaves", () => {
    const { feed, streams } = setup();
    feed.track(endpoint, new Set(["a"]));
    streams.get("a")!.onSample(sample({ cpuPercent: 1 }));
    streams.get("a")!.onSample(sample({ cpuPercent: 2 }));
    expect(feed.samples().get("a")?.cpuPercent).toBe(2);
    feed.track(endpoint, new Set());
    expect(feed.samples().has("a")).toBe(false);
  });

  it("restarts a stream that ended once the id is tracked again", () => {
    const { feed, streams } = setup();
    feed.track(endpoint, new Set(["a"]));
    const first = streams.get("a")!;
    first.onSample(sample());
    first.onEnd(null);
    expect(feed.samples().has("a")).toBe(false);
    feed.track(endpoint, new Set(["a"]));
    expect(streams.get("a")).not.toBe(first);
  });

  it("stops everything when the endpoint changes or on clear", () => {
    const { feed, streams } = setup();
    feed.track(endpoint, new Set(["a"]));
    const stopA = streams.get("a")!.stop;
    feed.track({ ...endpoint, address: "tcp://other" }, new Set(["b"]));
    expect(stopA).toHaveBeenCalledOnce();
    const stopB = streams.get("b")!.stop;
    feed.clear();
    expect(stopB).toHaveBeenCalledOnce();
    expect(feed.samples().size).toBe(0);
  });
});
