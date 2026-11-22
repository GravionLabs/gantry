import type { IRowNode } from "ag-grid-community";

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
export interface ContainerRow extends Container {
  readonly kind?: undefined;
}
export type Row = GroupRow | ContainerRow;

export const NO_STACK = "No stack";
export const groupId = (stack: string | null) => `group:${stack ?? ""}`;
export const isGroup = (row: Row | undefined): row is GroupRow => row?.kind === "group";

/** The containers plus one group row per stack; the grid keeps them together (see `regroup`). */
export function withGroups(containers: readonly Container[]): Row[] {
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
    const row = node.data!;
    const stack = isGroup(row) ? row.stack : row.composeProject;
    if (isGroup(row)) heads.set(stack, node);
    else buckets.set(stack, [...(buckets.get(stack) ?? []), node]);
  }
  const stacks = [...heads.keys()].sort((a, b) =>
    a === b ? 0 : a === null ? 1 : b === null ? -1 : text.compare(a, b),
  );
  nodes.splice(0, nodes.length, ...stacks.flatMap((s) => [heads.get(s)!, ...(buckets.get(s) ?? [])]));
}

/** The external filter that hides the containers of the collapsed stacks and never a group row. */
export function passesCollapse(row: Row, collapsed: ReadonlySet<string | null>): boolean {
  return isGroup(row) || !collapsed.has(row.composeProject);
}
