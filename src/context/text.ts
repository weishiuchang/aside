/** Small text helpers shared by the context builders and the UI. */

type Content = string | Array<{ type?: string; text?: string }> | undefined;

/** The text blocks of a message's content, joined by newlines. */
export function textOf(content: unknown): string {
	const c = content as Content;
	if (typeof c === "string") return c;
	if (!Array.isArray(c)) return "";
	return c
		.filter((x) => x?.type === "text" && typeof x.text === "string")
		.map((x) => x.text as string)
		.join("\n");
}

/** Keep the head and tail of `s` within `max` chars, marking what was cut. */
export function clip(s: string, max: number): string {
	if (s.length <= max) return s;
	const head = Math.floor(max * 0.7);
	return `${s.slice(0, head)}\n…[${s.length - max} chars omitted]…\n${s.slice(s.length - (max - head))}`;
}

export function oneLine(s: string): string {
	return s.replace(/\s+/g, " ").trim();
}

/** `s` on one line, cut to `max` chars with an ellipsis. */
export function shortLine(s: string, max: number): string {
	const line = oneLine(s);
	return line.length <= max ? line : `${line.slice(0, max - 1)}…`;
}

/** "1 tool call", "3 tool calls". */
export function plural(n: number, word: string): string {
	return `${n} ${word}${n === 1 ? "" : "s"}`;
}
