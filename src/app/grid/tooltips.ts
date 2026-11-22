import type { ITooltipParams } from "ag-grid-community";

import type { Image, Volume } from "../core/bindings";

/** Tooltip of the image column: the full reference, else the ID; nothing without row data. */
export function imageReferenceTooltip(p: ITooltipParams<Image>): string | undefined {
  return p.data?.reference ?? p.data?.id;
}

/** Tooltip of the image ID column: the full ID; nothing without row data. */
export function imageIdTooltip(p: ITooltipParams<Image>): string | undefined {
  return p.data?.id;
}

/** Tooltip of the volume mountpoint column; nothing without row data. */
export function volumeMountpointTooltip(p: ITooltipParams<Volume>): string | undefined {
  return p.data?.mountpoint;
}
