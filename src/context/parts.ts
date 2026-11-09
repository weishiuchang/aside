/**
 * Parts are what an aside asks about: aside 1 asks about turns of the main conversation, aside N
 * about the exchanges of aside N-1.
 */

import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { BRIEF_PROMPT_MAX_CHARS, BRIEF_REPLY_MAX_CHARS, TOOL_ARGS_MAX_CHARS, TOOL_RESULT_MAX_CHARS } from "../config.ts";
import { answerText, answerVersion, type Exchange, handoffTitle, type SentDown } from "../level.ts";
import { clip, oneLine, plural, textOf } from "./text.ts";

export interface Part {
	/** 1-based display number. */
	number: number;
	title: string;
	/** The user's prompt, or the aside question. */
	prompt: string;
	/** The agent's reply, or the aside answer. */
	reply: string;
	toolCalls: number;
	/** Full text, for focus. */
	full: string;
	/** Short text, for background. */
	brief: string;
	/** Set on what a nested aside sent down. */
	handoff?: SentDown;
}

export type Noun = "turn" | "exchange";

/**
 * Split the main conversation branch into turns: a user prompt and everything up to the next one.
 * A turn whose entries are unchanged (same first and last entry, same number) is taken from `reuse`,
 * so only new turns and the one still growing are parsed, and unchanged turns keep their object
 * (and the pane its rendered preview). `reuse` is updated to the turns returned.
 */
export function turnsFromBranch(entries: SessionEntry[], reuse: Map<string, Part>): Part[] {
	const groups: SessionEntry[][] = [];
	for (const e of entries) {
		const prompt = e.type === "message" && (e.message as { role?: string }).role === "user";
		if (prompt || !groups.length) groups.push([]);
		groups[groups.length - 1].push(e);
	}
	const parts: Part[] = [];
	const used = new Map<string, Part>();
	for (const group of groups) {
		const key = `${parts.length + 1}|${group[0].id}|${group[group.length - 1].id}`;
		const part = reuse.get(key) ?? turnPart(group, parts.length + 1);
		if (!part) continue;
		used.set(key, part);
		parts.push(part);
	}
	reuse.clear();
	for (const [key, part] of used) reuse.set(key, part);
	return parts;
}

/** One turn from its entries, which start with its prompt (none before the first prompt); undefined when empty. */
function turnPart(entries: SessionEntry[], number: number): Part | undefined {
	let prompt = "";
	const replies: string[] = [];
	const full: string[] = [];
	let toolCalls = 0;
	for (const e of entries) {
		if (e.type === "message") {
			// biome-ignore lint/suspicious/noExplicitAny: AgentMessage is an extensible union
			const m = e.message as any;
			switch (m.role) {
				case "user":
					prompt = textOf(m.content);
					full.push(`USER:\n${prompt}`);
					break;
				case "assistant": {
					const t = textOf(m.content);
					if (t.trim()) {
						replies.push(t);
						full.push(`ASSISTANT:\n${t}`);
					}
					for (const c of Array.isArray(m.content) ? m.content : []) {
						if (c?.type !== "toolCall") continue;
						toolCalls++;
						full.push(`TOOL CALL ${c.name}: ${clip(argsText(c.arguments), TOOL_ARGS_MAX_CHARS)}`);
					}
					break;
				}
				case "toolResult":
					full.push(`TOOL RESULT (${m.toolName}${m.isError ? ", error" : ""}):\n${clip(textOf(m.content), TOOL_RESULT_MAX_CHARS)}`);
					break;
				case "bashExecution":
					full.push(`USER RAN SHELL COMMAND: $ ${m.command}\n${clip(String(m.output ?? ""), TOOL_RESULT_MAX_CHARS)}`);
					break;
				case "custom": {
					const t = textOf(m.content);
					if (t.trim()) full.push(`[${m.customType}]\n${clip(t, TOOL_RESULT_MAX_CHARS)}`);
					break;
				}
			}
		} else if (e.type === "custom_message") {
			const t = textOf(e.content);
			if (t.trim()) full.push(`[${e.customType}]\n${clip(t, TOOL_RESULT_MAX_CHARS)}`);
		} else if (e.type === "branch_summary") {
			full.push(`SUMMARY OF AN ABANDONED BRANCH:\n${e.summary}`);
		}
		// Compaction entries are skipped: the branch still holds the raw entries they summarize.
	}
	if (!prompt.trim() && !full.length) return undefined;
	const reply = replies.join("\n\n");
	const brief = [`USER: ${clip(prompt, BRIEF_PROMPT_MAX_CHARS)}`];
	if (reply) brief.push(`ASSISTANT: ${clip(reply, BRIEF_REPLY_MAX_CHARS)}`);
	if (toolCalls) brief.push(`(${plural(toolCalls, "tool call")} omitted)`);
	return {
		number,
		title: oneLine(prompt.split("\n").find((l) => l.trim()) ?? "") || "(no prompt text)",
		prompt,
		reply,
		toolCalls,
		full: full.join("\n\n"),
		brief: brief.join("\n"),
	};
}

/** Tool arguments as JSON, long strings cut first: a write's whole content is never serialized only to be clipped. */
function argsText(args: unknown): string {
	return JSON.stringify(args ?? {}, (_k, v) => (typeof v === "string" && v.length > TOOL_ARGS_MAX_CHARS ? `${v.slice(0, TOOL_ARGS_MAX_CHARS)}…` : v));
}

/**
 * Parts built from exchanges, reused while an exchange is unchanged: the pane reads parts on every
 * render, and an unchanged part keeps its rendered preview.
 */
const exchangeParts = new WeakMap<Exchange, { key: string; part: Part }>();

/** An aside's thread as parts a nested aside asks about, leaving out what `levelId` sent down. */
export function partsFromThread(thread: Exchange[], levelId: number): Part[] {
	const parts: Part[] = [];
	for (const ex of thread) {
		if (ex.from?.levelId === levelId) continue;
		const number = parts.length + 1;
		const key = `${number}|${answerVersion(ex)}|${ex.done}`;
		let hit = exchangeParts.get(ex);
		if (hit?.key !== key) {
			hit = { key, part: exchangePart(ex, number) };
			exchangeParts.set(ex, hit);
		}
		parts.push(hit.part);
	}
	return parts;
}

function exchangePart(ex: Exchange, number: number): Part {
	if (ex.from) {
		const title = handoffTitle(ex.from);
		const answer = sentDownText(ex);
		return {
			number,
			title,
			prompt: "",
			reply: answer,
			toolCalls: 0,
			full: `${title.toUpperCase()}:\n${answer}`,
			brief: `${title.toUpperCase()}: ${clip(answer, BRIEF_REPLY_MAX_CHARS)}`,
			handoff: ex.from.handoff,
		};
	}
	const answer = answerText(ex).trim() || (ex.done ? "" : "(answer still streaming)");
	return {
		number,
		title: oneLine(ex.question) || "(no question)",
		prompt: ex.question,
		reply: answer,
		toolCalls: ex.toolCalls,
		full: `QUESTION (about ${ex.label}):\n${ex.question}\n\nANSWER:\n${answer}`,
		brief: `QUESTION (about ${ex.label}): ${clip(ex.question, BRIEF_PROMPT_MAX_CHARS)}\nANSWER: ${clip(answer, BRIEF_REPLY_MAX_CHARS * 2)}`,
	};
}

/** What a nested aside sent down, in full: its summary or thread, then the list of what it changed. */
export function sentDownText(ex: Exchange): string {
	return [answerText(ex).trim(), ex.changes].filter(Boolean).join("\n\n---\n\n");
}

/** "turn 3", "turns 2–5", "all 7 turns". */
export function rangeLabel(lo: number, hi: number, total: number, noun: Noun): string {
	if (lo === 0 && hi === total - 1 && total > 1) return `all ${total} ${noun}s`;
	return lo === hi ? `${noun} ${lo + 1}` : `${noun}s ${lo + 1}–${hi + 1}`;
}
