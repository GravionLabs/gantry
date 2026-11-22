# Spike: stack group rows in the containers grid (AG Grid Community)

Issue #109. The prototype is on the branch `spike/109-stack-groups-prototype` (throwaway, not to be
merged). It adds `src/app/grid/stack-groups.ts`, a headless spec that runs the real grid
(`stack-groups.spec.ts`, happy-dom) and the wiring in `containers-view.ts`. The build and the
existing tests pass. The rendering was not checked in a browser; the behavior below is proven on
the grid API only.

**Result: Community is enough.** No decision issue is needed.

## How it works

- The row data is the containers plus one synthetic group row per stack
  (`{ kind: "group", id: "group:<stack>", stack, total, running }`). `getRowId` keeps the ids stable.
- `isFullWidthRow` (group rows) and `fullWidthCellRenderer` (an Angular cell with a button and
  `aria-expanded`) draw the header. No extra module is needed.
- `postSortRows` regroups the flat sorted nodes: bucket by stack, group row first, stacks ordered by
  name, "no stack" last.
- Collapse: the collapsed stacks live in a signal of the view. `isExternalFilterPresent` and
  `doesExternalFilterPass` hide the containers of a collapsed stack and never a group row. This
  needs `ExternalFilterModule` (Community). A toggle calls `api.onFilterChanged()`.

## Answers

- **Sort and filter.** The column sort orders the nodes flat; `postSortRows` then buckets them, so
  containers stay inside their group in both directions and the sort order holds inside a group.
  The group row needs no comparator, but the existing `sortedBy` comparators must skip group rows.
  The text and state filter stay on the signal (`visible()`), before the groups are built: a stack
  with no match has no group row, so an empty group never shows. The Stack column loses its point
  as a sort key; drop it or keep it as a label.
- **Selection.** `isRowSelectable: n => !isGroup(n.data)` keeps group rows out of the selection and
  the header checkbox. With `selectAll: "filtered"` the header checkbox skips the containers of
  collapsed stacks (tested with `selectAllFiltered`); `api.selectAll()` (mode `all`) would take
  them, so the view must keep "filtered". A per-stack checkbox is not built in: the group cell would
  call `api.setNodesSelected` for the visible containers of its stack. The selection toolbar reads
  the selected containers from the signal, so it stays correct.
- **Refresh.** The collapsed set is outside the grid, so a new `rowData` keeps it (the external
  filter runs again). With `getRowId`, a selection survives the refresh; a group row whose last
  container left disappears, a new stack appears, and the counts of a group row change with its
  row data (the renderer's `refresh` re-reads it). The busy `redrawRows()` and the stats refresh
  work as before.
- **Not covered.** Keyboard focus on group rows (the grid has `suppressCellFocus`, the button in
  the cell is the tab stop), the row height of a group row, and the collapse state across a change
  of the endpoint (it resets with the view, which is recreated).

## Estimate for the implementation PBI

About one day (size M): move the logic from the prototype into the grid folder with tests, type the
columns for the row union, add the per-stack checkbox, an expand/collapse-all control and a user
guide line. No new dependency.
