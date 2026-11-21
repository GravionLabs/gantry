import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  effect,
  inject,
  input,
  output,
  signal,
  viewChild,
} from "@angular/core";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";

import type { Endpoint } from "../core/bindings";
import { type ExecHandle, exitMessage, openExec } from "../core/exec";
import { toGantryError } from "../core/invoke";

/** One terminal (`docker exec -it`): an xterm.js emulator wired to an exec session. */
@Component({
  selector: "app-terminal-session",
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./terminal-session.html",
  styleUrl: "./terminal-session.css",
})
export class TerminalSession {
  readonly endpoint = input.required<Endpoint>();
  readonly containerId = input.required<string>();
  readonly command = input.required<string[]>();
  readonly user = input<string | null>(null);
  /** Whether the tab is shown; a hidden terminal has no size to fit. */
  readonly active = input(true);
  /** The process ended or the session failed. */
  readonly ended = output<void>();

  private readonly host = viewChild.required<ElementRef<HTMLElement>>("host");
  private readonly terminal = new Terminal({
    cursorBlink: true,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
    fontSize: 13,
    scrollback: 5000,
  });
  private readonly fit = new FitAddon();
  private handle: ExecHandle | null = null;

  protected readonly problem = signal<string | null>(null);
  protected readonly finished = signal<string | null>(null);

  constructor() {
    this.terminal.loadAddon(this.fit);
    let started = false;
    effect(() => {
      const host = this.host().nativeElement;
      if (started) return;
      started = true;
      this.terminal.open(host);
      this.fitNow();
      this.start();
    });
    effect(() => {
      if (this.active()) {
        queueMicrotask(() => {
          this.fitNow();
          this.terminal.focus();
        });
      }
    });
    const observer = new ResizeObserver(() => this.fitNow());
    effect(() => observer.observe(this.host().nativeElement));
    inject(DestroyRef).onDestroy(() => {
      observer.disconnect();
      // Closing the session hangs up the terminal, which ends the process.
      this.handle?.close();
      this.terminal.dispose();
    });
  }

  private fitNow(): void {
    if (!this.active()) return;
    const size = this.fit.proposeDimensions();
    if (size && size.cols > 0 && size.rows > 0) this.fit.fit();
  }

  private start(): void {
    const handle = openExec(
      this.endpoint(),
      this.containerId(),
      {
        command: this.command(),
        user: this.user(),
        cols: this.terminal.cols,
        rows: this.terminal.rows,
      },
      {
        onOutput: (text) => this.terminal.write(text),
        onExit: (code) => this.finished.set(exitMessage(code)),
        onEnd: (error) => {
          if (error) this.problem.set(toGantryError(error).message);
          else this.finished.update((message) => message ?? exitMessage(null));
          this.ended.emit();
        },
      },
    );
    this.handle = handle;
    this.terminal.onData((data) => handle.write(data));
    this.terminal.onResize(({ cols, rows }) => handle.resize(cols, rows));
  }
}
