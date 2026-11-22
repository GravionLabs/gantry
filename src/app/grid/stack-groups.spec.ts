// @vitest-environment happy-dom
import {
  type GridApi,
  type GridOptions,
  ClientSideRowModelModule,
  ColumnApiModule,
  ExternalFilterModule,
  RowApiModule,
  RowSelectionModule,
  ValidationModule,
  createGrid,
} from "ag-grid-community";
import { afterEach, describe, expect, it } from "vitest";

import type { Container } from "../core/bindings";
import { type Row, isGroup, passesCollapse, regroup, withGroups } from "./stack-groups";

const c = (name: string, stack: string | null, state = "running"): Container => ({
  id: name,
  name,
  image: "img",
  state: state as Container["state"],
  health: null,
  status: "",
  ports: [],
  created: 1,
  composeProject: stack,
});
const data = [
  c("zeta", null),
  c("b-web", "blog"),
  c("a-db", "blog", "exited"),
  c("x-api", "app"),
  c("y-db", "app"),
];

let api: GridApi<Row>;
let collapsed = new Set<string | null>();

function make(extra: GridOptions<Row> = {}, rows: Row[] = withGroups(data)) {
  collapsed = new Set();
  api = createGrid<Row>(
    document.createElement("div"),
    {
      fullWidthCellRenderer: (() => document.createElement("div")) as never,
      columnDefs: [{ field: "name" as never, sort: "asc", sortable: true }],
      rowData: rows,
      getRowId: (p) => p.data.id,
      isFullWidthRow: (p) => isGroup(p.rowNode.data),
      postSortRows: (p) => regroup(p.nodes as never),
      isExternalFilterPresent: () => collapsed.size > 0,
      doesExternalFilterPass: (n) => passesCollapse(n.data!, collapsed),
      rowSelection: {
        mode: "multiRow",
        selectAll: "filtered",
        isRowSelectable: (n) => !isGroup(n.data),
      },
      ...extra,
    },
    {
      modules: [ClientSideRowModelModule, ColumnApiModule, RowSelectionModule, RowApiModule, ExternalFilterModule, ValidationModule],
    },
  );
}
const shown = () => {
  const out: string[] = [];
  for (let i = 0; i < api.getDisplayedRowCount(); i++) {
    const n = api.getDisplayedRowAtIndex(i)!;
    out.push(isGroup(n.data) ? `[${n.data.stack}]` : n.data!.name);
  }
  return out;
};
afterEach(() => api.destroy());

describe("stack group rows with AG Grid Community", () => {
  it("keeps containers inside their group on ascending and descending sort", async () => {
    make();
    expect(shown()).toEqual(["[app]", "x-api", "y-db", "[blog]", "a-db", "b-web", "[null]", "zeta"]);
    api.applyColumnState({ state: [{ colId: "name", sort: "desc" }] });
    await new Promise((r) => setTimeout(r, 50));
    expect(shown()).toEqual(["[app]", "y-db", "x-api", "[blog]", "b-web", "a-db", "[null]", "zeta"]);
  });

  it("hides the containers of a collapsed stack and keeps the group row", () => {
    make();
    collapsed.add("blog");
    api.onFilterChanged();
    expect(shown()).toEqual(["[app]", "x-api", "y-db", "[blog]", "[null]", "zeta"]);
  });

  it("selects only containers; select all skips group rows and collapsed containers", () => {
    make();
    api.selectAllFiltered();
    expect(api.getSelectedRows().map((r) => r.id).sort()).toEqual(["a-db", "b-web", "x-api", "y-db", "zeta"]);
    api.deselectAll();
    collapsed.add("blog");
    api.onFilterChanged();
    api.selectAllFiltered();
    expect(api.getSelectedRows().map((r) => r.id).sort()).toEqual(["x-api", "y-db", "zeta"]);
  });

  it("survives a list refresh: the collapse set lives outside the grid, selection follows the row id", () => {
    make();
    collapsed.add("blog");
    api.onFilterChanged();
    api.setNodesSelected({ nodes: [api.getRowNode("x-api")!], newValue: true });
    // refresh: a container starts, one disappears, a new stack appears
    api.setGridOption("rowData", withGroups([c("zeta", null), c("b-web", "blog"), c("x-api", "app", "exited"), c("n1", "new")]));
    expect(shown()).toEqual(["[app]", "x-api", "[blog]", "[new]", "n1", "[null]", "zeta"]);
    expect(api.getSelectedRows().map((r) => r.id)).toEqual(["x-api"]);
    expect((api.getRowNode("group:app")!.data as { running: number }).running).toBe(0);
  });

  it("drops a group row when its last container leaves (empty groups vanish)", () => {
    make();
    api.setGridOption("rowData", withGroups(data.filter((d) => d.composeProject !== "blog")));
    expect(shown()).toEqual(["[app]", "x-api", "y-db", "[null]", "zeta"]);
  });
});
