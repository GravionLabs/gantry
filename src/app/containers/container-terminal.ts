import { ChangeDetectionStrategy, Component, input, signal } from "@angular/core";
import { HxButton, HxMessage } from "@gravionlabs/helix-ui";

import type { Endpoint } from "../core/bindings";
import { SHELL_CHOICES, type ShellId, resolveShell, sessionTitle } from "../core/exec";
import { TerminalSession } from "./terminal-session";

interface Tab {
  readonly id: number;
  readonly title: string;
  readonly command: string[];
  readonly user: string | null;
}

/** Terminals in a running container, one per tab. Closing a tab ends its process. */
@Component({
  selector: "app-container-terminal",
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TerminalSession, HxButton, HxMessage],
  templateUrl: "./container-terminal.html",
  styleUrl: "./container-terminal.css",
})
export class ContainerTerminal {
  readonly endpoint = input.required<Endpoint>();
  readonly containerId = input.required<string>();
  /** A terminal needs a running container. */
  readonly running = input(true);

  protected readonly shells = SHELL_CHOICES;
  protected readonly shell = signal<ShellId>("sh");
  protected readonly custom = signal("");
  protected readonly user = signal("");
  protected readonly problem = signal<string | null>(null);

  protected readonly tabs = signal<Tab[]>([]);
  protected readonly activeId = signal<number | null>(null);
  private nextId = 1;

  protected open(): void {
    try {
      const { command, user } = resolveShell({
        shell: this.shell(),
        custom: this.custom(),
        user: this.user(),
      });
      const tab: Tab = { id: this.nextId++, title: sessionTitle(command, user), command, user };
      this.problem.set(null);
      this.tabs.update((tabs) => [...tabs, tab]);
      this.activeId.set(tab.id);
    } catch (error) {
      this.problem.set(error instanceof Error ? error.message : String(error));
    }
  }

  protected select(id: number): void {
    this.activeId.set(id);
  }

  /** Removing the tab destroys its terminal, which ends the exec process. */
  protected close(id: number): void {
    const tabs = this.tabs();
    const index = tabs.findIndex((t) => t.id === id);
    if (index < 0) return;
    const rest = tabs.filter((t) => t.id !== id);
    this.tabs.set(rest);
    if (this.activeId() === id)
      this.activeId.set(rest[Math.min(index, rest.length - 1)]?.id ?? null);
  }

  protected setShell(value: string): void {
    this.shell.set(value as ShellId);
  }

  protected onCustomKey(event: KeyboardEvent): void {
    if (event.key === "Enter") {
      event.preventDefault();
      this.open();
    }
  }
}
