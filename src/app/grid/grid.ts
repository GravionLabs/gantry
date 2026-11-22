import { isDevMode } from "@angular/core";
import { helixGridTheme } from "@gravionlabs/helix-ag-grid";
import {
  CellStyleModule,
  ClientSideRowModelModule,
  ExternalFilterModule,
  type Module,
  RenderApiModule,
  RowApiModule,
  RowSelectionModule,
  RowStyleModule,
  TooltipModule,
  ValidationModule,
} from "ag-grid-community";

/**
 * The AG Grid Community modules the lists use, handed to each grid through `[modules]` instead of
 * a global registry. Development builds add the validation module, which names a missing module or
 * a wrong option in the console.
 */
export const GRID_MODULES: Module[] = [
  ClientSideRowModelModule,
  ExternalFilterModule,
  RowSelectionModule,
  RowStyleModule,
  CellStyleModule,
  RenderApiModule,
  RowApiModule,
  TooltipModule,
  ...(isDevMode() ? [ValidationModule] : []),
];

/** The Helix theme in a compact density that matches the desktop chrome. */
export const GRID_THEME = helixGridTheme.withParams({
  fontSize: 12,
  headerFontSize: 12,
  rowHeight: 30,
  headerHeight: 32,
  spacing: 6,
  wrapperBorderRadius: 6,
});
