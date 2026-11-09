/** The focus and background blocks sent to the model with a question. */

import { BACKGROUND_MAX_CHARS, FOCUS_MAX_CHARS } from "../config.ts";
import type { Noun, Part } from "./parts.ts";
import { clip } from "./text.ts";

const heading = (noun: Noun, part: Part) => `### ${noun[0].toUpperCase()}${noun.slice(1)} ${part.number}`;

/** Parts lo..hi in full. */
export function focusBlock(parts: Part[], lo: number, hi: number, noun: Noun): string {
	const body = parts
		.slice(lo, hi + 1)
		.map((p) => `${heading(noun, p)}\n${p.full}`)
		.join("\n\n");
	return `<focus ${noun}s="${lo + 1}-${hi + 1}">\n${clip(body, FOCUS_MAX_CHARS)}\n</focus>`;
}

/**
 * Every part outside lo..hi in short form, nearest to the focus first, within `budget` chars; gaps
 * are marked as omitted. Pass lo = hi = parts.length to make everything background, latest first.
 */
export function backgroundBlock(
	parts: Part[],
	lo: number,
	hi: number,
	noun: Noun,
	tag = "background",
	budget = BACKGROUND_MAX_CHARS,
): string {
	const distance = (i: number) => (i < lo ? lo - i : i - hi);
	const others = parts.map((_, i) => i).filter((i) => i < lo || i > hi);
	if (!others.length) return "";
	const keep = new Set<number>();
	let used = 0;
	for (const i of others.sort((a, b) => distance(a) - distance(b))) {
		const cost = parts[i].brief.length + 20;
		if (used + cost > budget) break;
		keep.add(i);
		used += cost;
	}

	const out: string[] = [];
	let gapStart = -1;
	const closeGap = (end: number) => {
		if (gapStart < 0) return;
		out.push(`… (${noun}s ${gapStart + 1}–${end + 1} omitted for length) …`);
		gapStart = -1;
	};
	for (let i = 0; i < parts.length; i++) {
		if (i >= lo && i <= hi) {
			closeGap(i - 1);
			if (i === lo) out.push(`[${noun}s ${lo + 1}–${hi + 1}: see FOCUS]`);
		} else if (keep.has(i)) {
			closeGap(i - 1);
			out.push(`${heading(noun, parts[i])}\n${parts[i].brief}`);
		} else if (gapStart < 0) {
			gapStart = i;
		}
	}
	closeGap(parts.length - 1);
	return `<${tag}>\n${out.join("\n\n")}\n</${tag}>`;
}
