import { Injector } from "@angular/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DetectedEngine, Endpoint, EngineInfo } from "./bindings";
import { ENDPOINT_PERSISTENCE, type EndpointPrefs } from "./endpoint-persistence";
import { ENDPOINT_BACKEND, EndpointStore, kindLabel, type EndpointBackend } from "./endpoint-store";
import { GantryError } from "./invoke";

vi.mock("@tauri-apps/plugin-store", () => ({ load: vi.fn() }));

const info: EngineInfo = { version: "28.1.1", apiVersion: "1.49", os: "linux", arch: "amd64" };

function endpoint(name: string, address = `tcp://${name}:2375`): Endpoint {
  return {
    name,
    kind: address.startsWith("unix") ? "unix" : "tcp",
    address,
    tls: null,
    skipTlsVerify: false,
    readOnly: false,
  };
}

function detected(name: string, reachable: boolean): DetectedEngine {
  return {
    source: name,
    endpoint: endpoint(name, `unix:///run/${name}.sock`),
    status: reachable ? { state: "reachable", info } : { state: "notRunning" },
  };
}

interface Setup {
  store: EndpointStore;
  saved: EndpointPrefs[];
  backend: EndpointBackend;
  down: Set<string>;
}

function setup(
  options: { detected?: DetectedEngine[]; contexts?: Endpoint[]; prefs?: EndpointPrefs } = {},
): Setup {
  const down = new Set<string>();
  const saved: EndpointPrefs[] = [];
  const backend: EndpointBackend = {
    detect: async () => options.detected ?? [],
    contexts: async () => ({ contexts: options.contexts ?? [], current: "default", warnings: [] }),
    ping: async (e) => {
      if (down.has(e.name)) throw new GantryError("unreachable", `${e.name} is down`);
      return info;
    },
    build: async (name, address, tls) => {
      if (!address.startsWith("tcp://") && !address.startsWith("ssh://")) {
        throw new GantryError("invalidInput", "bad address");
      }
      return { ...endpoint(name.trim(), address), tls };
    },
  };
  const injector = Injector.create({
    providers: [
      { provide: ENDPOINT_BACKEND, useValue: backend },
      {
        provide: ENDPOINT_PERSISTENCE,
        useValue: {
          load: async () => options.prefs ?? { manual: [], active: null },
          save: async (prefs: EndpointPrefs) => void saved.push(prefs),
        },
      },
      { provide: EndpointStore, useClass: EndpointStore, deps: [] },
    ],
  });
  return { store: injector.get(EndpointStore), saved, backend, down };
}

describe("EndpointStore", () => {
  let s: Setup;

  describe("listing", () => {
    it("lists detected, context and manual endpoints with their status", async () => {
      s = setup({
        detected: [detected("Docker", true), detected("Podman", false)],
        contexts: [endpoint("remote")],
        prefs: { manual: [endpoint("build")], active: null },
      });
      s.down.add("build");
      await s.store.init();
      expect(s.store.entries().map((e) => [e.id, e.origin, e.status.state])).toEqual([
        ["detected:Docker", "detected", "reachable"],
        ["detected:Podman", "detected", "unreachable"],
        ["context:remote", "context", "reachable"],
        ["manual:build", "manual", "unreachable"],
      ]);
      expect(s.store.entries()[3].status.error).toBe("build is down");
      expect(s.store.entries()[0].status.info?.version).toBe("28.1.1");
    });

    it("marks a refused engine as denied", async () => {
      s = setup({
        detected: [
          {
            source: "Docker",
            endpoint: endpoint("Docker", "unix:///var/run/docker.sock"),
            status: { state: "permissionDenied", hint: "join the docker group" },
          },
        ],
      });
      await s.store.init();
      expect(s.store.entries()[0].status).toMatchObject({
        state: "denied",
        error: "join the docker group",
      });
    });
  });

  describe("selection and fallback", () => {
    it("falls back to the first reachable endpoint when nothing was saved", async () => {
      s = setup({ detected: [detected("Podman", false), detected("Docker", true)] });
      await s.store.init();
      expect(s.store.activeId()).toBe("detected:Docker");
      expect(s.store.connection()).toBe("connected");
      expect(s.store.engineVersion()).toBe("28.1.1");
      expect(s.saved.at(-1)?.active).toBe("detected:Docker");
    });

    it("falls back when the saved endpoint no longer exists", async () => {
      s = setup({
        detected: [detected("Docker", true)],
        prefs: { manual: [], active: "manual:gone" },
      });
      await s.store.init();
      expect(s.store.activeId()).toBe("detected:Docker");
    });

    it("keeps a saved endpoint that does not answer, as an error state", async () => {
      s = setup({
        detected: [detected("Docker", true)],
        prefs: { manual: [endpoint("build")], active: "manual:build" },
      });
      s.down.add("build");
      await s.store.init();
      expect(s.store.activeId()).toBe("manual:build");
      expect(s.store.connection()).toBe("unreachable");
      expect(s.store.activeError()).toBe("build is down");
    });

    it("has no active endpoint when none is reachable", async () => {
      s = setup({ detected: [detected("Docker", false)] });
      await s.store.init();
      expect(s.store.activeId()).toBeNull();
      expect(s.store.connection()).toBe("unreachable");
      expect(s.store.activeName()).toBe("No endpoint");
    });

    it("switches, persists and bumps the generation", async () => {
      s = setup({ detected: [detected("Docker", true), detected("Podman", true)] });
      await s.store.init();
      const before = s.store.generation();
      s.store.select("detected:Podman");
      expect(s.store.activeId()).toBe("detected:Podman");
      expect(s.store.generation()).toBe(before + 1);
      expect(s.saved.at(-1)?.active).toBe("detected:Podman");
    });

    it("ignores an unknown id", async () => {
      s = setup({ detected: [detected("Docker", true)] });
      await s.store.init();
      const before = s.store.generation();
      s.store.select("manual:nope");
      expect(s.store.activeId()).toBe("detected:Docker");
      expect(s.store.generation()).toBe(before);
    });
  });

  describe("persistence", () => {
    it("restores the saved selection and the manual endpoints", async () => {
      s = setup({
        detected: [detected("Docker", true)],
        prefs: { manual: [endpoint("build")], active: "manual:build" },
      });
      await s.store.init();
      expect(s.store.activeId()).toBe("manual:build");
      expect(s.store.connection()).toBe("connected");
      expect(s.store.activeName()).toBe("build");
    });

    it("starts empty when the preferences cannot be read", async () => {
      s = setup({ detected: [detected("Docker", true)] });
      const failing = Injector.create({
        providers: [
          { provide: ENDPOINT_BACKEND, useValue: s.backend },
          {
            provide: ENDPOINT_PERSISTENCE,
            useValue: { load: () => Promise.reject(new Error("corrupt")), save: async () => {} },
          },
          { provide: EndpointStore, useClass: EndpointStore, deps: [] },
        ],
      }).get(EndpointStore);
      await failing.init();
      expect(failing.activeId()).toBe("detected:Docker");
    });
  });

  describe("manual endpoints", () => {
    beforeEach(async () => {
      s = setup({ detected: [detected("Docker", true)] });
      await s.store.init();
    });

    it("adds and persists an endpoint", async () => {
      await s.store.add(" build ", "tcp://build:2375", null);
      expect(s.store.entries().at(-1)).toMatchObject({ id: "manual:build", origin: "manual" });
      expect(s.store.entries().at(-1)?.status.state).toBe("reachable");
      expect(s.saved.at(-1)?.manual.map((e) => e.name)).toEqual(["build"]);
    });

    it("rejects invalid input and duplicate names", async () => {
      await expect(s.store.add("x", "ftp://h", null)).rejects.toMatchObject({
        kind: "invalidInput",
      });
      await s.store.add("build", "tcp://build:2375", null);
      await expect(s.store.add("build", "tcp://other:2375", null)).rejects.toMatchObject({
        kind: "conflict",
      });
    });

    it("edits an endpoint and follows a rename of the active one", async () => {
      await s.store.add("build", "tcp://build:2375", null);
      s.store.select("manual:build");
      await s.store.update("manual:build", "ci", "ssh://deploy@ci", null);
      expect(s.store.activeId()).toBe("manual:ci");
      expect(s.store.entries().some((e) => e.id === "manual:build")).toBe(false);
      expect(s.saved.at(-1)).toMatchObject({ active: "manual:ci" });
    });

    it("refuses to edit an imported endpoint", async () => {
      await expect(s.store.update("detected:Docker", "x", "tcp://h:1", null)).rejects.toMatchObject(
        { kind: "notFound" },
      );
    });

    it("removes an endpoint; removing the active one falls back", async () => {
      await s.store.add("build", "tcp://build:2375", null);
      s.store.select("manual:build");
      await s.store.remove("manual:build");
      expect(s.store.entries().map((e) => e.id)).toEqual(["detected:Docker"]);
      expect(s.store.activeId()).toBe("detected:Docker");
      expect(s.saved.at(-1)).toEqual({ manual: [], active: "detected:Docker" });
    });

    it("never removes a detected endpoint", async () => {
      await s.store.remove("detected:Docker");
      expect(s.store.entries()).toHaveLength(1);
    });
  });

  describe("retry", () => {
    it("probes the active endpoint again and reloads the view", async () => {
      s = setup({ prefs: { manual: [endpoint("build")], active: "manual:build" } });
      s.down.add("build");
      await s.store.init();
      expect(s.store.connection()).toBe("unreachable");
      s.down.delete("build");
      const before = s.store.generation();
      await s.store.retry();
      expect(s.store.connection()).toBe("connected");
      expect(s.store.generation()).toBe(before + 1);
    });
  });

  it("tests the form values without adding the endpoint", async () => {
    s = setup();
    await s.store.init();
    await expect(s.store.testDraft("probe", "tcp://probe:2375", null)).resolves.toEqual(info);
    s.down.add("dead");
    await expect(s.store.testDraft("dead", "tcp://dead:2375", null)).rejects.toMatchObject({
      kind: "unreachable",
    });
    await expect(s.store.testDraft("x", "nope", null)).rejects.toMatchObject({
      kind: "invalidInput",
    });
    expect(s.store.entries()).toEqual([]);
  });

  it("rechecks one endpoint", async () => {
    s = setup({ prefs: { manual: [endpoint("build")], active: null } });
    s.down.add("build");
    await s.store.init();
    s.down.delete("build");
    await s.store.recheck("manual:build");
    expect(s.store.entries()[0].status.state).toBe("reachable");
  });
});

describe("kindLabel", () => {
  it("names the kind and TLS", () => {
    expect(kindLabel(endpoint("a", "unix:///x"))).toBe("Unix socket");
    expect(kindLabel(endpoint("a"))).toBe("TCP");
    expect(kindLabel({ ...endpoint("a"), tls: { ca: "ca", cert: "c", key: "k" } })).toBe("TCP+TLS");
    expect(kindLabel({ ...endpoint("a"), kind: "ssh" })).toBe("SSH");
    expect(kindLabel({ ...endpoint("a"), kind: "namedPipe" })).toBe("Named pipe");
  });
});
