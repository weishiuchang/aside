/** One aside in the stack: what it asks about, its selection, thread, session, and usage. In memory only. */

import { clampThinkingLevel, type Usage } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { Change } from "./agent/changes.ts";
import { closeSession } from "./agent/session.ts";
import type { Noun, Part } from "./context/parts.ts";
import type { Model, ThinkingLevel } from "./types.ts";

/** What a nested aside sends down: a summary of its thread, or the whole thread as it is. */
export type Handoff = "summary" | "thread";

/** What reaches the level below when an aside closes: a handoff, or only its changes (closed with pi's exit key). */
export type SentDown = Handoff | "changes";

const SENT_TITLES: Record<SentDown, string> = { summary: "Summary", thread: "Thread", changes: "Changes" };

/** The title of what a nested aside sent down, e.g. "Summary from aside 2". */
export function handoffTitle(from: NonNullable<Exchange["from"]>): string {
	return `${SENT_TITLES[from.handoff]} from aside ${from.depth}`;
}

/** A run of answer text (tool-call lines included) or of the model's thinking, in streamed order. */
export interface Segment {
	kind: "text" | "thinking";
	text: string;
}

/** A question and its answer, or what a nested aside sent down to this level. */
export interface Exchange {
	question: string;
	/** The selection the question was about, as "lo-hi". */
	rangeKey: string;
	/** The selection in words, e.g. "turns 2–4". */
	label: string;
	/** The streamed answer: text with a line per tool call, and thinking, in order. */
	segments: Segment[];
	toolCalls: number;
	/** Set on what a nested aside sent down: which aside, and what it sent. */
	from?: { depth: number; levelId: number; handoff: SentDown };
	/** On what a nested aside sent down: the list of what it changed, kept apart from the answer. */
	changes?: string;
	done?: boolean;
	error?: string;
	aborted?: boolean;
}

/** Add streamed `text` to the answer, continuing the last segment when it is the same kind. */
export function appendAnswer(ex: Exchange, kind: Segment["kind"], text: string) {
	const last = ex.segments[ex.segments.length - 1];
	if (last?.kind === kind) last.text += text;
	else ex.segments.push({ kind, text });
}

/** The answer without thinking: what the thread hands on (nested asides, handoffs). */
export function answerText(ex: Exchange): string {
	return ex.segments
		.filter((s) => s.kind === "text")
		.map((s) => s.text)
		.join("");
}

/** Changes whenever the answer grows: segments only ever grow at the end. */
export function answerVersion(ex: Exchange): string {
	return `${ex.segments.length}:${ex.segments[ex.segments.length - 1]?.text.length ?? 0}`;
}

export interface UsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

export interface AsideLevel {
	id: number;
	/** 1 asks about the main conversation; N asks about aside N-1. */
	depth: number;
	noun: Noun;
	/**
	 * This level's own model and thinking level: copied from the level below when it opens (aside 1
	 * from the main conversation), then changed only by `/model` and `/thinking` here.
	 */
	model: Model;
	thinking: ThinkingLevel;
	/** What this level can ask about, read live. */
	parts: () => Part[];
	/** Selection: the range between anchor and cursor. */
	anchor: number;
	cursor: number;
	/** Part count at the last sync, to notice new parts. */
	partCount: number;
	thread: Exchange[];
	/** Unsent question text. */
	draft: string;
	/** Line offset into the rendered thread window. */
	scroll: number;
	/** First exchange (or previewed part) in the thread window. */
	windowStart: number;
	/** Keep the thread on the latest output. */
	follow: boolean;
	/** The agent session this level answers through, started when the level opens. */
	session?: Promise<AgentSession>;
	/** The selection the session last got as focus; a follow-up resends focus only when it changed. */
	sentFocus?: string;
	/** What nested asides sent down, as prompt sections for this level's next question. */
	pendingNotes: string[];
	/** What this level and nested asides closed on it changed, not yet sent to the level below. */
	changes: Change[];
	/**
	 * The answer, the check of its commands, or the summary in flight. `unsettled` is what it may have
	 * changed that is not in `changes` yet, for when the aside closes before it ends.
	 */
	task?: { kind: "answer" | "check" | "summary"; controller: AbortController; unsettled?: () => Change[] };
	/** The aside closed: work still winding down must not start anything new. */
	discarded: boolean;
	/** Every model call this level made (answers and summaries). */
	usage: UsageTotals;
	/** Status line under the thread. */
	notice?: string;
}

let nextLevelId = 1;

/** A level with the latest part selected, starting with the given model and thinking level. */
export function createLevel(depth: number, parts: () => Part[], model: Model, thinking: ThinkingLevel): AsideLevel {
	const count = parts().length;
	return {
		id: nextLevelId++,
		depth,
		noun: depth === 1 ? "turn" : "exchange",
		model,
		thinking,
		parts,
		anchor: count - 1,
		cursor: count - 1,
		partCount: count,
		thread: [],
		draft: "",
		scroll: 0,
		windowStart: 0,
		follow: true,
		pendingNotes: [],
		changes: [],
		discarded: false,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
	};
}

/** The level's thinking level, limited to what its model supports. */
export function levelThinking(level: AsideLevel): ThinkingLevel {
	return clampThinkingLevel(level.model, level.thinking);
}

/** Stop whatever the level is doing and release its session. */
export function discardLevel(level: AsideLevel) {
	level.discarded = true;
	level.task?.controller.abort();
	level.session?.then(closeSession).catch(() => {});
	level.session = undefined;
}

/**
 * Keep the selection valid for `count` parts. A selection on the latest part follows new parts;
 * any other selection stays put.
 */
export function syncSelection(level: AsideLevel, count: number) {
	if (count !== level.partCount) {
		const onLatest = level.anchor === level.cursor && level.cursor === level.partCount - 1;
		if (onLatest || count < level.partCount) {
			level.anchor = level.cursor = count - 1;
		}
		level.partCount = count;
	}
	level.anchor = Math.min(Math.max(0, level.anchor), count - 1);
	level.cursor = Math.min(Math.max(0, level.cursor), count - 1);
}

export function selectedRange(level: AsideLevel): { lo: number; hi: number } {
	return { lo: Math.min(level.anchor, level.cursor), hi: Math.max(level.anchor, level.cursor) };
}

export function addUsage(level: AsideLevel, usage: Usage | undefined) {
	if (!usage) return;
	const u = level.usage;
	u.input += usage.input;
	u.output += usage.output;
	u.cacheRead += usage.cacheRead;
	u.cacheWrite += usage.cacheWrite;
	u.cost += usage.cost.total;
}

const tokens = (n: number) =>
	n < 1000 ? `${n}` : n < 10_000 ? `${(n / 1000).toFixed(1)}k` : n < 1_000_000 ? `${Math.round(n / 1000)}k` : `${(n / 1_000_000).toFixed(1)}M`;

/**
 * Usage in pi's footer notation, cost first so a narrow border keeps it: "$0.081 ↑4 ↓80 R40k W14k".
 * Empty before any call.
 */
export function usageLabel({ input, output, cacheRead, cacheWrite, cost }: UsageTotals): string {
	if (!input && !output && !cacheRead && !cacheWrite) return "";
	const parts = [`$${cost.toFixed(3)}`, `↑${tokens(input)}`, `↓${tokens(output)}`];
	if (cacheRead) parts.push(`R${tokens(cacheRead)}`);
	if (cacheWrite) parts.push(`W${tokens(cacheWrite)}`);
	return parts.join(" ");
}
