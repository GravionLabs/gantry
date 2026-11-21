import { Injectable, computed, signal } from "@angular/core";
import { getIdentifier, getVersion } from "@tauri-apps/api/app";
import { relaunch } from "@tauri-apps/plugin-process";
import type { Update } from "@tauri-apps/plugin-updater";
import { check } from "@tauri-apps/plugin-updater";

import type { UpdateStep } from "./update-logic";
import {
  downloadPercent,
  failureMessage,
  isOfferable,
  isPrerelease,
  isRcIdentifier,
} from "./update-logic";

export type UpdatePhase = "idle" | "checking" | "available" | "installing" | "error";

/** Checks for a new version only on request, and installs it after the user confirms. */
@Injectable({ providedIn: "root" })
export class UpdateService {
  /** The running version; empty until known. */
  readonly version = signal("");
  readonly phase = signal<UpdatePhase>("idle");
  /** The offered update; kept after a failed install so it can be retried. */
  readonly update = signal<Update | null>(null);
  /** True after a check that found nothing. */
  readonly upToDate = signal(false);
  readonly error = signal("");
  readonly failedStep = signal<UpdateStep | null>(null);
  private readonly received = signal(0);
  private readonly total = signal<number | null>(null);
  readonly percent = computed(() => downloadPercent(this.received(), this.total()));
  readonly busy = computed(() => this.phase() === "checking" || this.phase() === "installing");
  private readonly identifier = signal("");
  /** An RC build (identifier `….rc`) or a pre-release version is not updated. */
  readonly enabled = computed(
    () => !isPrerelease(this.version()) && !isRcIdentifier(this.identifier()),
  );

  /** Reads the running version (no network). */
  async init(): Promise<void> {
    try {
      this.version.set(await getVersion());
      this.identifier.set(await getIdentifier());
    } catch {
      // not running inside Tauri
    }
  }

  /** "Check for Updates…": asks the update endpoint once. */
  async check(): Promise<void> {
    if (this.busy()) return;
    this.error.set("");
    this.failedStep.set(null);
    this.upToDate.set(false);
    this.phase.set("checking");
    try {
      if (!this.version() || !this.identifier()) await this.init();
      if (!this.enabled()) {
        this.phase.set("idle");
        return;
      }
      const found = await check();
      if (found && isOfferable(this.version(), found.version)) {
        this.update.set(found);
        this.phase.set("available");
      } else {
        this.update.set(null);
        this.upToDate.set(true);
        this.phase.set("idle");
      }
    } catch (err) {
      this.fail("check", err);
    }
  }

  /** Downloads and verifies the package, installs it and restarts. Retries without a new check. */
  async install(): Promise<void> {
    const update = this.update();
    if (!update || this.busy()) return;
    this.error.set("");
    this.failedStep.set(null);
    this.received.set(0);
    this.total.set(null);
    this.phase.set("installing");
    try {
      await update.downloadAndInstall((event) => {
        if (event.event === "Started") this.total.set(event.data.contentLength ?? null);
        else if (event.event === "Progress")
          this.received.update((n) => n + event.data.chunkLength);
      });
      await relaunch();
    } catch (err) {
      this.fail("update", err);
    }
  }

  private fail(step: UpdateStep, err: unknown): void {
    this.failedStep.set(step);
    this.error.set(failureMessage(step, err));
    this.phase.set("error");
  }
}
