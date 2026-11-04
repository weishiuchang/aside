/**
 * Keeps the first visible line in place when text re-wraps to a new width. A scroll position is a
 * row number, and re-wrapping moves every row below the first wrapped line, so the same number
 * shows other text. An anchor records the content instead: which component holds the top row (a
 * path through plain containers), and how many visible non-space characters of that component come
 * before the row. Wrapping changes only spaces and line breaks, so that count names the same text
 * at any width.
 */

import { type Component, Container } from "@earendil-works/pi-tui";

export interface LineAnchor {
	/** Visible non-space characters before the line. */
	offset: number;
	/** Blank rows from the line down to the next text, so a blank top row stays on top. */
	lead: number;
}

export interface Anchor extends LineAnchor {
	/** Child indexes from the root down to the component holding the line. */
	path: number[];
}

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[PX^_][^\x1b]*\x1b\\|\x1b./g;

function weight(line: string): number {
	return line.replace(ANSI, "").replace(/\s/g, "").length;
}

/** The anchor of `row` in rendered lines. */
export function lineAnchor(lines: readonly string[], row: number): LineAnchor {
	let offset = 0;
	for (let r = 0; r < row && r < lines.length; r++) offset += weight(lines[r]);
	let lead = 0;
	while (row + lead < lines.length && weight(lines[row + lead]) === 0) lead++;
	if (row + lead >= lines.length) lead = 0;
	return { offset, lead };
}

/** The row an anchor names in lines rendered at another width. */
export function anchorRow(lines: readonly string[], anchor: LineAnchor): number {
	let seen = 0;
	for (let r = 0; r < lines.length; r++) {
		const w = weight(lines[r]);
		if (w && seen + w > anchor.offset) return Math.max(0, r - anchor.lead);
		seen += w;
	}
	return Math.max(0, lines.length - 1);
}

/** Containers whose rows are their children's rows, one after another. */
function stacks(component: Component): component is Container {
	return component instanceof Container && component.render === Container.prototype.render;
}

/** The anchor of `row` in `root` rendered at `width`. */
export function anchorAt(root: Component, width: number, row: number): Anchor {
	const path: number[] = [];
	let component = root;
	let rest = row;
	while (stacks(component)) {
		const children = component.children;
		let i = 0;
		for (; i < children.length; i++) {
			const height = children[i].render(width).length;
			if (rest < height) break;
			rest -= height;
		}
		if (i === children.length) break;
		path.push(i);
		component = children[i];
	}
	return { path, ...lineAnchor(component.render(width), rest) };
}

/** The row `anchor` names in `root` rendered at `width`, or nothing when its component is gone. */
export function rowAt(root: Component, width: number, anchor: Anchor): number | undefined {
	let component = root;
	let top = 0;
	for (const index of anchor.path) {
		if (!stacks(component) || index >= component.children.length) return undefined;
		for (let i = 0; i < index; i++) top += component.children[i].render(width).length;
		component = component.children[index];
	}
	return top + anchorRow(component.render(width), anchor);
}
