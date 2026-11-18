/** One aside in the stack: what it asks about, its selection, thread, session, and usage. In memory only. */

import { clampThinkingLevel, type Usage } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { Change } from "./agent/changes.ts";
import { closeSession } from "./agent/session.ts";
import type { Noun, Part } from "./context/parts.ts";
import type { Model, ThinkingLevel } from "./types.ts";
import type { ToolCall } from "./ui/tool-call.ts";

/** What a nested aside sends down: a summary of its thread, or the whole thread as it is. */
export type Handoff = "summary" | "thread";

/** What reaches the level below when an aside closes: a handoff, or only its changes (closed with pi's exit key). */
export type SentDown = Handoff | "changes";

const SENT_TITLES: Record<SentDown, string> = { summary: "Summary", thread: "Thread", changes: "Changes" };

/** The title of what a nested aside sent down, e.g. "Summary from aside 2". */
export function handoffTitle(from: NonNullable<Exchange["from"]>): string {
	return `${SENT_TITLES[from.handoff]} from aside ${from.depth}`;
}

/**
 * A run of answer text or of the model's thinking, or one tool call, in streamed order. A tool
 * call's `text` is its one-line form, which the thread hands on; it is set once the call starts.
 */
export type Segment = { kind: "text" | "thinking"; text: string } | { kind: "tool"; text: string; call: ToolCall };

/** A question and its answer, or what a nested aside sent down to this level. */
export interface Exchange {
	question: string;
	/** The selection the question was about, as "lo-hi". */
	rangeKey: string;
	/** The selection in words, e.g. "turns 2–4". */
	label: string;
	/** The streamed answer: text, tool calls, and thinking, in order. */
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
export function appendAnswer(ex: Exchange, kind: "text" | "thinking", text: string) {
	const last = ex.segments[ex.segments.length - 1];
	if (last?.kind === kind) last.text += text;
	else ex.segments.push({ kind, text });
}

/** The answer without thinking, with a line per tool call: what the thread hands on (nested asides, handoffs). */
export function answerText(ex: Exchange): string {
	return ex.segments
		.filter((s) => s.kind !== "thinking")
		.map((s) => s.text)
		.join("");
}

/**
 * Changes whenever the answer's text grows: segments only ever grow at the end, and a tool call's
 * line is set when it starts, which counts it. Tool calls redraw on their own (pane.ts).
 */
export function answerVersion(ex: Exchange): string {
	return `${ex.segments.length}:${ex.segments[ex.segments.length - 1]?.text.length ?? 0}:${ex.toolCalls}`;
}

/** A question typed in the box, and the selection it asks about. */
export interface Question {
	/** What was typed, which the thread shows. */
	text: string;
	/** What the model gets: `text` with a skill or prompt template expanded. */
	expanded: string;
	lo: number;
	hi: number;
}

/**
 * A question typed while the level was busy, queued as pi's main pane queues a prompt: a steer
 * (enter) goes into the running answer after its current tool calls, a follow-up (pi's follow-up
 * key) is asked once the answer ends.
 */
export interface Queued {
	mode: "steer" | "followUp";
	question: Question;
	/**
	 * Set once a steer is in the answering session's queue: the prompt it went in as, what building
	 * it took from the level (its notes, the focus before it), and the call that queued it.
	 */
	sent?: { prompt: string; notes: string[]; focus: string | undefined; queued: Promise<void> };
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
	 * The answer or the check of its commands in flight. `unsettled` is what it may have changed that
	 * is not in `changes` yet, for when the aside closes before it ends. `session` is the answering
	 * session once its run started, which steers go into.
	 */
	task?: { kind: "answer" | "check"; controller: AbortController; unsettled?: () => Change[]; session?: AgentSession };
	/**
	 * Questions typed while the level was busy, in the order typed. A steer goes into the answer once
	 * it streams and no summary of a nested aside is on its way; anything else waits here until the
	 * level is free and is then asked, the first one first.
	 */
	queue: Queued[];
	/**
	 * Summaries of nested asides closed on this level, still being written; each arrives as an entry
	 * in the thread. Removed from here when the level closes, so they send nothing.
	 */
	incoming: Set<AbortController>;
	/** The aside closed: work still winding down must not start anything new. */
	discarded: boolean;
	/** Every model call this level made, and the summaries of nested asides closed on it. */
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
		queue: [],
		changes: [],
		incoming: new Set(),
		discarded: false,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
	};
}

/** The level's thinking level, limited to what its model supports. */
export function levelThinking(level: AsideLevel): ThinkingLevel {
	return clampThinkingLevel(level.model, level.thinking);
}

/** Whether the level is answering, checking commands, or waiting for a nested aside's summary. */
export function isBusy(level: AsideLevel): boolean {
	return !!level.task || level.incoming.size > 0;
}

/**
 * Steers that left the answering session's queue undelivered: what building them took goes back to
 * the level, so they can be built again. Steers are delivered in the order sent, so these are the
 * last ones sent, and the focus before the first of them is the focus the model last got.
 */
export function unsend(level: AsideLevel, entries: Queued[]) {
	const sent = entries.flatMap((q) => (q.sent ? [q.sent] : []));
	if (!sent.length) return;
	level.sentFocus = sent[0].focus;
	level.pendingNotes = [...sent.flatMap((s) => s.notes), ...level.pendingNotes];
	for (const q of entries) q.sent = undefined;
}

/**
 * Take every queued question back out of the queue (and the answering session's queue), as pi's
 * main pane does to put them back into its editor: steers first, then follow-ups, as pi lists them.
 */
export function takeQueue(level: AsideLevel): string[] {
	const queue = level.queue;
	level.queue = [];
	if (queue.some((q) => q.sent)) {
		level.task?.session?.clearQueue();
		unsend(level, queue);
	}
	return [...queue.filter((q) => q.mode === "steer"), ...queue.filter((q) => q.mode === "followUp")].map((q) => q.question.text);
}

/** Stop everything streaming at the level (pi's interrupt key); stopped summaries still arrive, as whole threads. */
export function stopStreaming(level: AsideLevel) {
	level.task?.controller.abort();
	for (const controller of level.incoming) controller.abort();
}

/** Stop whatever the level is doing, drop the summaries still coming to it, and release its session. */
export function discardLevel(level: AsideLevel) {
	level.discarded = true;
	const incoming = [...level.incoming];
	level.incoming.clear();
	level.task?.controller.abort();
	for (const controller of incoming) controller.abort();
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
