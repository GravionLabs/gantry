/** Which rows of the images and volumes lists are shown: all, those a container uses, or the rest. */
export type UsageFilter = "all" | "used" | "unused";

export const USAGE_OPTIONS: readonly { label: string; value: UsageFilter }[] = [
  { label: "All", value: "all" },
  { label: "Used", value: "used" },
  { label: "Unused", value: "unused" },
];

/** Whether a row used by `containers` containers (running or stopped) passes the filter. */
export function matchesUsage(filter: UsageFilter, containers: number): boolean {
  if (filter === "used") return containers > 0;
  if (filter === "unused") return containers === 0;
  return true;
}

/** `<shown> of <total>` while a filter hides rows, else the total. */
export function countLabel(shown: number, total: number, filter: UsageFilter): string {
  return filter === "all" ? `${total}` : `${shown} of ${total}`;
}
