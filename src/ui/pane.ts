/** One aside pane: the part list, the thread (or a preview), the question box, hints, and border. */

import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme, keyText, UserMessageComponent } from "@earendil-works/pi-coding-agent";
import {
	type AutocompleteProvider,
	type Component,
	type Focusable,
	Markdown,
	matchesKey,
	Text,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { LIST_MAX_ROWS, MAX_DEPTH, MAX_INPUT_ROWS, OPEN_KEYS, SUMMARY_KEY, THREAD_KEY, THREAD_WINDOW } from "../config.ts";
import { type Part, rangeLabel, sentDownText } from "../context/parts.ts";
import { clip, plural } from "../context/text.ts";
import { type AsideLevel, answerVersion, handoffTitle, type SentDown, selectedRange, syncSelection } from "../level.ts";
import { anchorRow, lineAnchor } from "./anchor.ts";
import { QuestionBox } from "./question-box.ts";

export interface PaneActions {
	/** Ask a question or run a slash command. Returns false to keep the text in the box. */
	submit: (text: string) => boolean;
	/** pi's editor autocomplete with the aside's commands. */
	autocomplete: AutocompleteProvider;
	/** Rows of the autocomplete list, pi's setting. */
	autocompleteMaxVisible: number;
	/** Model, thinking level, and usage, for the bottom border. */
	status: () => string;
	summarize: () => void;
	/** Send the whole thread to the level below as it is. */
	sendThread: () => void;
	openNested: () => void;
	/** pi's tool-output expansion, which also shows what nested asides sent down in full. */
	expanded: () => boolean;
	toggleExpanded: () => void;
	/** Whether thinking shows as one "Thinking..." line, as pi's thinking-block setting decides. */
	thinkingHidden: () => boolean;
	toggleThinking: () => void;
	/** Close this aside (the top of the stack). */
	close: () => void;
}

/** Part of a block: Markdown, or the model's thinking, styled as pi's main pane styles it. */
interface Section {
	text: string;
	thinking?: boolean;
}

/** pi's label for a hidden thinking block. */
const HIDDEN_THINKING_LABEL = "Thinking...";

const markdown = (text: string): Section[] => [{ text }];

/**
 * A block of the thread area. Rendered lines are cached per `key` object and reused while
 * `version` and the width are unchanged, so a frame only renders the block that is streaming; in
 * that block, only sections whose text changed (the growing one) are rendered again.
 */
interface Block {
	key: object;
	version: string;
	/** A question, shown above `text` the way pi's main pane shows a user prompt. */
	prompt?: string;
	sections: () => Section[];
}

/** A block's rendered lines, and its question's and sections' lines, to re-render only what changed. */
interface BlockRender {
	width: number;
	version: string;
	lines: string[];
	thinkingHidden: boolean;
	prompt?: { text: string; lines: string[] };
	sections: (Section & { lines: string[] })[];
}

/** Part-list marks for what a nested aside sent down. */
const HANDOFF_MARKS: Record<SentDown, string> = { summary: "Σ ", thread: "≡ ", changes: "Δ " };

/** One-row preview of a possibly multi-line draft. */
function draftPreview(draft: string): string {
	const lines = draft.split("\n");
	return lines.length > 1 ? `${lines[0]} … (+${lines.length - 1} lines)` : draft;
}

export class AsidePane implements Component, Focusable {
	/** "top" takes input; "parent" is the aside below it, shown beside it. */
	role: "top" | "parent" = "top";
	private input: QuestionBox;
	private _focused = false;
	private listTop = 0;
	/** Rows of the part list in the last render, for clicks. */
	private listRows = { start: 1, count: 0 };
	private threadHeight = 10;
	private blockCache = new WeakMap<object, BlockRender>();
	private separator?: { width: number; lines: string[] };
	/** The thread's top row at the last render, to keep its line on top when the width changes. */
	private shown?: { width: number; start: number; scroll: number };
	/** Cache key of the status line under the thread. */
	private readonly noticeKey = {};

	constructor(
		private tui: TUI,
		private theme: Theme,
		keybindings: KeybindingsManager,
		readonly level: AsideLevel,
		private actions: PaneActions,
	) {
		this.input = new QuestionBox(
			tui,
			keybindings,
			actions.autocomplete,
			actions.autocompleteMaxVisible,
			{
				submit: (text) => this.submit(text),
				change: (text) => {
					level.draft = text;
				},
				escape: () => level.task?.controller.abort(),
				// It closes at once, stopping whatever is streaming: the user no longer wants its result.
				exit: () => actions.close(),
				toggleExpanded: () => actions.toggleExpanded(),
				toggleThinking: () => actions.toggleThinking(),
			},
			level.depth === 1 ? "Ask about the selected turns…" : `Ask about the selected exchanges of aside ${level.depth - 1}…`,
			(t) => theme.fg("dim", t),
		);
		this.input.setValue(level.draft);
	}

	get focused(): boolean {
		return this._focused;
	}
	set focused(v: boolean) {
		this._focused = v;
		this.input.focused = v;
		this.tui.requestRender();
	}

	private get isTop() {
		return this.role === "top";
	}

	private parts(): Part[] {
		const parts = this.level.parts();
		if (parts.length) syncSelection(this.level, parts.length);
		return parts;
	}

	// ── Selection ──────────────────────────────────────────────────────────────

	/** Select the previous or next single part. */
	private move(delta: number) {
		const level = this.level;
		const total = this.parts().length;
		if (!total) return;
		level.anchor = level.cursor = Math.min(Math.max(0, level.cursor + delta), total - 1);
		if (!level.thread.length) {
			level.scroll = 0;
			level.windowStart = 0;
		}
		this.tui.requestRender();
	}

	// ── Input ──────────────────────────────────────────────────────────────────

	private setInput(value: string) {
		this.input.setValue(value);
		this.level.draft = value;
		this.tui.requestRender();
	}

	/** Enter in the box, which has already cleared it. Text that was not asked goes back. */
	private submit(text: string) {
		const q = text.trim();
		if (!q) return;
		this.input.addToHistory(q);
		if (!this.actions.submit(q)) this.setInput(text);
		this.tui.requestRender();
	}

	/** Scroll by `delta` lines; scrolling past the window edge slides other exchanges in. */
	scrollThread(delta: number) {
		this.level.follow = false;
		this.level.scroll += delta;
		this.tui.requestRender();
	}

	/**
	 * Aside-specific keys are handled here; every other key goes to the box, pi's editor, which also
	 * handles esc, pi's exit key, enter, and pi's app actions the way pi's editor does.
	 */
	handleInput(data: string): void {
		const level = this.level;
		if (OPEN_KEYS.some((k) => matchesKey(data, k))) return this.actions.openNested();
		if (matchesKey(data, SUMMARY_KEY)) {
			if (!level.task) this.actions.summarize();
			return;
		}
		if (matchesKey(data, THREAD_KEY)) {
			if (!level.task) this.actions.sendThread();
			return;
		}
		if (matchesKey(data, "shift+up")) return this.move(-1);
		if (matchesKey(data, "shift+down")) return this.move(1);
		// The open autocomplete list takes the page keys, as in pi.
		const page = Math.max(1, this.threadHeight - 2);
		if (!this.input.autocompleteOpen) {
			if (matchesKey(data, "pageUp")) return this.scrollThread(-page);
			if (matchesKey(data, "pageDown")) return this.scrollThread(page);
		}
		this.input.submitDisabled = !!level.task;
		this.input.handleInput(data);
		this.tui.requestRender();
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type === "wheel" && event.wheelDelta) {
			this.scrollThread(event.wheelDelta);
			return { handled: true };
		}
		if (!this.isTop || event.type !== "click" || event.button !== "left") return undefined;
		const row = event.y - this.listRows.start;
		if (row < 0 || row >= this.listRows.count) return undefined;
		const index = this.listTop + row;
		if (index < this.parts().length) {
			this.level.cursor = index;
			if (!event.shift) this.level.anchor = index;
			this.tui.requestRender();
		}
		return { handled: true, focus: true };
	}

	invalidate(): void {
		this.blockCache = new WeakMap();
		this.separator = undefined;
		this.input.invalidate();
	}

	// ── Thread ─────────────────────────────────────────────────────────────────

	/**
	 * The thread area's blocks: one per previewed part before the first question, one per exchange
	 * after it, and the status line under the last one.
	 */
	private threadBlocks(parts: Part[]): { blocks: Block[]; notice?: Block } {
		const level = this.level;
		const notice = (text: string | undefined): Block | undefined =>
			text ? { key: this.noticeKey, version: text, sections: () => markdown(`_${text}_`) } : undefined;

		if (!level.thread.length) {
			const { lo, hi } = selectedRange(level);
			const Noun = level.noun === "turn" ? "Turn" : "Exchange";
			const blocks = parts.slice(lo, hi + 1).map(
				(p): Block => ({
					key: p,
					version: "",
					prompt: p.handoff ? undefined : clip(p.prompt.trim() || "(no prompt text)", 600),
					sections: () => {
						if (p.handoff) return markdown(`**${Noun} ${p.number} · ${p.title}:** ${clip(p.reply.trim(), 900)}`);
						const lines = [`_(${level.noun} ${p.number})_`];
						if (p.reply) lines.push(`**${level.depth === 1 ? "Agent" : "Answer"}:** ${clip(p.reply.trim(), 900)}`);
						if (p.toolCalls) lines.push(`_${plural(p.toolCalls, "tool call")}_`);
						return markdown(lines.join("\n\n"));
					},
				}),
			);
			return { blocks, notice: notice(level.notice) };
		}

		const expanded = this.actions.expanded();
		const thinkingHidden = this.actions.thinkingHidden();
		const blocks = level.thread.map(
			(ex): Block => ({
				key: ex,
				version: `${answerVersion(ex)}|${ex.done}|${ex.aborted}|${ex.error ?? ""}|${expanded}|${thinkingHidden}`,
				prompt: ex.from ? undefined : ex.question,
				sections: () => {
					if (ex.from && !expanded) return markdown(`**${handoffTitle(ex.from)}** _(${keyText("app.tools.expand")} to expand)_`);
					if (ex.from) return markdown(`**${handoffTitle(ex.from)}:**\n\n${sentDownText(ex)}`);
					const sections: Section[] = [{ text: `_(${ex.label})_` }];
					for (const s of ex.segments) {
						const text = s.text.trim();
						if (text) sections.push({ text, thinking: s.kind === "thinking" });
					}
					const status: string[] = [];
					if (sections.length === 1 && !ex.error && !ex.aborted) status.push("_…_");
					if (ex.aborted) status.push("_(stopped)_");
					if (ex.error) status.push(`**Error:** ${ex.error}`);
					if (status.length) sections.push({ text: status.join("\n\n") });
					return sections;
				},
			}),
		);
		const target = level.depth === 1 ? "the main conversation" : `aside ${level.depth - 1}`;
		const busy = level.task?.kind === "summary" ? `Summarizing for ${target}…` : level.task?.kind === "check" ? "Checking what the commands changed…" : undefined;
		return { blocks, notice: notice(busy ?? level.notice) };
	}

	private blockLines(width: number, block: Block): string[] {
		const thinkingHidden = this.actions.thinkingHidden();
		let hit = this.blockCache.get(block.key);
		if (hit && hit.width === width && hit.version === block.version) return hit.lines;
		if (!hit || hit.width !== width || hit.thinkingHidden !== thinkingHidden) {
			hit = { width, version: "", lines: [], thinkingHidden, sections: [] };
			this.blockCache.set(block.key, hit);
		}
		const old = hit.sections;
		hit.sections = block.sections().map((s, i) =>
			old[i]?.text === s.text && old[i].thinking === s.thinking ? old[i] : { ...s, lines: this.sectionLines(width, s) },
		);
		if (hit.prompt?.text !== block.prompt) {
			hit.prompt = block.prompt ? { text: block.prompt, lines: new UserMessageComponent(block.prompt).render(width) } : undefined;
		}
		const lines = [...(hit.prompt?.lines ?? [])];
		let body = false;
		for (const { lines: rendered } of hit.sections) {
			let end = rendered.length;
			while (end && !rendered[end - 1].trim()) end--;
			if (!end) continue;
			if (body) lines.push("");
			body = true;
			for (let i = 0; i < end; i++) lines.push(rendered[i]);
		}
		hit.version = block.version;
		hit.lines = lines;
		return lines;
	}

	/** A section as pi's main pane draws it: thinking in the theme's thinking colour, italic, or one line when hidden. */
	private sectionLines(width: number, section: Section): string[] {
		const th = this.theme;
		if (!section.thinking) return new Markdown(section.text, 0, 0, getMarkdownTheme()).render(width);
		if (this.actions.thinkingHidden()) return new Text(th.italic(th.fg("thinkingText", HIDDEN_THINKING_LABEL)), 0, 0).render(width);
		return new Markdown(section.text, 0, 0, getMarkdownTheme(), { color: (t) => th.fg("thinkingText", t), italic: true }).render(width);
	}

	private separatorLines(width: number): string[] {
		if (this.separator?.width !== width) {
			this.separator = { width, lines: ["", getMarkdownTheme().hr("─".repeat(Math.min(width, 80))), ""] };
		}
		return this.separator.lines;
	}

	/**
	 * After a width change, put the line that was on top back on top (see anchor.ts): the block it
	 * is in, and where in that block, found at the old width.
	 */
	private reanchor(width: number, blocks: Block[]) {
		const level = this.level;
		const shown = this.shown;
		if (!shown || shown.width === width || level.follow) return;
		const oldSep = this.separatorLines(shown.width).length;
		let block = shown.start;
		let row = shown.scroll;
		for (; block < blocks.length; block++) {
			const height = this.blockLines(shown.width, blocks[block]).length;
			if (row < height) break;
			row -= height + oldSep;
			// In the separator: the next block's first line goes on top.
			if (row < 0) {
				block++;
				row = 0;
				break;
			}
		}
		if (block >= blocks.length) return;
		const line = lineAnchor(this.blockLines(shown.width, blocks[block]), row);
		const start = Math.min(block, Math.max(0, blocks.length - THREAD_WINDOW));
		const sep = this.separatorLines(width).length;
		let top = 0;
		for (let i = start; i < block; i++) top += this.blockLines(width, blocks[i]).length + sep;
		level.windowStart = start;
		level.scroll = top + anchorRow(this.blockLines(width, blocks[block]), line);
	}

	/**
	 * Render at most THREAD_WINDOW blocks for `height` rows. `scroll` is a line offset into the
	 * window; scrolling above its top slides older blocks in, below its bottom newer ones, keeping
	 * the text on screen in place.
	 */
	private windowedThread(width: number, height: number, parts: Part[]) {
		const level = this.level;
		const { blocks, notice } = this.threadBlocks(parts);
		this.reanchor(width, blocks);
		const n = blocks.length;
		const lastStart = Math.max(0, n - THREAD_WINDOW);
		const sep = this.separatorLines(width);
		const blockHeight = (i: number) => this.blockLines(width, blocks[i]).length + sep.length;
		const build = (start: number) => {
			const end = Math.min(n, start + THREAD_WINDOW);
			const out: string[] = [];
			for (let i = start; i < end; i++) {
				if (i > start) out.push(...sep);
				out.push(...this.blockLines(width, blocks[i]));
			}
			if (notice && end === n) {
				if (out.length) out.push(...sep);
				out.push(...this.blockLines(width, notice));
			}
			return out;
		};

		let start = level.follow ? lastStart : Math.min(Math.max(0, level.windowStart), lastStart);
		let body = build(start);
		for (;;) {
			const maxScroll = Math.max(0, body.length - height);
			if (level.scroll < 0 && start > 0) {
				start--;
				level.scroll += blockHeight(start);
			} else if (level.scroll > maxScroll && start < lastStart) {
				level.scroll -= blockHeight(start);
				start++;
			} else break;
			body = build(start);
		}
		const maxScroll = Math.max(0, body.length - height);
		if (start === lastStart && (level.follow || level.scroll >= maxScroll)) {
			level.scroll = maxScroll;
			level.follow = true;
		}
		level.scroll = Math.min(Math.max(0, level.scroll), maxScroll);
		level.windowStart = start;
		this.shown = { width, start, scroll: level.scroll };

		const end = Math.min(n, start + THREAD_WINDOW);
		const what = level.thread.length ? "" : ` ${level.noun}s`;
		const up = start > 0 ? `↑ ${start} earlier${what}` : level.scroll > 0 ? "↑ PgUp" : "";
		const down = end < n ? `↓ ${n - end} newer${what}` : level.scroll < maxScroll ? "↓ PgDn" : "";
		return { body, note: [up, down].filter(Boolean).join(" · ") };
	}

	// ── Render ─────────────────────────────────────────────────────────────────

	/** Hints for aside-specific keys only, wrapped to at most two lines. */
	private hintLines(inner: number): string[] {
		const th = this.theme;
		const level = this.level;
		const k = (key: string, what: string) => `${th.fg("accent", key)} ${th.fg("dim", what)}`;
		// The open autocomplete list takes esc, as in pi, so its hint would mislead.
		const listOpen = this.input.autocompleteOpen;
		const exitKey = keyText("app.exit");
		const items = this.isTop
			? [
					k("⇧↑↓", level.noun),
					...(level.depth < MAX_DEPTH ? [k("^⇧a", "nested aside")] : []),
					k("^s / ^⇧s", "summary / whole thread & close"),
					...(level.thread.some((e) => e.from) ? [k(keyText("app.tools.expand"), this.actions.expanded() ? "collapse" : "expand")] : []),
					...(level.task && !listOpen ? [k("esc", "stop")] : []),
					k(`${exitKey} (empty box)`, level.depth === 1 ? "close" : `back to aside ${level.depth - 1}`),
				]
			: [th.fg("dim", `aside ${level.depth + 1} is asking about this aside · ${exitKey} there to come back`)];
		const sep = th.fg("dim", " · ");
		const lines: string[] = [];
		let cur = "";
		for (const item of items) {
			const next = cur ? cur + sep + item : item;
			if (cur && visibleWidth(next) > inner) {
				lines.push(cur);
				cur = item;
			} else cur = next;
		}
		if (cur) lines.push(cur);
		return lines.slice(0, 2);
	}

	render(width: number): string[] {
		return this.renderBox(width, this.tui.terminal.rows);
	}

	/** Render exactly `height` rows; the stack view decides each pane's size. */
	renderBox(width: number, height: number): string[] {
		const th = this.theme;
		const level = this.level;
		const parts = this.parts();
		const W = Math.max(20, width);
		const H = Math.max(1, height);
		const inner = W - 4;
		const isTop = this.isTop;
		const b = (t: string) => th.fg(isTop ? "borderAccent" : "borderMuted", t);
		const fit = (t: string) => {
			const tr = truncateToWidth(t, inner);
			return tr + " ".repeat(Math.max(0, inner - visibleWidth(tr)));
		};
		const row = (t: string) => `${b("│")} ${fit(t)} ${b("│")}`;
		const rule = (left: string, label: string, right: string, rightLabel = "") => {
			const l = label ? ` ${label} ` : "";
			const r = rightLabel ? ` ${rightLabel} ` : "";
			const fill = Math.max(0, W - 4 - visibleWidth(l) - visibleWidth(r));
			return b(`${left}─`) + l + b("─".repeat(fill)) + r + b(`─${right}`);
		};

		const total = parts.length;
		const { lo, hi } = selectedRange(level);
		const selection = total ? rangeLabel(lo, hi, total, level.noun) : "";
		const lines: string[] = [];

		// Title, with the selection on the right.
		const name = `Aside ${level.depth} · about ${level.depth === 1 ? "main" : `aside ${level.depth - 1}`}`;
		const title = isTop ? th.bold(th.fg("accent", name)) : th.fg("muted", name);
		lines.push(rule("╭", title, "╮", th.fg(isTop ? "accent" : "muted", selection)));

		// Part list. Short panes keep one hint line and give the rest to the list and thread.
		const hints = this.hintLines(inner).slice(0, H < 18 ? 1 : 2);
		const L = Math.min(total, LIST_MAX_ROWS, Math.max(H < 14 ? 1 : 3, Math.floor((H - 7) * 0.4)));
		if (level.cursor < this.listTop) this.listTop = level.cursor;
		if (level.cursor >= this.listTop + L) this.listTop = level.cursor - L + 1;
		this.listTop = Math.min(Math.max(0, this.listTop), Math.max(0, total - L));
		this.listRows = { start: lines.length, count: L };
		const numWidth = String(total).length;
		for (let r = 0; r < L; r++) {
			const i = this.listTop + r;
			const p = parts[i];
			const selected = i >= lo && i <= hi;
			const marker = selected ? th.fg(isTop ? "accent" : "muted", "▌") : " ";
			const more = r === 0 && this.listTop > 0 ? "↑" : r === L - 1 && this.listTop + L < total ? "↓" : " ";
			let text = truncateToWidth(`${String(p.number).padStart(numWidth)}  ${p.handoff ? HANDOFF_MARKS[p.handoff] : ""}${p.title}`, inner - 3);
			text += " ".repeat(Math.max(0, inner - 3 - visibleWidth(text)));
			if (i === level.cursor && isTop) text = th.bold(text);
			text = selected ? th.bg("selectedBg", text) : th.fg("muted", text);
			lines.push(row(`${marker} ${text}${th.fg("dim", more)}`));
		}

		// Thread header: warns when the next question is about a different selection.
		const lastQuestion = level.thread.findLast((e) => !e.from);
		const header = !level.thread.length
			? th.fg("muted", "Preview")
			: lastQuestion && lastQuestion.rangeKey !== `${lo}-${hi}`
				? th.fg("warning", `next question → ${selection}`)
				: th.fg("muted", "Thread");

		// The parent pane shows its unsent draft on one row, without a cursor.
		const maxInputRows = Math.max(1, Math.min(MAX_INPUT_ROWS, Math.floor((H - lines.length - hints.length - 5) / 2)));
		const box = isTop ? this.input.render(inner, maxInputRows) : { text: [th.fg("dim", `› ${draftPreview(level.draft)}`)], list: [] };
		// The autocomplete list goes under the text, as in pi, in at most half the rows left.
		const list = box.list.slice(0, Math.max(0, Math.floor((H - lines.length - box.text.length - hints.length - 4) / 2)));
		const inputRows = [...box.text, ...list];
		// Header rule, input rule, input and list, hints, bottom border.
		const fixed = lines.length + 1 + 1 + inputRows.length + hints.length + 1;
		const T = Math.max(1, H - fixed);
		this.threadHeight = T;
		const { body, note } = this.windowedThread(inner, T, parts);
		lines.push(rule("├", header, "┤", note ? th.fg("dim", note) : ""));
		for (let r = 0; r < T; r++) lines.push(row(body[level.scroll + r] ?? ""));

		lines.push(rule("├", "", "┤"));
		for (const r of inputRows) lines.push(row(r));
		for (const h of hints) lines.push(row(h));
		lines.push(rule("╰", "", "╯", th.fg("dim", truncateToWidth(this.actions.status(), Math.max(0, W - 6)))));

		// Too short: keep the input and the bottom border, drop thread rows.
		if (lines.length <= H) return lines;
		const tail = 2 + inputRows.length + hints.length;
		if (H <= tail) return lines.slice(-H);
		return [...lines.slice(0, H - tail), ...lines.slice(-tail)];
	}
}
