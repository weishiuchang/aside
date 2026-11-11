/** Asking a question at one aside level, through the level's agent session. */

import type { AgentSession, ToolInfo, ToolRenderers } from "@earendil-works/pi-coding-agent";
import { NESTED_MAIN_MAX_CHARS } from "../config.ts";
import { backgroundBlock, focusBlock } from "../context/blocks.ts";
import { type Part, rangeLabel } from "../context/parts.ts";
import { textOf } from "../context/text.ts";
import { type AsideLevel, addUsage, appendAnswer, type Exchange, levelThinking, type Segment, selectedRange, syncSelection } from "../level.ts";
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

/** The text sent for a question: what nested asides sent down, then context or changed focus, then the question. */
function buildPrompt(env: AsideEnv, level: AsideLevel, parts: Part[], lo: number, hi: number, question: string): string {
	const sections: string[] = [];
	sections.push(...level.pendingNotes);
	const rangeKey = `${lo}-${hi}`;
	if (level.sentFocus === undefined) sections.push(...firstContext(env, level, parts, lo, hi));
	else if (level.sentFocus !== rangeKey) sections.push(`The focus has changed.\n\n${focusBlock(parts, lo, hi, level.noun)}`);
	sections.push(sections.length ? `Question: ${question}` : question);
	return sections.filter(Boolean).join("\n\n");
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
 * Ask `question` at `level` about its selection. `expanded` is what the model gets instead, e.g. an
 * expanded skill or prompt template; the thread shows `question`.
 */
export function ask(env: AsideEnv, level: AsideLevel, question: string, expanded = question) {
	const parts = level.parts();
	if (!parts.length) return;
	syncSelection(level, parts.length);
	const { lo, hi } = selectedRange(level);
	const prompt = buildPrompt(env, level, parts, lo, hi, expanded);
	level.pendingNotes = [];
	level.sentFocus = `${lo}-${hi}`;

	const ex: Exchange = {
		question,
		rangeKey: level.sentFocus,
		label: rangeLabel(lo, hi, parts.length, level.noun),
		segments: [],
		toolCalls: 0,
	};
	level.thread.push(ex);
	level.follow = true;
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
	level.task = { kind: "answer", controller, unsettled };
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
			unsubscribe = session.subscribe((ev) => {
				switch (ev.type) {
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
			if (level.task?.controller === controller) level.task = undefined;
			env.render();
		}
		if (commands.size && !level.discarded) await checkCommands(env, level, ex, [...commands.values()], record);
	})();
}

/**
 * Judge the commands an answer ran, even a stopped one, as a task of its own: stopping it lists every
 * command unchecked. Nothing else can start on the level meanwhile, so a handoff waits for the verdict.
 */
async function checkCommands(env: AsideEnv, level: AsideLevel, ex: Exchange, commands: RanCommand[], record: (change: Change) => void) {
	const controller = new AbortController();
	level.task = { kind: "check", controller, unsettled: () => unchecked(commands) };
	env.render();
	try {
		for (const change of await commandChanges(env, level, ex, commands, controller.signal)) record(change);
	} catch {
		// The level was discarded meanwhile (pi quit or switched sessions); nothing goes down then.
	} finally {
		if (level.task?.controller === controller) level.task = undefined;
		env.render();
	}
}
