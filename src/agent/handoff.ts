/**
 * Handing an aside to the level below it (aside 1 to the main conversation, aside N to aside N-1):
 * its thread, summarized by the model or whole, plus what it changed, as one message or entry.
 * Closed without sending (pi's exit key), only what it changed goes down. The aside closes as soon
 * as it hands down; a summary is written afterwards and arrives when it is ready.
 */

import { textOf } from "../context/text.ts";
import { type AsideLevel, addUsage, answerText, type Handoff, handoffTitle, levelThinking, type SentDown } from "../level.ts";
import { changesNote } from "./changes.ts";
import { type AsideEnv, sendToMain, showMainStatus } from "./env.ts";
import { summaryPrompt } from "./prompts.ts";

/** The level's finished exchanges as Markdown, or undefined (with a notice) when it has no answer yet. */
function threadText(level: AsideLevel): { text: string; labels: string } | undefined {
	const answered = level.thread.map((e) => ({ e, answer: answerText(e).trim() })).filter(({ e, answer }) => e.done && answer);
	const questions = answered.filter(({ e }) => !e.from).map(({ e }) => e);
	if (!questions.length) {
		level.notice = "Nothing to send yet. Ask a question first.";
		return undefined;
	}
	const about = level.depth === 1 ? "the main conversation" : `aside ${level.depth - 1}`;
	const text = answered
		.map(({ e, answer }) =>
			e.from
				? `**${handoffTitle(e.from)}:**\n\n${answer}`
				: `**Question** (about ${e.label} of ${about}): ${e.question}\n\n**Answer:**\n\n${answer}`,
		)
		.join("\n\n---\n\n");
	return { text, labels: [...new Set(questions.map((e) => e.label))].join(", ") };
}

/** A closing aside's handoff, taken as it closes. */
interface Outgoing {
	depth: number;
	levelId: number;
	/** The level below; undefined for aside 1, whose handoff goes to the main conversation. */
	to?: AsideLevel;
	/** The list of what the aside changed; undefined when it changed nothing. */
	changes?: string;
}

/**
 * Take `level`'s handoff as it closes. The level below takes its changes over right away, so its own
 * handoff lists them again (a summary may leave them out, and the main conversation always gets the
 * exact list), even when it closes before a summary arrives.
 */
function outgoing(env: AsideEnv, level: AsideLevel): Outgoing {
	const to = env.parentOf(level);
	const changes = level.changes.length ? changesNote(level.changes) : undefined;
	to?.changes.push(...level.changes);
	level.changes = [];
	return { depth: level.depth, levelId: level.id, to, changes };
}

/**
 * Send `text` (empty for "changes") and the changes one level down as one message or entry. Returns
 * whether it arrived right away (false: queued for the main conversation's next turn).
 */
function handDown(env: AsideEnv, out: Outgoing, sent: SentDown, text: string, labels: string): boolean {
	const { to, changes } = out;
	if (!to) {
		const heading =
			sent === "summary"
				? `Summary of a side discussion (aside) about ${labels}:`
				: `Side discussion (aside) about ${labels}, as it happened:`;
		const content = sent === "changes" ? (changes ?? "") : [`${heading}\n\n${text}`, changes].filter(Boolean).join("\n\n---\n\n");
		return sendToMain(env, content);
	}
	const from = { depth: out.depth, levelId: out.levelId, handoff: sent };
	const title = handoffTitle(from);
	to.thread.push({ question: "", rangeKey: "", label: `aside ${out.depth}`, segments: [{ kind: "text", text }], changes, toolCalls: 0, from, done: true });
	to.pendingNotes.push(
		sent === "changes"
			? `${title}, which the user closed without sending its discussion:\n\n${changes}`
			: [`${title}, which the user added to this discussion:\n\n${text}`, changes].filter(Boolean).join("\n\n"),
	);
	to.follow = true;
	to.notice = `${title} added. It goes along with your next question.`;
	return true;
}

/**
 * Deliver `text` one level down and notify the outcome. `instead` says why a summary did not make
 * it, when the whole thread goes down in its place.
 */
function deliver(env: AsideEnv, out: Outgoing, handoff: Handoff, text: string, labels: string, instead?: string) {
	const added = handDown(env, out, handoff, text, labels);
	const where = out.to
		? `added to aside ${out.depth - 1}`
		: added
			? "added to the main conversation"
			: "queued for the main conversation's next turn";
	const message = instead ? `${instead}. Thread ${where} instead.` : `${handoff === "summary" ? "Summary" : "Thread"} ${where}.`;
	if (instead && out.to) out.to.notice = `${instead}. ${out.to.notice}`;
	env.ctx.ui.notify(message, instead ? "warning" : "info");
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** `level` is closing without sending down (pi's exit key): send what it changed, if anything, one level down. */
export function sendChanges(env: AsideEnv, level: AsideLevel) {
	if (level.changes.length) handDown(env, outgoing(env, level), "changes", "", "");
}

/** Send `level`'s whole thread one level down as it is, then `close` it. */
export function sendThread(env: AsideEnv, level: AsideLevel, close: () => void) {
	const thread = threadText(level);
	if (thread) {
		try {
			deliver(env, outgoing(env, level), "thread", thread.text, thread.labels);
		} catch (err) {
			env.ctx.ui.notify(`Sending the thread failed: ${errorText(err)}`, "error");
		}
		close();
	}
	env.render();
}

/**
 * `close` the level and summarize its thread in the background with its model, then deliver the
 * summary one level down. A summary that fails or is stopped (pi's interrupt key in the level below)
 * sends the whole thread instead. Nothing goes down when the level below closes first, or pi quits
 * or switches sessions.
 */
export function summarize(env: AsideEnv, level: AsideLevel, close: () => void) {
	const thread = threadText(level);
	if (!thread) {
		env.render();
		return;
	}
	const out = outgoing(env, level);
	const { model } = level;
	const thinking = levelThinking(level);
	const controller = new AbortController();
	const pending = out.to?.incoming ?? env.toMain;
	pending.add(controller);
	if (!out.to) showMainStatus(env);
	close();
	env.render();

	void (async () => {
		let summary: string | undefined;
		let failure = "Summary stopped";
		try {
			const response = await env.ctx.modelRegistry
				.streamSimple(
					model,
					{
						systemPrompt: summaryPrompt(out.depth),
						messages: [{ role: "user", content: thread.text, timestamp: Date.now() }],
					},
					{ signal: controller.signal, reasoning: model.reasoning && thinking !== "off" ? thinking : undefined },
				)
				.result();
			if (out.to) addUsage(out.to, response.usage);
			if (response.stopReason === "error") throw new Error(response.errorMessage || "summary request failed");
			if (response.stopReason !== "aborted") {
				summary = textOf(response.content).trim();
				if (!summary) throw new Error("the model returned an empty summary");
			}
		} catch (err) {
			if (!controller.signal.aborted) failure = `Summary failed: ${errorText(err)}`;
		}
		// Removed when the level below closed or pi quit or switched sessions: nothing goes down.
		if (!pending.delete(controller)) return;
		try {
			if (!out.to) showMainStatus(env);
			if (summary) deliver(env, out, "summary", summary, thread.labels);
			else deliver(env, out, "thread", thread.text, thread.labels, failure);
		} catch (err) {
			env.ctx.ui.notify(`Sending the summary of aside ${out.depth} failed: ${errorText(err)}`, "error");
		}
		env.render();
	})();
}
