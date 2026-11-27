// @vitest-environment happy-dom
import {
  type GridApi,
  ClientSideRowModelModule,
  ColumnApiModule,
  ExternalFilterModule,
  RowApiModule,
  RowSelectionModule,
  ValidationModule,
  createGrid,
} from "ag-grid-community";
import { TestBed } from "@angular/core/testing";
import { BrowserTestingModule, platformBrowserTesting } from "@angular/platform-browser/testing";
import { afterEach, describe, expect, it } from "vitest";

import type { Container } from "../core/bindings";
import { filterContainers } from "../core/containers";
import { StackGroupCell } from "./cells";
import {
  type GroupRow,
  type Row,
  isGroup,
  isSelectable,
  stackGroupOptions,
  toRows,
} from "./stack-groups";

TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting());

const c = (
  name: string,
  stack: string | null,
  state: Container["state"] = "running",
): Container => ({
  id: name,
  name,
  image: "img",
  state,
  health: null,
  status: "",
  ports: [],
  created: 1,
  composeProject: stack,
});
const containers = [
  c("zeta", null),
  c("b-web", "blog"),
  c("a-db", "blog", "exited"),
  c("x-api", "app"),
  c("y-db", "app"),
];

let api: GridApi<Row>;
let grouped = true;
let collapsed = new Set<string | null>();

function make(): void {
  grouped = true;
  collapsed = new Set();
  api = createGrid<Row>(
    document.createElement("div"),
    {
      ...stackGroupOptions({ grouped: () => grouped, collapsed: () => collapsed }),
      fullWidthCellRenderer: (() => document.createElement("div")) as never,
      columnDefs: [{ field: "name" as never, sort: "asc", sortable: true }],
      rowData: toRows(containers, true),
      getRowId: (p) => p.data.id,
      rowSelection: { mode: "multiRow", selectAll: "filtered", isRowSelectable: isSelectable },
    },
    {
      modules: [
        ClientSideRowModelModule,
        ColumnApiModule,
        RowSelectionModule,
        RowApiModule,
        ExternalFilterModule,
        ValidationModule,
      ],
    },
  );
}

/** Replaces the data like the periodic refresh of the list does. */
function refresh(next: Container[]): void {
  api.setGridOption("rowData", toRows(next, grouped));
}

function setCollapsed(stack: string | null, value: boolean): void {
  if (value) collapsed.add(stack);
  else collapsed.delete(stack);
  api.onFilterChanged();
}

const shown = () => {
  const out: string[] = [];
  for (let i = 0; i < api.getDisplayedRowCount(); i++) {
    const row = api.getDisplayedRowAtIndex(i)!.data!;
    out.push(isGroup(row) ? `[${row.stack}]` : row.name);
  }
  return out;
};
const selected = () =>
  api
    .getSelectedRows()
    .map((r) => r.id)
    .sort();

describe("toRows", () => {
  it("adds one group row per stack with its counts, and the containers without a stack form one", () => {
    const groups = toRows(containers, true).filter(isGroup);
    expect(groups.map((g) => [g.stack, g.running, g.total])).toEqual([
      [null, 1, 1],
      ["blog", 1, 2],
      ["app", 2, 2],
    ]);
  });

  it("returns only the containers when not grouped", () => {
    expect(toRows(containers, false).some(isGroup)).toBe(false);
    expect(toRows(containers, false)).toHaveLength(containers.length);
  });

  it("counts what the state filter leaves", () => {
    const exited = toRows(filterContainers(containers, "", "exited"), true).filter(isGroup);
    expect(exited.map((g) => [g.stack, g.running, g.total])).toEqual([["blog", 0, 1]]);
    const running = toRows(filterContainers(containers, "", "running"), true).filter(isGroup);
    expect(running.map((g) => [g.stack, g.running, g.total])).toEqual([
      [null, 1, 1],
      ["blog", 1, 1],
      ["app", 2, 2],
    ]);
  });

  it("leaves no group for a stack whose containers the name filter removes", () => {
    const rows = toRows(filterContainers(containers, "web", "all"), true);
    expect(rows.filter(isGroup).map((g) => g.stack)).toEqual(["blog"]);
  });
});

describe("the grouped grid", () => {
  afterEach(() => api.destroy());

  it("keeps the containers inside their group, in both sort directions", async () => {
    make();
    expect(shown()).toEqual([
      "[app]",
      "x-api",
      "y-db",
      "[blog]",
      "a-db",
      "b-web",
      "[null]",
      "zeta",
    ]);
    api.applyColumnState({ state: [{ colId: "name", sort: "desc" }] });
    await new Promise((r) => setTimeout(r, 50));
    expect(shown()).toEqual([
      "[app]",
      "y-db",
      "x-api",
      "[blog]",
      "b-web",
      "a-db",
      "[null]",
      "zeta",
    ]);
  });

  it("shows a flat list while not grouped", () => {
    make();
    grouped = false;
    refresh(containers);
    setCollapsed("blog", true);
    expect(shown()).toEqual(["a-db", "b-web", "x-api", "y-db", "zeta"]);
  });

  it("hides the containers of a collapsed stack and keeps its group row", () => {
    make();
    setCollapsed("blog", true);
    expect(shown()).toEqual(["[app]", "x-api", "y-db", "[blog]", "[null]", "zeta"]);
    setCollapsed("blog", false);
    expect(shown()).toContain("a-db");
  });

  it("collapses the group of the containers without a stack", () => {
    make();
    setCollapsed(null, true);
    expect(shown()).toEqual(["[app]", "x-api", "y-db", "[blog]", "a-db", "b-web", "[null]"]);
  });

  it("never selects a group row, not even by the row API", () => {
    make();
    api.setNodesSelected({ nodes: [api.getRowNode("group:app")!], newValue: true });
    expect(selected()).toEqual([]);
    expect(isSelectable(api.getRowNode("group:app")!)).toBe(false);
    expect(isSelectable(api.getRowNode("x-api")!)).toBe(true);
  });

  it("selects only containers with select all, and skips those of a collapsed stack", () => {
    make();
    api.selectAllFiltered();
    expect(selected()).toEqual(["a-db", "b-web", "x-api", "y-db", "zeta"]);
    api.deselectAll();
    setCollapsed("blog", true);
    api.selectAllFiltered();
    expect(selected()).toEqual(["x-api", "y-db", "zeta"]);
  });

  it("keeps the collapse state and the selection through a refresh of the list", () => {
    make();
    setCollapsed("blog", true);
    api.setNodesSelected({ nodes: [api.getRowNode("x-api")!], newValue: true });
    // a container stops, one disappears, a new stack appears
    refresh([c("zeta", null), c("b-web", "blog"), c("x-api", "app", "exited"), c("n1", "new")]);
    expect(shown()).toEqual(["[app]", "x-api", "[blog]", "[new]", "n1", "[null]", "zeta"]);
    expect(selected()).toEqual(["x-api"]);
    expect((api.getRowNode("group:app")!.data as GroupRow).running).toBe(0);
  });

  it("drops the group row when its last container leaves", () => {
    make();
    refresh(containers.filter((x) => x.composeProject !== "blog"));
    expect(shown()).toEqual(["[app]", "x-api", "y-db", "[null]", "zeta"]);
  });
});

describe("StackGroupCell", () => {
  const group: GroupRow = { kind: "group", id: "group:app", stack: "app", total: 2, running: 1 };

  it("reads the collapse state and toggles it through the view", () => {
    const stacks = new Set<string | null>();
    const context = {
      isCollapsed: (s: string | null) => stacks.has(s),
      toggle: (s: string | null) => void (stacks.delete(s) || stacks.add(s)),
    };
    const cell = new StackGroupCell();
    cell.agInit({ data: group, context });
    expect(cell["collapsed"]()).toBe(false);
    cell["toggle"]();
    expect(stacks.has("app")).toBe(true);
    expect(cell["collapsed"]()).toBe(true);
    expect(cell.refresh({ data: { ...group, running: 2 }, context })).toBe(true);
    expect(cell["row"]()?.running).toBe(2);
  });

  it("is a Helix text button that names the stack and shows whether it is expanded", () => {
    const stacks = new Set<string | null>();
    const context = {
      isCollapsed: (s: string | null) => stacks.has(s),
      toggle: (s: string | null) => void (stacks.delete(s) || stacks.add(s)),
    };
    const fixture = TestBed.createComponent(StackGroupCell);
    fixture.componentInstance.agInit({ data: group, context });
    fixture.detectChanges();
    const button = (fixture.nativeElement as HTMLElement).querySelector("button")!;
    /** The chevron, the name and the count; the flex gap separates them on screen. */
    const label = () => [...button.children].map((e) => e.textContent?.trim());

    expect(button.hasAttribute("hx-button")).toBe(true);
    expect(button.classList).toContain("hx-button-text");
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(label()).toEqual(["▾", "app", "1 of 2 running"]);

    button.click();
    fixture.detectChanges();
    expect(stacks.has("app")).toBe(true);
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(label()).toEqual(["▸", "app", "1 of 2 running"]);

    button.click();
    fixture.detectChanges();
    expect(stacks.has("app")).toBe(false);
    expect(button.getAttribute("aria-expanded")).toBe("true");
  });

  it("labels the group of the containers without a stack", () => {
    const fixture = TestBed.createComponent(StackGroupCell);
    fixture.componentInstance.agInit({
      data: { ...group, stack: null },
      context: { isCollapsed: () => false, toggle: () => {} },
    });
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain("No stack");
  });
});
