import type { GridOptions, IRowNode } from "ag-grid-community";

import type { Container } from "../core/bindings";

/** A synthetic full-width row that heads the containers of one stack. */
export interface GroupRow {
  readonly kind: "group";
  readonly id: string;
  /** The compose project; null for the containers that belong to no stack. */
  readonly stack: string | null;
  readonly total: number;
  readonly running: number;
}

/** A container as a row of the grid. */
export interface ContainerRow extends Container {
  readonly kind?: undefined;
}

export type Row = GroupRow | ContainerRow;

/** The label of the group of the containers that belong to no stack. */
export const NO_STACK = "No stack";

export const groupId = (stack: string | null) => `group:${stack ?? ""}`;
export const isGroup = (row: Row | undefined): row is GroupRow => row?.kind === "group";

/** The rows of the grid: the containers, plus one group row per stack while `grouped`. */
export function toRows(containers: readonly Container[], grouped: boolean): Row[] {
  if (!grouped) return [...containers];
  const stacks = new Map<string | null, Container[]>();
  for (const c of containers) {
    const list = stacks.get(c.composeProject) ?? [];
    list.push(c);
    stacks.set(c.composeProject, list);
  }
  const groups: GroupRow[] = [...stacks].map(([stack, list]) => ({
    kind: "group",
    id: groupId(stack),
    stack,
    total: list.length,
    running: list.filter((c) => c.state === "running").length,
  }));
  return [...containers, ...groups];
}

const text = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/**
 * `postSortRows`: the column sort has ordered the nodes flat. Bucket them by stack (the order inside
 * a bucket is the sort order), put the group row first and order the stacks by name, no stack last.
 */
export function regroup(nodes: IRowNode<Row>[]): void {
  const buckets = new Map<string | null, IRowNode<Row>[]>();
  const heads = new Map<string | null, IRowNode<Row>>();
  for (const node of nodes) {
    const row = node.data;
    if (!row) continue;
    if (isGroup(row)) {
      heads.set(row.stack, node);
    } else {
      const bucket = buckets.get(row.composeProject) ?? [];
      bucket.push(node);
      buckets.set(row.composeProject, bucket);
    }
  }
  const stacks = [...heads.keys()].sort((a, b) =>
    a === b ? 0 : a === null ? 1 : b === null ? -1 : text.compare(a, b),
  );
  nodes.splice(
    0,
    nodes.length,
    ...stacks.flatMap((s) => [heads.get(s)!, ...(buckets.get(s) ?? [])]),
  );
}

/** What the grid options read from the view. */
export interface StackGroupState {
  readonly grouped: () => boolean;
  /** The stacks whose containers are hidden; null stands for the containers without a stack. */
  readonly collapsed: () => ReadonlySet<string | null>;
}

/** The grid options that draw, sort, collapse and select the group rows. */
export function stackGroupOptions(
  state: StackGroupState,
): Pick<
  GridOptions<Row>,
  "isFullWidthRow" | "postSortRows" | "isExternalFilterPresent" | "doesExternalFilterPass"
> {
  return {
    isFullWidthRow: (p) => isGroup(p.rowNode.data),
    postSortRows: (p) => {
      if (state.grouped()) regroup(p.nodes);
    },
    // The external filter hides the containers of the collapsed stacks, never a group row.
    isExternalFilterPresent: () => state.grouped() && state.collapsed().size > 0,
    doesExternalFilterPass: (node) =>
      !node.data || isGroup(node.data) || !state.collapsed().has(node.data.composeProject),
  };
}

/** `isRowSelectable`: a group row is never selected, so no action and no "select all" reaches it. */
export const isSelectable = (node: IRowNode<Row>): boolean => !isGroup(node.data);
