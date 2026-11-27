import { ScrollingModule, CdkVirtualScrollViewport } from "@angular/cdk/scrolling";
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
  viewChild,
} from "@angular/core";
import { HxButton, HxInput, HxMessage, HxSelect, HxSwitch } from "@gravionlabs/helix-ui";

import type { Endpoint } from "../core/bindings";
import { streamContainerLogs } from "../core/containers";
import { toGantryError } from "../core/invoke";
import {
  type LogEntry,
  SINCE_CHOICES,
  TAIL_CHOICES,
  appendCapped,
  buildLogOptions,
  isAtBottom,
  logsText,
  matchingLines,
  renderLine,
  stepMatch,
  toEntry,
} from "../core/logs";

/** Height of one line in pixels; the virtual scroll needs a fixed size. */
export const LINE_HEIGHT = 20;

/** `docker logs -f` of one container: follow mode, options, search, ANSI colors and download. */
@Component({
  selector: "app-container-logs",
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ScrollingModule, HxButton, HxInput, HxMessage, HxSelect, HxSwitch],
  templateUrl: "./container-logs.html",
  styleUrl: "./container-logs.css",
})
export class ContainerLogs {
  readonly endpoint = input.required<Endpoint>();
  readonly containerId = input.required<string>();
  /** Used in the name of the downloaded file. */
  readonly containerName = input<string>("container");

  private readonly destroyRef = inject(DestroyRef);
  private readonly viewport = viewChild(CdkVirtualScrollViewport);

  protected readonly lineHeight = LINE_HEIGHT;
  /** `hx-select` reads null as "nothing selected", so the choices carry strings. */
  protected readonly tailOptions = TAIL_CHOICES.map((c) => ({
    label: c.label,
    value: String(c.value ?? "all"),
  }));
  protected readonly sinceOptions = SINCE_CHOICES.map((c) => ({
    label: c.label,
    value: String(c.seconds ?? ""),
  }));

  protected readonly follow = signal(true);
  protected readonly tail = signal<number | null>(1000);
  protected readonly since = signal<number | null>(null);
  protected readonly timestamps = signal(false);
  protected readonly tailValue = computed(() => String(this.tail() ?? "all"));
  protected readonly sinceValue = computed(() => String(this.since() ?? ""));
  protected readonly query = signal("");

  protected readonly lines = signal<LogEntry[]>([]);
  protected readonly phase = signal<"streaming" | "ended" | "error">("streaming");
  protected readonly problem = signal<string | null>(null);
  /** Whether the view sticks to the newest line; scrolling up pauses it. */
  protected readonly autoScroll = signal(true);

  protected readonly matches = computed(() => matchingLines(this.lines(), this.query().trim()));
  protected readonly currentMatch = signal(-1);
  private readonly currentLine = computed(() => this.matches()[this.currentMatch()] ?? -1);

  private stop: (() => void) | null = null;

  constructor() {
    effect(() => {
      const endpoint = this.endpoint();
      const id = this.containerId();
      const options = buildLogOptions(this.follow(), this.tail(), this.since(), this.timestamps());
      untracked(() => this.start(endpoint, id, options));
    });
    effect(() => {
      // A new search starts at its first hit; new lines keep the selected one.
      this.query();
      untracked(() => this.currentMatch.set(-1));
    });
    this.destroyRef.onDestroy(() => this.stop?.());
  }

  private start(endpoint: Endpoint, id: string, options: ReturnType<typeof buildLogOptions>) {
    this.stop?.();
    this.lines.set([]);
    this.phase.set("streaming");
    this.problem.set(null);
    this.autoScroll.set(true);
    this.stop = streamContainerLogs(
      endpoint,
      id,
      options,
      (batch) => {
        this.lines.update((lines) => appendCapped(lines, batch.map(toEntry)));
        if (this.autoScroll()) queueMicrotask(() => this.scrollToEnd());
      },
      (error) => {
        if (error) {
          this.problem.set(toGantryError(error).message);
          this.phase.set("error");
        } else {
          this.phase.set("ended");
        }
      },
    );
  }

  protected scrollToEnd(): void {
    const count = this.lines().length;
    if (count) this.viewport()?.scrollToIndex(count - 1);
  }

  /** Scrolling up pauses the auto-scroll, reaching the end again resumes it. */
  protected onScroll(): void {
    const viewport = this.viewport();
    if (!viewport) return;
    this.autoScroll.set(isAtBottom(viewport.measureScrollOffset("bottom")));
  }

  protected resume(): void {
    this.autoScroll.set(true);
    this.scrollToEnd();
  }

  protected parts(entry: LogEntry, index: number) {
    return renderLine(entry, this.query().trim(), index === this.currentLine());
  }

  protected setQuery(value: string): void {
    this.query.set(value);
  }

  protected step(direction: 1 | -1): void {
    const count = this.matches().length;
    const next = stepMatch(this.currentMatch(), count, direction);
    this.currentMatch.set(next);
    if (next >= 0) {
      this.autoScroll.set(false);
      this.viewport()?.scrollToIndex(Math.max(0, this.matches()[next] - 3));
    }
  }

  protected onSearchKey(event: KeyboardEvent): void {
    if (event.key === "Enter") {
      event.preventDefault();
      this.step(event.shiftKey ? -1 : 1);
    }
  }

  protected setTail(value: string): void {
    this.tail.set(value === "all" ? null : Number(value));
  }

  protected setSince(value: string): void {
    this.since.set(value === "" ? null : Number(value));
  }

  protected download(): void {
    const blob = new Blob([logsText(this.lines())], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${this.containerName()}.log`;
    link.click();
    URL.revokeObjectURL(url);
  }

  protected trackLine(index: number): number {
    return index;
  }
}
