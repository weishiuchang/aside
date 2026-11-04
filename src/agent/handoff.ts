/**
 * Handing an aside to the level below it (aside 1 to the main conversation, aside N to aside N-1):
 * its thread, summarized by the model or whole, plus what it changed, as one message or entry.
 * Closed without sending (pi's exit key), only what it changed goes down.
 */

import { textOf } from "../context/text.ts";
import { type AsideLevel, addUsage, answerText, type Handoff, handoffTitle, levelThinking, type SentDown } from "../level.ts";
import { changesNote } from "./changes.ts";
import { type AsideEnv, sendToMain } from "./env.ts";
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

/**
 * Send `text` (empty for "changes") and `level`'s changes one level down as one message or entry.
 * The changes also move into the level below, so its own handoff lists them again: a summary may
 * leave them out, and the main conversation always gets the exact list. Returns whether it arrived
 * right away (false: queued for the main conversation's next turn).
 */
function handDown(env: AsideEnv, level: AsideLevel, sent: SentDown, text: string, labels: string): boolean {
	const changes = level.changes.length ? changesNote(level.changes) : undefined;
	const parent = level.depth === 1 ? undefined : env.parentOf(level);
	if (level.depth > 1 && !parent) throw new Error(`aside ${level.depth - 1} is no longer open`);
	let added = true;
	if (!parent) {
		const heading =
			sent === "summary"
				? `Summary of a side discussion (aside) about ${labels}:`
				: `Side discussion (aside) about ${labels}, as it happened:`;
		const content = sent === "changes" ? (changes ?? "") : [`${heading}\n\n${text}`, changes].filter(Boolean).join("\n\n---\n\n");
		added = sendToMain(env, content);
	} else {
		const from = { depth: level.depth, levelId: level.id, handoff: sent };
		const title = handoffTitle(from);
		parent.thread.push({ question: "", rangeKey: "", label: `aside ${level.depth}`, segments: [{ kind: "text", text }], changes, toolCalls: 0, from, done: true });
		parent.pendingNotes.push(
			sent === "changes"
				? `${title}, which the user closed without sending its discussion:\n\n${changes}`
				: [`${title}, which the user added to this discussion:\n\n${text}`, changes].filter(Boolean).join("\n\n"),
		);
		parent.changes.push(...level.changes);
		parent.follow = true;
		parent.notice = `${title} added. It goes along with your next question.`;
	}
	level.changes = [];
	return added;
}

/** Deliver `text` one level down and set the level's notice to the outcome. */
function deliver(env: AsideEnv, level: AsideLevel, handoff: Handoff, text: string, labels: string) {
	const what = handoff === "summary" ? "Summary" : "Thread";
	const added = handDown(env, level, handoff, text, labels);
	if (level.depth === 1) {
		level.notice = added ? `${what} added to the main conversation.` : `${what} queued for the main conversation's next turn.`;
	} else {
		level.notice = `${what} added to aside ${level.depth - 1}.`;
	}
	env.ctx.ui.notify(level.notice, "info");
}

/** `level` is closing without sending down (pi's exit key): send what it changed, if anything, one level down. */
export function sendChanges(env: AsideEnv, level: AsideLevel) {
	if (level.changes.length) handDown(env, level, "changes", "", "");
}

/** Send `level`'s whole thread one level down as it is, then run `onDelivered` (the caller closes the level). */
export function sendThread(env: AsideEnv, level: AsideLevel, onDelivered: () => void) {
	const thread = threadText(level);
	if (thread) {
		try {
			deliver(env, level, "thread", thread.text, thread.labels);
			onDelivered();
		} catch (err) {
			level.notice = `Sending the thread failed: ${err instanceof Error ? err.message : String(err)}`;
		}
	}
	env.render();
}

/**
 * Summarize `level`'s thread and deliver it one level down. `onDelivered` runs once it arrived (the
 * caller closes the level); after a failure or a stop the level stays open with a notice.
 */
export function summarize(env: AsideEnv, level: AsideLevel, onDelivered: () => void) {
	const thread = threadText(level);
	if (!thread) {
		env.render();
		return;
	}

	const controller = new AbortController();
	level.task = { kind: "summary", controller };
	level.notice = undefined;
	level.follow = true;
	env.render();

	void (async () => {
		let delivered = false;
		try {
			const thinking = levelThinking(level);
			const response = await env.ctx.modelRegistry
				.streamSimple(
					level.model,
					{
						systemPrompt: summaryPrompt(level.depth),
						messages: [{ role: "user", content: thread.text, timestamp: Date.now() }],
					},
					{ signal: controller.signal, reasoning: level.model.reasoning && thinking !== "off" ? thinking : undefined },
				)
				.result();
			addUsage(level, response.usage);
			if (response.stopReason === "aborted") {
				level.notice = "Summary cancelled.";
				return;
			}
			if (response.stopReason === "error") throw new Error(response.errorMessage || "summary request failed");
			const summary = textOf(response.content).trim();
			if (!summary) throw new Error("the model returned an empty summary");
			deliver(env, level, "summary", summary, thread.labels);
			delivered = true;
		} catch (err) {
			level.notice = controller.signal.aborted
				? "Summary cancelled."
				: `Summary failed: ${err instanceof Error ? err.message : String(err)}`;
		} finally {
			if (level.task?.controller === controller) level.task = undefined;
			if (delivered) onDelivered();
			env.render();
		}
	})();
}
