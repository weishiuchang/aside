/**
 * Asking a question at one aside level, through the level's agent session, and the questions typed
 * while the level is busy, queued as pi's main pane queues prompts: steers go into the running
 * answer, everything else is asked once the level is free.
 */

import type { AgentSession, ToolInfo, ToolRenderers } from "@earendil-works/pi-coding-agent";
import { NESTED_MAIN_MAX_CHARS } from "../config.ts";
import { backgroundBlock, focusBlock } from "../context/blocks.ts";
import { type Part, rangeLabel } from "../context/parts.ts";
import { textOf } from "../context/text.ts";
import {
	type AsideLevel,
	addUsage,
	appendAnswer,
	type Exchange,
	isBusy,
	levelThinking,
	type Question,
	type Queued,
	type Segment,
	unsend,
} from "../level.ts";
import { type Change, changeOf, toolCallLine } from "./changes.ts";
import { commandChanges, type RanCommand, unchecked } from "./command-check.ts";
import type { AsideEnv } from "./env.ts";
import { applyModel, applyTools, levelSession } from "./session.ts";

/** Context sent with a level's first question. */
function firstContext(env: AsideEnv, level: AsideLevel, parts: Part[], lo: number, hi: number): string[] {
	const focus = focusBlock(parts, lo, hi, level.noun);
	if (level.depth === 1) return [backgroundBlock(parts, lo, hi, "turn"), focus];
	// Nested: the main conversation and the aside below, not the levels in between.
	const main = env.mainTurns();
	return [
		backgroundBlock(main, main.length, main.length, "turn", "main_conversation", NESTED_MAIN_MAX_CHARS),
		backgroundBlock(parts, lo, hi, "exchange", "parent_aside"),
		focus,
	];
}

/** The question's selection, kept within the parts there are now. */
function rangeOf(q: Question, count: number): { lo: number; hi: number } {
	const hi = Math.min(q.hi, count - 1);
	return { lo: Math.min(q.lo, hi), hi };
}

/**
 * The text sent for a question: what nested asides sent down, then context or changed focus, then
 * the question. The level's notes go with it, and its selection becomes the focus sent.
 */
function buildPrompt(env: AsideEnv, level: AsideLevel, parts: Part[], q: Question): string {
	const { lo, hi } = rangeOf(q, parts.length);
	const sections = [...level.pendingNotes];
	level.pendingNotes = [];
	const rangeKey = `${lo}-${hi}`;
	if (level.sentFocus === undefined) sections.push(...firstContext(env, level, parts, lo, hi));
	else if (level.sentFocus !== rangeKey) sections.push(`The focus has changed.\n\n${focusBlock(parts, lo, hi, level.noun)}`);
	level.sentFocus = rangeKey;
	sections.push(sections.length ? `Question: ${q.expanded}` : q.expanded);
	return sections.filter(Boolean).join("\n\n");
}

/** Add the exchange for `q` to the end of the level's thread. */
function startExchange(level: AsideLevel, parts: Part[], q: Question): Exchange {
	const { lo, hi } = rangeOf(q, parts.length);
	const ex: Exchange = { question: q.text, rangeKey: `${lo}-${hi}`, label: rangeLabel(lo, hi, parts.length, level.noun), segments: [], toolCalls: 0 };
	level.thread.push(ex);
	level.follow = true;
	return ex;
}

/** A tool's renderers in `session`, as pi's main pane looks them up; none when an extension's lookup throws. */
function renderersOf(session: AgentSession, name: string): ToolRenderers | undefined {
	try {
		return session.extensionRunner.resolveToolRenderers(name, () => session.getToolDefinition(name));
	} catch {
		return undefined;
	}
}

/**
 * Ask `q` at `level`. Steers queued meanwhile go into the answer; each one the session delivers
 * starts an exchange of its own, which the answer continues in.
 */
export function ask(env: AsideEnv, level: AsideLevel, q: Question) {
	const parts = level.parts();
	if (!parts.length) return;
	const prompt = buildPrompt(env, level, parts, q);
	let ex = startExchange(level, parts, q);
	// The exchanges this answer covers: the question's, then one per steer it took.
	const run = [ex];
	level.notice = undefined;
	// What this answer may have changed; listed for the level below when this aside closes. Shell
	// commands are judged together once the answer ends.
	const commands = new Map<string, RanCommand>();
	// Tool calls started and not ended yet.
	const running = new Map<string, { name: string; args: unknown }>();
	// Tool calls shown and not ended yet, from the first streamed arguments on, as in pi's main pane.
	const pending = new Map<string, Extract<Segment, { kind: "tool" }>>();
	let toolInfo = new Map<string, ToolInfo>();
	// Closed mid-answer: calls still running count as done, and no command gets checked.
	const unsettled = () => [
		...[...running.values()].flatMap((t) => (t.name === "bash" ? [] : (changeOf(t.name, t.args, false, toolInfo.get(t.name)) ?? []))),
		...unchecked([...commands.values()]),
	];
	const controller = new AbortController();
	const task: NonNullable<AsideLevel["task"]> = { kind: "answer", controller, unsettled };
	level.task = task;
	env.render();

	let warned = false;
	const record = (change: Change | undefined) => {
		if (!change) return;
		if (change.kind === "local" && !warned && !env.ctx.isIdle()) {
			warned = true;
			appendAnswer(ex, "text", "_The main agent is working right now and may be changing the same files._\n\n");
		}
		level.changes.push(change);
	};

	void (async () => {
		let unsubscribe: (() => void) | undefined;
		try {
			const session = await levelSession(env.ctx.cwd, level);
			if (controller.signal.aborted) throw new Error("aborted");
			await applyModel(session, level.model, levelThinking(level));
			applyTools(session, env.pi);

			toolInfo = new Map(session.getAllTools().map((t) => [t.name, t]));
			const toolCall = (id: string, name: string, args: unknown) => {
				let segment = pending.get(id);
				if (!segment) {
					segment = { kind: "tool", text: "", call: env.toolCall(name, id, args, renderersOf(session, name)) };
					ex.segments.push(segment);
					pending.set(id, segment);
				}
				return segment;
			};
			let prompted = false;
			unsubscribe = session.subscribe((ev) => {
				switch (ev.type) {
					case "agent_start":
						// The answer runs: steers queued meanwhile can go into it.
						task.session = session;
						drainQueue(env, level);
						break;
					case "message_start": {
						if (ev.message.role !== "user") break;
						// The first user message is the question; later ones are steers the session delivers.
						if (!prompted) {
							prompted = true;
							break;
						}
						const steer = takeDelivered(level, textOf(ev.message.content));
						if (!steer) break;
						if (!ex.error) ex.done = true;
						ex = startExchange(level, level.parts(), steer.question);
						run.push(ex);
						env.render();
						break;
					}
					case "message_update":
						if (ev.message.role === "assistant") {
							for (const c of ev.message.content) {
								if (c.type !== "toolCall") continue;
								if (pending.has(c.id)) pending.get(c.id)?.call.updateArgs(c.arguments);
								else toolCall(c.id, c.name, c.arguments);
							}
						}
						switch (ev.assistantMessageEvent.type) {
							case "text_delta":
								appendAnswer(ex, "text", ev.assistantMessageEvent.delta);
								break;
							case "thinking_delta":
								appendAnswer(ex, "thinking", ev.assistantMessageEvent.delta);
								break;
						}
						env.render();
						break;
					case "message_end":
						if (ev.message.role !== "assistant") break;
						addUsage(level, ev.message.usage);
						// As pi's main pane: a failed or stopped message fails the calls it was streaming.
						if (ev.message.stopReason === "aborted" || ev.message.stopReason === "error") {
							const text = ev.message.stopReason === "aborted" ? "Operation aborted" : ev.message.errorMessage || "Error";
							for (const { call } of pending.values()) call.updateResult({ content: [{ type: "text", text }], isError: true });
							pending.clear();
						} else for (const { call } of pending.values()) call.setArgsComplete();
						// A stop shows as "(stopped)", not as the provider's error for it.
						if (ev.message.stopReason === "error" && !controller.signal.aborted) {
							ex.error ??= ev.message.errorMessage || "request failed";
						}
						env.render();
						break;
					case "tool_execution_start":
						running.set(ev.toolCallId, { name: ev.toolName, args: ev.args });
						if (ev.toolName === "bash" && typeof (ev.args as { command?: unknown })?.command === "string") {
							commands.set(ev.toolCallId, { command: (ev.args as { command: string }).command });
						}
						// Nested calls (from code that calls tools) show inside their parent's row, as in pi.
						if (!ev.parentToolCallId) {
							const segment = toolCall(ev.toolCallId, ev.toolName, ev.args);
							segment.text = `\n\n\`${toolCallLine(ev.toolName, ev.args)}\`\n\n`;
							ex.toolCalls++;
							segment.call.markExecutionStarted();
							env.render();
						}
						break;
					case "tool_execution_update":
						pending.get(ev.toolCallId)?.call.updateResult({ ...ev.partialResult, isError: false }, true);
						env.render();
						break;
					case "tool_execution_end": {
						pending.get(ev.toolCallId)?.call.updateResult({ ...ev.result, isError: ev.isError, durationMs: ev.durationMs });
						pending.delete(ev.toolCallId);
						const ran = commands.get(ev.toolCallId);
						if (ran) {
							ran.output = textOf(ev.result?.content);
							ran.isError = ev.isError;
						}
						const args = running.get(ev.toolCallId)?.args;
						running.delete(ev.toolCallId);
						record(changeOf(ev.toolName, args, ev.isError, toolInfo.get(ev.toolName)));
						env.render();
						break;
					}
				}
			});
			const stop = () => void session.abort();
			controller.signal.addEventListener("abort", stop, { once: true });
			try {
				// Slash commands were handled by the aside already; send the text as it is.
				await session.prompt(prompt, { expandPromptTemplates: false });
			} finally {
				controller.signal.removeEventListener("abort", stop);
			}
			if (controller.signal.aborted) ex.aborted = true;
			else if (!ex.error) ex.done = true;
		} catch (err) {
			if (controller.signal.aborted) ex.aborted = true;
			else ex.error = err instanceof Error ? err.message : String(err);
		} finally {
			unsubscribe?.();
			await reclaim(level, task);
			if (level.task === task) level.task = undefined;
			env.render();
		}
		if (commands.size && !level.discarded) await checkCommands(env, level, run, [...commands.values()], record);
		drainQueue(env, level);
	})();
}

/**
 * The queued steer a user message of the answer delivers, taken out of the queue: the one sent as
 * `text`, or the first one sent when an extension changed its text on the way in.
 */
function takeDelivered(level: AsideLevel, text: string): Queued | undefined {
	const sent = level.queue.filter((q) => q.sent);
	const steer = sent.find((q) => q.sent?.prompt === text) ?? sent[0];
	if (steer) level.queue = level.queue.filter((q) => q !== steer);
	return steer;
}

/** Steers still in the session's queue when the answer ended leave it, and wait to be asked instead. */
async function reclaim(level: AsideLevel, task: NonNullable<AsideLevel["task"]>) {
	const session = task.session;
	if (!session) return;
	// A steer on its way in (an extension's input hook) lands in the queue first.
	await Promise.allSettled(level.queue.map((q) => q.sent?.queued));
	const left = level.queue.filter((q) => q.sent);
	if (!left.length) return;
	session.clearQueue();
	unsend(level, left);
}

/** Put a queued steer into the answering session, built as a question at this point. */
function sendSteer(env: AsideEnv, level: AsideLevel, session: AgentSession, steer: Queued) {
	const notes = level.pendingNotes;
	const focus = level.sentFocus;
	const prompt = buildPrompt(env, level, level.parts(), steer.question);
	const sent: NonNullable<Queued["sent"]> = { prompt, notes, focus, queued: Promise.resolve() };
	steer.sent = sent;
	sent.queued = session.steer(prompt).then(
		(disposition) => {
			// An extension's input hook took it, as it can in pi's main pane; it reaches no model.
			if (disposition !== "handled" || steer.sent !== sent) return;
			level.queue = level.queue.filter((q) => q !== steer);
			level.pendingNotes = [...notes, ...level.pendingNotes];
			env.render();
		},
		() => {
			// Not queued: it waits to be asked instead.
			if (steer.sent === sent) unsend(level, [steer]);
		},
	);
}

/**
 * Move the level's queue along, as pi's main pane does with prompts it queued: steers go into the
 * answer once it runs (not while a nested aside's summary is on its way, so they carry it); once the
 * level is free, the first queued question is asked, and the rest wait on that answer the same way.
 */
export function drainQueue(env: AsideEnv, level: AsideLevel) {
	if (level.discarded || level.incoming.size || !level.queue.length) return;
	const session = level.task?.kind === "answer" ? level.task.session : undefined;
	if (session?.isStreaming) {
		for (const q of level.queue) if (q.mode === "steer" && !q.sent) sendSteer(env, level, session, q);
	} else if (!isBusy(level)) {
		const next = level.queue.find((q) => !q.sent);
		if (next) {
			level.queue = level.queue.filter((q) => q !== next);
			ask(env, level, next.question);
		}
	}
}

/** Queue `question`, typed while the level is busy, as a steer (enter) or a follow-up (pi's follow-up key). */
export function enqueue(env: AsideEnv, level: AsideLevel, mode: Queued["mode"], question: Question) {
	level.queue.push({ mode, question });
	drainQueue(env, level);
}

/**
 * Judge the commands an answer ran, even a stopped one, as a task of its own: stopping it lists every
 * command unchecked. Nothing else can start on the level meanwhile, so a handoff waits for the verdict.
 */
async function checkCommands(env: AsideEnv, level: AsideLevel, run: Exchange[], commands: RanCommand[], record: (change: Change) => void) {
	const controller = new AbortController();
	level.task = { kind: "check", controller, unsettled: () => unchecked(commands) };
	env.render();
	try {
		for (const change of await commandChanges(env, level, run, commands, controller.signal)) record(change);
	} catch {
		// The level was discarded meanwhile (pi quit or switched sessions); nothing goes down then.
	} finally {
		if (level.task?.controller === controller) level.task = undefined;
		env.render();
	}
}
