/**
 * The overlay component for the whole stack. Depth 1 draws aside 1 alone. Depth 2+ draws the
 * collapsed lower levels (main conversation included) as slivers (wide window) or strips (tall
 * window), then the previous and the top aside splitting the rest evenly.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	type Focusable,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { SLIVER_WIDTH, STRIP_HEIGHT } from "../config.ts";
import { type Orientation, orientation, overlayRows } from "./layout.ts";
import type { AsidePane } from "./pane.ts";

function pad(line: string, width: number): string {
	const t = truncateToWidth(line, width);
	return t + " ".repeat(Math.max(0, width - visibleWidth(t)));
}

/** Geometry of the last render, for mouse hit-testing. */
interface Layout {
	orient: Orientation;
	/** Collapsed levels (slivers or strips). */
	collapsed: number;
	/** Columns (side) or rows (stacked) taken by the collapsed levels. */
	collapsedSize: number;
	/** Width (side) or height (stacked) of the parent pane; 0 at depth 1. */
	parentSize: number;
}

export class StackView implements Component, Focusable {
	private _focused = false;
	private layout: Layout = { orient: "side", collapsed: 0, collapsedSize: 0, parentSize: 0 };

	constructor(
		private tui: TUI,
		private theme: Theme,
		/** Open panes, level 1 first. */
		private panes: () => AsidePane[],
	) {}

	get focused(): boolean {
		return this._focused;
	}
	set focused(v: boolean) {
		this._focused = v;
		this.sync();
	}

	/** Re-apply roles and focus after the stack changed. */
	sync() {
		const panes = this.panes();
		panes.forEach((p, i) => {
			const isTop = i === panes.length - 1;
			p.role = isTop ? "top" : "parent";
			p.focused = isTop && this._focused;
		});
		this.tui.requestRender();
	}

	private top(): AsidePane | undefined {
		const panes = this.panes();
		return panes[panes.length - 1];
	}

	handleInput(data: string): void {
		this.top()?.handleInput(data);
	}

	invalidate(): void {
		for (const p of this.panes()) p.invalidate();
	}

	/** Deeper collapsed levels are drawn brighter. */
	private collapsedColor(depth: number, count: number) {
		return depth >= count - 1 ? "borderMuted" : "dim";
	}

	private static label(depth: number) {
		return depth === 0 ? "M" : String(depth);
	}

	/** Collapsed level `depth` (0 = main conversation) as a column on the left. */
	private sliver(depth: number, count: number, H: number): string[] {
		const th = this.theme;
		const line = (t: string) => th.fg(this.collapsedColor(depth, count), t);
		const lines: string[] = [];
		for (let r = 0; r < H; r++) {
			if (r === 0) lines.push(line("╭─"));
			else if (r === H - 1) lines.push(line("╰─"));
			else if (r === 1) lines.push(line("│") + th.fg("muted", StackView.label(depth)));
			else lines.push(line("│ "));
		}
		return lines.map((l) => pad(l, SLIVER_WIDTH));
	}

	/** Collapsed level `depth` as a row across the top. */
	private strip(depth: number, count: number, W: number): string {
		const th = this.theme;
		const name = depth === 0 ? "main" : `aside ${depth}`;
		const head = `${th.fg(this.collapsedColor(depth, count), "─ ")}${th.fg("muted", `${StackView.label(depth)} ${name}`)} `;
		const fill = Math.max(0, W - visibleWidth(head));
		return pad(head + th.fg(this.collapsedColor(depth, count), "─".repeat(fill)), W);
	}

	render(width: number): string[] {
		const panes = this.panes();
		const top = panes[panes.length - 1];
		if (!top) return [];
		const H = overlayRows(this.tui, panes.length);
		const orient = orientation(this.tui.terminal.columns, this.tui.terminal.rows);
		const parent = panes[panes.length - 2];
		if (!parent) {
			this.layout = { orient, collapsed: 0, collapsedSize: 0, parentSize: 0 };
			return top.renderBox(width, H).map((l) => pad(l, width));
		}
		// Collapsed levels: the main conversation plus every aside below the previous one.
		const collapsed = panes.length - 1;
		const out: string[] = [];

		if (orient === "side") {
			const collapsedSize = collapsed * SLIVER_WIDTH;
			const rest = Math.max(2, width - collapsedSize);
			const pw = Math.floor(rest / 2);
			const tw = rest - pw;
			this.layout = { orient, collapsed, collapsedSize, parentSize: pw };
			const slivers = Array.from({ length: collapsed }, (_, d) => this.sliver(d, collapsed, H));
			const left = parent.renderBox(pw, H);
			const right = top.renderBox(tw, H);
			for (let r = 0; r < H; r++) {
				const s = slivers.map((col) => col[r]).join("");
				out.push(truncateToWidth(s + pad(left[r] ?? "", pw) + pad(right[r] ?? "", tw), width));
			}
			return out;
		}

		const collapsedSize = Math.min(collapsed * STRIP_HEIGHT, Math.max(0, H - 2));
		const rest = Math.max(2, H - collapsedSize);
		const ph = Math.floor(rest / 2);
		const topH = rest - ph;
		this.layout = { orient, collapsed, collapsedSize, parentSize: ph };
		for (let d = 0; d < collapsedSize; d++) out.push(this.strip(d, collapsed, width));
		for (const l of parent.renderBox(width, ph)) out.push(pad(l, width));
		for (const l of top.renderBox(width, topH)) out.push(pad(l, width));
		return out.slice(0, H);
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		const panes = this.panes();
		const { orient, collapsed, collapsedSize, parentSize } = this.layout;
		const top = panes[panes.length - 1];
		if (collapsed === 0) return top?.handleMouse(event);

		const pos = orient === "side" ? event.x : event.y;
		// Collapsed levels ignore the mouse on purpose: a stray click must not close asides.
		if (pos < collapsedSize) return { handled: true };
		const offset = pos - collapsedSize;
		const inParent = offset < parentSize;
		const target = inParent ? panes[panes.length - 2] : top;
		if (!target) return undefined;
		const local = inParent ? offset : offset - parentSize;
		const r = target.handleMouse(orient === "side" ? { ...event, x: local } : { ...event, y: local });
		return r ?? { handled: true };
	}
}
