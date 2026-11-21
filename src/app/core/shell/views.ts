import type { HelixView } from "@gravionlabs/helix-desktop";

/** One entry of the activity bar; the content of a view is supplied by its feature, an empty state until then. */
export interface GantryView extends HelixView {
  /** What the empty state says until the feature of the view lands. */
  readonly description: string;
}

/** The view the shell opens with. */
export const DEFAULT_VIEW = "containers";

/** The views in the order of the activity bar: the top group first, then the bottom group. */
export const VIEWS: readonly GantryView[] = [
  {
    id: "containers",
    label: "Containers",
    icon: "containers",
    placement: "sidebar",
    position: "top",
    description: "Containers of the active endpoint appear here.",
  },
  {
    id: "stacks",
    label: "Stacks",
    icon: "stacks",
    placement: "sidebar",
    position: "top",
    description: "Compose stacks of the active endpoint appear here.",
  },
  {
    id: "images",
    label: "Images",
    icon: "images",
    placement: "sidebar",
    position: "top",
    description: "Images of the active endpoint appear here.",
  },
  {
    id: "volumes",
    label: "Volumes",
    icon: "volumes",
    placement: "sidebar",
    position: "top",
    description: "Volumes of the active endpoint appear here.",
  },
  {
    id: "networks",
    label: "Networks",
    icon: "networks",
    placement: "sidebar",
    position: "top",
    description: "Networks of the active endpoint appear here.",
  },
  {
    id: "system",
    label: "System",
    icon: "system",
    placement: "sidebar",
    position: "top",
    description: "Engine information and disk usage appear here.",
  },
  {
    id: "endpoints",
    label: "Endpoints",
    icon: "endpoints",
    placement: "sidebar",
    position: "bottom",
    description: "Docker endpoints (local, context, TCP, SSH) are managed here.",
  },
  {
    id: "settings",
    label: "Settings",
    icon: "settings",
    placement: "sidebar",
    position: "bottom",
    description: "Application settings appear here.",
  },
];

/** The views that have a feature behind them; the detail views link only to these. */
const AVAILABLE_VIEWS: ReadonlySet<string> = new Set(["containers", "stacks"]);

/** Whether a link to the view can be offered, i.e. its feature has landed. */
export function isViewAvailable(id: string): boolean {
  return AVAILABLE_VIEWS.has(id);
}

/** Which end of the status bar an item sits at. */
export type StatusSide = "start" | "end";

/** One item of the status bar, declared as data so that the order is testable. */
export interface StatusItemDecl {
  readonly id: string;
  readonly side: StatusSide;
}

/** The status bar items in render order: the endpoint at the start, the engine and app version at the end. */
export const STATUS_ITEMS: readonly StatusItemDecl[] = [
  { id: "endpoint", side: "start" },
  { id: "engine-version", side: "end" },
  { id: "app-version", side: "end" },
];

/** The views that show data of the active endpoint; the others work without a reachable engine. */
export function requiresEndpoint(id: string): boolean {
  return id !== "endpoints" && id !== "settings";
}

export function findView(id: string): GantryView | undefined {
  return VIEWS.find((v) => v.id === id);
}

/** The wanted view when it exists, else the default one. */
export function resolveView(id: string | null | undefined): string {
  return id && findView(id) ? id : DEFAULT_VIEW;
}

/** The id of an item of the status bar on one side, in order. */
export function statusItems(side: StatusSide): string[] {
  return STATUS_ITEMS.filter((i) => i.side === side).map((i) => i.id);
}
