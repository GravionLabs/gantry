import { ChangeDetectionStrategy, Component, signal } from "@angular/core";
import type { ICellRendererAngularComp } from "ag-grid-angular";
import type { ICellRendererParams } from "ag-grid-community";
import { HxButton, HxTooltip } from "@gravionlabs/helix-ui";

import type { Container, PortMapping } from "../core/bindings";
import { portLabel, stateLabel } from "../core/containers";
import type { StackRow } from "../core/stacks";
import { type GroupRow, NO_STACK } from "./stack-groups";

/** What the cells of a container grid call back into the view; handed to the grid as `[context]`. */
export interface ContainerGridContext {
  /** Opens the details of a container. */
  details(container: Container): void;
  /** Opens `http://localhost:<port>`. */
  openPort(port: number): void;
  /** Whether the engine runs on this machine, so that a published port can be opened. */
  local(): boolean;
}

/** The state dot of a container, shared by the cells of both grids. */
export const DOT_STYLES = `
  .dot {
    display: inline-block;
    flex: none;
    width: 0.5rem;
    height: 0.5rem;
    border-radius: 50%;
    background: var(--h-text-muted-color);
  }
  .dot[data-state="running"] { background: var(--gantry-container); }
  .dot[data-state="restarting"],
  .dot[data-state="paused"],
  .dot[data-health="starting"] { background: var(--h-amber-500); }
  .dot[data-health="unhealthy"],
  .dot[data-state="dead"] { background: var(--h-red-500); }
`;

/** The name of a container as a link to its details. */
@Component({
  selector: "app-container-name-cell",
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `@if (container(); as c) {
    <a
      [href]="'/containers/' + c.id"
      [attr.aria-label]="'Details of ' + c.name"
      (click)="open($event, c)"
      >{{ c.name }}</a
    >
  }`,
  styles: `
    a {
      color: inherit;
      font-weight: 500;
      text-decoration: none;
    }
    a:hover,
    a:focus-visible {
      color: var(--h-primary-color);
      text-decoration: underline;
    }
  `,
})
export class ContainerNameCell implements ICellRendererAngularComp {
  protected readonly container = signal<Container | null>(null);
  private context: ContainerGridContext | null = null;

  agInit(params: ICellRendererParams<Container, unknown, ContainerGridContext>): void {
    this.refresh(params);
  }

  refresh(params: ICellRendererParams<Container, unknown, ContainerGridContext>): boolean {
    this.container.set(params.data ?? null);
    this.context = params.context;
    return true;
  }

  protected open(event: Event, container: Container): void {
    event.preventDefault();
    this.context?.details(container);
  }
}

/** The state of a container with a coloured dot; the engine's status text is the tooltip. */
@Component({
  selector: "app-container-state-cell",
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `@if (container(); as c) {
    <span class="state" [attr.title]="c.status">
      <span class="dot" [attr.data-state]="c.state" [attr.data-health]="c.health"></span>
      {{ label(c) }}
    </span>
  }`,
  styles: `
    .state {
      display: inline-flex;
      align-items: center;
      gap: 0.4rem;
    }
    ${DOT_STYLES}
  `,
})
export class ContainerStateCell implements ICellRendererAngularComp {
  protected readonly container = signal<Container | null>(null);
  protected readonly label = stateLabel;

  agInit(params: ICellRendererParams<Container>): void {
    this.refresh(params);
  }

  refresh(params: ICellRendererParams<Container>): boolean {
    this.container.set(params.data ?? null);
    return true;
  }
}

/** The ports of a container, each its own item; published TCP ports of a local engine open in the browser. */
@Component({
  selector: "app-container-ports-cell",
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<span class="ports">
    @for (p of ports(); track $index) {
      @if (local() && p.protocol === "tcp" && p.publicPort !== null) {
        <a
          class="port"
          [href]="'http://localhost:' + p.publicPort"
          [attr.aria-label]="'Open http://localhost:' + p.publicPort"
          (click)="open($event, p.publicPort)"
          >{{ label(p) }}</a
        >
      } @else {
        <span class="port">{{ label(p) }}</span>
      }
      @if (!$last) {
        <span class="sep">, </span>
      }
    }
  </span>`,
  styles: `
    :host {
      display: block;
      min-width: 0;
    }
    .ports {
      display: block;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-family: var(--helix-font-mono, monospace);
      font-size: var(--h-font-size-sm);
    }
    .port {
      color: inherit;
      text-decoration: none;
    }
    a.port {
      color: var(--h-primary-color);
    }
    a.port:hover,
    a.port:focus-visible {
      text-decoration: underline;
    }
    a.port:focus-visible {
      outline: 2px solid var(--h-primary-color);
      outline-offset: 1px;
      border-radius: 0.125rem;
    }
  `,
})
export class ContainerPortsCell implements ICellRendererAngularComp {
  protected readonly ports = signal<readonly PortMapping[]>([]);
  protected readonly local = signal(false);
  protected readonly label = portLabel;
  private context: ContainerGridContext | null = null;

  agInit(params: ICellRendererParams<Container, unknown, ContainerGridContext>): void {
    this.refresh(params);
  }

  refresh(params: ICellRendererParams<Container, unknown, ContainerGridContext>): boolean {
    this.ports.set(params.data?.ports ?? []);
    this.context = params.context;
    this.local.set(params.context?.local() ?? false);
    return true;
  }

  protected open(event: Event, port: number): void {
    event.preventDefault();
    this.context?.openPort(port);
  }
}

/** What the cells of the stack grid call back into the view; handed to the grid as `[context]`. */
export interface StackGridContext {
  /** Opens or closes the containers of a stack. */
  toggle(stack: string): void;
  /** Opens the detail of a stack. */
  openStack(stack: string): void;
  /** Opens the details of a container. */
  details(container: Container): void;
}

/** The first column of the stack grid: a stack with its expand toggle, or an indented container. */
@Component({
  selector: "app-stack-name-cell",
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HxButton, HxTooltip],
  template: `@if (row(); as r) {
    @if (r.kind === "stack") {
      <span class="name">
        <button
          hx-button
          iconOnly
          variant="text"
          severity="secondary"
          size="small"
          type="button"
          class="toggle"
          [attr.aria-expanded]="r.expanded"
          [attr.aria-label]="(r.expanded ? 'Collapse ' : 'Expand ') + r.stack.name"
          [hx-tooltip]="(r.expanded ? 'Collapse ' : 'Expand ') + r.stack.name"
          (click)="toggle(r.stack.name)"
        >
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 4l4 4-4 4" /></svg>
        </button>
        <a
          [href]="'/stacks/' + r.stack.name"
          [attr.aria-label]="'Details of ' + r.stack.name"
          (click)="openStack($event, r.stack.name)"
          >{{ r.stack.name }}</a
        >
      </span>
    } @else {
      <span class="name nested">
        <span
          class="dot"
          [attr.data-state]="r.container.state"
          [attr.data-health]="r.container.health"
        ></span>
        <a
          [href]="'/containers/' + r.container.id"
          [attr.aria-label]="'Details of ' + r.container.name"
          (click)="details($event, r.container)"
          >{{ r.container.name }}</a
        >
      </span>
    }
  }`,
  styles: `
    .name {
      display: inline-flex;
      align-items: center;
      gap: 0.35rem;
    }
    .nested {
      padding-inline-start: 1.85rem;
    }
    /* a grid row is 30 px high: the button stays inside it */
    .toggle {
      width: 1.5rem;
      height: 1.5rem;
      padding: 0;
    }
    .toggle svg {
      width: 0.85rem;
      height: 0.85rem;
      fill: none;
      stroke: currentColor;
      stroke-width: 1.75;
      transition: transform 120ms ease;
    }
    .toggle[aria-expanded="true"] svg {
      transform: rotate(90deg);
    }
    a {
      color: inherit;
      text-decoration: none;
    }
    .name:not(.nested) a {
      font-weight: 600;
    }
    a:hover,
    a:focus-visible {
      color: var(--h-primary-color);
      text-decoration: underline;
    }
    @media (prefers-reduced-motion: reduce) {
      .toggle svg {
        transition: none;
      }
    }
    ${DOT_STYLES}
  `,
})
export class StackNameCell implements ICellRendererAngularComp {
  protected readonly row = signal<StackRow | null>(null);
  private context: StackGridContext | null = null;

  agInit(params: ICellRendererParams<StackRow, unknown, StackGridContext>): void {
    this.refresh(params);
  }

  refresh(params: ICellRendererParams<StackRow, unknown, StackGridContext>): boolean {
    this.row.set(params.data ?? null);
    this.context = params.context;
    return true;
  }

  protected toggle(name: string): void {
    this.context?.toggle(name);
  }

  protected openStack(event: Event, name: string): void {
    event.preventDefault();
    this.context?.openStack(name);
  }

  protected details(event: Event, container: Container): void {
    event.preventDefault();
    this.context?.details(container);
  }
}

/** What the group row of a stack calls back into the view. */
export interface StackGroupContext {
  isCollapsed(stack: string | null): boolean;
  toggle(stack: string | null): void;
}

interface StackGroupParams {
  data: GroupRow;
  context: StackGroupContext;
}

/** The full-width row that heads a stack: its name, how many of its containers run, and a collapse button. */
@Component({
  selector: "app-stack-group-cell",
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HxButton],
  template: `@if (row(); as g) {
    <button
      hx-button
      variant="text"
      severity="secondary"
      size="small"
      type="button"
      class="group"
      [attr.aria-expanded]="!collapsed()"
      (click)="toggle()"
    >
      <span class="chevron" aria-hidden="true">{{ collapsed() ? "▸" : "▾" }}</span>
      <strong>{{ g.stack ?? noStack }}</strong>
      <span class="count">{{ g.running }} of {{ g.total }} running</span>
    </button>
  }`,
  styles: `
    /* the header fills the full-width row, so its content starts at the left and the focus ring stays inside */
    .group {
      justify-content: flex-start;
      width: 100%;
      height: 100%;
      padding-block: 0;
      padding-inline: 0.75rem;
      border-radius: 0;
      color: inherit;
    }
    .group:focus-visible {
      outline-offset: -2px;
    }
    .count {
      color: var(--h-text-muted-color);
    }
  `,
})
export class StackGroupCell {
  protected readonly noStack = NO_STACK;
  protected readonly row = signal<GroupRow | null>(null);
  protected readonly collapsed = signal(false);
  private params: StackGroupParams | null = null;

  agInit(params: StackGroupParams): void {
    this.refresh(params);
  }

  refresh(params: StackGroupParams): boolean {
    this.params = params;
    this.row.set(params.data);
    this.collapsed.set(params.context.isCollapsed(params.data.stack));
    return true;
  }

  protected toggle(): void {
    if (!this.params) return;
    this.params.context.toggle(this.params.data.stack);
    this.collapsed.set(this.params.context.isCollapsed(this.params.data.stack));
  }
}
