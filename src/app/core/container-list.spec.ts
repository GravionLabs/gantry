import { Injector } from "@angular/core";
import { describe, expect, it, vi } from "vitest";

import type { Container, ContainerWatchEvent, Endpoint } from "./bindings";
import { ContainerList, WATCH_BACKEND, type WatchBackend } from "./container-list";
import { GantryError } from "./invoke";

const endpoint: Endpoint = {
  name: "local",
  kind: "unix",
  address: "unix:///x.sock",
  tls: null,
  skipTlsVerify: false,
  readOnly: false,
};

const web: Container = {
  id: "1",
  name: "web",
  image: "nginx",
  state: "running",
  health: null,
  status: "Up",
  ports: [],
  created: 1,
  composeProject: null,
};

function setup() {
  const watches: {
    onEvent: (e: ContainerWatchEvent) => void;
    onEnd: (error: unknown) => void;
    stop: ReturnType<typeof vi.fn>;
  }[] = [];
  const backend: WatchBackend = (_endpoint, onEvent, onEnd) => {
    const stop = vi.fn();
    watches.push({ onEvent, onEnd, stop });
    return stop;
  };
  const injector = Injector.create({
    providers: [{ provide: WATCH_BACKEND, useValue: backend }, { provide: ContainerList }],
  });
  return { list: injector.get(ContainerList), watches };
}

describe("ContainerList", () => {
  it("is loading until the first snapshot, then replaces the list with each snapshot", () => {
    const { list, watches } = setup();
    list.start(endpoint);
    expect(list.phase()).toBe("loading");
    watches[0].onEvent({ type: "snapshot", containers: [web] });
    expect(list.phase()).toBe("ready");
    expect(list.containers()).toEqual([web]);
    watches[0].onEvent({ type: "snapshot", containers: [] });
    expect(list.containers()).toEqual([]);
    expect(list.phase()).toBe("ready");
  });

  it("shows an error when the engine is lost before any data, and recovers on a snapshot", () => {
    const { list, watches } = setup();
    list.start(endpoint);
    watches[0].onEvent({ type: "reconnecting", message: "connection refused" });
    expect(list.phase()).toBe("error");
    expect(list.problem()).toBe("connection refused");
    watches[0].onEvent({ type: "snapshot", containers: [web] });
    expect(list.phase()).toBe("ready");
    expect(list.problem()).toBeNull();
  });

  it("keeps the data while reconnecting after an engine restart", () => {
    const { list, watches } = setup();
    list.start(endpoint);
    watches[0].onEvent({ type: "snapshot", containers: [web] });
    watches[0].onEvent({ type: "reconnecting", message: "stream ended" });
    expect(list.phase()).toBe("ready");
    expect(list.containers()).toEqual([web]);
    expect(list.problem()).toBe("stream ended");
  });

  it("reports a watch that ends by itself and starts over on retry", () => {
    const { list, watches } = setup();
    list.start(endpoint);
    watches[0].onEnd(new GantryError("hostKey", "unknown host key"));
    expect(list.phase()).toBe("error");
    expect(list.problem()).toBe("unknown host key");
    list.retry();
    expect(watches).toHaveLength(2);
    expect(list.phase()).toBe("loading");
    expect(list.problem()).toBeNull();
  });

  it("stops the previous watch when it starts another", () => {
    const { list, watches } = setup();
    list.start(endpoint);
    list.start(endpoint);
    expect(watches[0].stop).toHaveBeenCalledTimes(1);
  });
});
