/**
 * Where the stack sits, decided from the terminal size on every render so it follows resizes.
 *
 *   side     wide window: aside 1 takes the right half; from aside 2 on, the stack is full screen
 *            with the two top asides side by side and lower levels as slivers on the left.
 *   stacked  tall window: aside 1 takes the top half (pi's editor stays visible below); from
 *            aside 2 on, the two top asides sit one above the other and lower levels are strips.
 */

import type { OverlayAnchor, OverlayOptions, SizeValue, TUI } from "@earendil-works/pi-tui";
import { CELL_ASPECT, SIDE_MIN_WIDTH } from "../config.ts";

export type Orientation = "side" | "stacked";

/** Compares the window's physical shape: cells are about twice as tall as wide. */
export function orientation(cols: number, rows: number): Orientation {
	return cols < rows * CELL_ASPECT ? "stacked" : "side";
}

/** Columns aside 1 takes beside the main conversation in a wide window. */
export function sideWidth(cols: number): number {
	return Math.max(1, Math.min(cols, Math.max(Math.floor(cols / 2), SIDE_MIN_WIDTH)));
}

/** Rows the overlay renders for the given stack depth. */
export function overlayRows(tui: TUI, depth: number): number {
	const rows = tui.terminal.rows;
	if (depth <= 1 && orientation(tui.terminal.columns, rows) === "stacked") return Math.max(1, Math.floor(rows / 2));
	return Math.max(1, rows);
}

/**
 * Overlay options read live: pi keeps the options object and reads its fields on every render, so
 * getters let one overlay change size and position as the window or the stack changes.
 */
export function liveOverlayOptions(tui: TUI, depth: () => number): OverlayOptions {
	const mode = () => (depth() > 1 ? "full" : orientation(tui.terminal.columns, tui.terminal.rows));
	return {
		margin: 0,
		get anchor(): OverlayAnchor {
			return mode() === "side" ? "top-right" : "top-left";
		},
		get width(): SizeValue {
			return mode() === "side" ? sideWidth(tui.terminal.columns) : "100%";
		},
		get maxHeight(): SizeValue {
			return overlayRows(tui, depth());
		},
	};
}
