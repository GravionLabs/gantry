import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  afterRenderEffect,
  computed,
  inject,
  input,
  signal,
} from "@angular/core";
import { FormField, form, submit, validate } from "@angular/forms/signals";
import { HxButton, HxField, HxInput, HxMessage, HxSelect, HxTabBar } from "@gravionlabs/helix-ui";

import type { Endpoint } from "../core/bindings";
import {
  SHELL_CHOICES,
  type ShellId,
  resolveShell,
  sessionTitle,
  splitCommand,
} from "../core/exec";
import { TerminalSession } from "./terminal-session";

interface Tab {
  readonly id: number;
  readonly title: string;
  readonly command: string[];
  readonly user: string | null;
}

/** What is wrong with a custom command line, saying what to enter. */
function commandError(line: string): { kind: string; message: string } | undefined {
  try {
    if (splitCommand(line).length > 0) return undefined;
    return { kind: "required", message: "Enter a command to run" };
  } catch (error) {
    const reason = (error as Error).message;
    return { kind: "command", message: `Enter a complete command: ${reason}` };
  }
}

/** Terminals in a running container, one per tab. Closing a tab ends its process. */
@Component({
  selector: "app-container-terminal",
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TerminalSession, FormField, HxButton, HxField, HxInput, HxMessage, HxSelect, HxTabBar],
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
  private readonly model = signal({ custom: "", user: "" });
  /** The fields of a new terminal; a field shows its error once it was left or the form was submitted. */
  protected readonly terminalForm = form(this.model, (path) => {
    // The command counts only while its field is shown.
    validate(path.custom, ({ value }) =>
      this.shell() === "custom" ? commandError(value()) : undefined,
    );
  });

  protected readonly tabs = signal<Tab[]>([]);
  protected readonly activeId = signal<number | null>(null);
  protected readonly barTabs = computed(() =>
    this.tabs().map((t) => ({ id: String(t.id), label: t.title })),
  );
  private nextId = 1;

  constructor() {
    const host: HTMLElement = inject(ElementRef).nativeElement;
    // `hx-tab-bar` names its close buttons "Close <label>" and has no input for that text, but
    // closing a terminal has to say that it ends the process.
    afterRenderEffect(() => {
      const tabs = this.tabs();
      host.querySelectorAll(".hx-tab-bar-close").forEach((button, index) => {
        const title = tabs[index]?.title;
        if (title) button.setAttribute("aria-label", `Close ${title} and end its process`);
      });
    });
  }

  /** Opens a terminal, or moves the focus to the field in error. */
  protected async open(): Promise<void> {
    // An invalid form marks its fields, which then show their errors, and opens nothing.
    await submit(this.terminalForm, async () => {
      if (!this.running()) return;
      const { command, user } = resolveShell({ shell: this.shell(), ...this.model() });
      const tab: Tab = { id: this.nextId++, title: sessionTitle(command, user), command, user };
      this.tabs.update((tabs) => [...tabs, tab]);
      this.activeId.set(tab.id);
    });
    this.terminalForm().errorSummary()[0]?.fieldTree().focusBoundControl();
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
    // A command field that is shown again has not been left yet.
    this.terminalForm.custom().reset();
  }
}
