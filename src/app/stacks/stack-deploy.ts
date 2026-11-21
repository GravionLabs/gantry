import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
} from "@angular/core";
import { HxButton, HxInput, HxMessage } from "@gravionlabs/helix-ui";

import type { Endpoint } from "../core/bindings";
import {
  RECENT_DEPLOYS,
  deployProject,
  pickFile,
  previewComposeFile,
  type RecentDeploy,
} from "../core/deploy";
import { toGantryError } from "../core/invoke";
import { actionCommand, finishedMessage, runCompose } from "../core/stacks";

const UP = { type: "up" } as const;

/**
 * Deploys a new stack: pick a Compose file (and an env file), look at the file read-only, confirm
 * the project name and run `docker compose up -d` with streamed output.
 */
@Component({
  selector: "app-stack-deploy",
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HxButton, HxInput, HxMessage],
  templateUrl: "./stack-deploy.html",
  styleUrl: "./stacks-view.css",
})
export class StackDeploy {
  readonly endpoint = input.required<Endpoint>();
  /** Emitted when the form is left; `deployed` says whether a deployment succeeded. */
  readonly closed = output<{ deployed: boolean }>();

  private readonly recentStore = inject(RECENT_DEPLOYS);

  protected readonly composeFile = signal<string | null>(null);
  protected readonly envFile = signal<string | null>(null);
  protected readonly name = signal("");
  protected readonly preview = signal<string | null>(null);
  protected readonly problem = signal<string | null>(null);
  protected readonly recent = signal<readonly RecentDeploy[]>([]);
  protected readonly running = signal(false);
  protected readonly output = signal<readonly string[]>([]);
  protected readonly outcome = signal<string | null>(null);
  protected readonly failed = signal(false);
  protected readonly canDeploy = computed(() => this.composeFile() !== null && !this.running());
  private stopRun: (() => void) | null = null;
  private previews = 0;

  constructor() {
    effect(() => {
      const address = this.endpoint().address;
      untracked(() => {
        void this.recentStore
          .list(address)
          .then((list) => this.recent.set(list))
          .catch(() => this.recent.set([]));
      });
    });
  }

  protected async pickCompose(): Promise<void> {
    const path = await this.pick("Select a Compose file", ["yml", "yaml"]);
    if (path) await this.setComposeFile(path);
  }

  protected async pickEnv(): Promise<void> {
    const path = await this.pick("Select an env file");
    if (path) this.envFile.set(path);
  }

  protected clearEnv(): void {
    this.envFile.set(null);
  }

  private async pick(title: string, extensions?: string[]): Promise<string | null> {
    try {
      return await pickFile(title, extensions);
    } catch (error) {
      this.problem.set(toGantryError(error).message);
      return null;
    }
  }

  protected useRecent(entry: RecentDeploy): void {
    this.envFile.set(entry.envFile);
    void this.setComposeFile(entry.composeFile, entry.name);
  }

  /** Selects the file, reads it for the preview and proposes the project name. */
  private async setComposeFile(path: string, name?: string): Promise<void> {
    const request = ++this.previews;
    this.composeFile.set(path);
    this.preview.set(null);
    this.problem.set(null);
    this.name.set(name ?? defaultName(path));
    try {
      const text = await previewComposeFile(path);
      if (request === this.previews) this.preview.set(text);
    } catch (error) {
      if (request === this.previews) this.problem.set(toGantryError(error).message);
    }
  }

  protected setName(event: Event): void {
    this.name.set((event.target as HTMLInputElement).value);
  }

  protected async deploy(): Promise<void> {
    const file = this.composeFile();
    if (!file || this.running()) return;
    this.problem.set(null);
    this.outcome.set(null);
    this.failed.set(false);
    this.output.set([]);
    this.running.set(true);
    let project;
    try {
      project = await deployProject(file, this.envFile(), this.name());
    } catch (error) {
      this.problem.set(toGantryError(error).message);
      this.running.set(false);
      return;
    }
    let success = false;
    const run = runCompose(this.endpoint(), project, UP, (event) => {
      if (event.type === "line") {
        this.output.update((lines) => [...lines, event.text]);
      } else {
        success = event.success;
        this.outcome.set(finishedMessage(UP, event));
        this.failed.set(!event.success);
      }
    });
    this.stopRun = run.stop;
    try {
      await run.done;
    } catch (error) {
      this.outcome.set(`${actionCommand(UP)}: ${toGantryError(error).message}`);
      this.failed.set(true);
    }
    this.stopRun = null;
    this.running.set(false);
    if (success) {
      const entry = { composeFile: file, envFile: this.envFile(), name: project.name };
      await this.recentStore
        .remember(this.endpoint().address, entry)
        .then(() => this.recentStore.list(this.endpoint().address))
        .then((list) => this.recent.set(list))
        .catch(() => {});
    }
  }

  protected stop(): void {
    this.stopRun?.();
  }

  protected close(): void {
    this.stopRun?.();
    this.closed.emit({ deployed: this.outcome() !== null && !this.failed() });
  }
}

/** The project name Compose derives from the directory of the file (a proposal the user can edit). */
export function defaultName(path: string): string {
  const parts = path.split(/[\\/]/);
  const dir = parts.length >= 2 ? parts[parts.length - 2] : "";
  return dir
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "")
    .replace(/^[-_]+/, "");
}
