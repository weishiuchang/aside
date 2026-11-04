/**
 * Which shell commands of an answer count as changes: the model judges, from what the user asked
 * and what each command did, whether the user wanted changes and which commands made them.
 */

import { COMMAND_CHECK_ANSWER_MAX_CHARS, COMMAND_CHECK_COMMAND_MAX_CHARS, COMMAND_CHECK_OUTPUT_MAX_CHARS } from "../config.ts";
import { clip, textOf } from "../context/text.ts";
import { type AsideLevel, addUsage, answerText, type Exchange } from "../level.ts";
import { type Change, local } from "./changes.ts";
import type { AsideEnv } from "./env.ts";
import { commandCheckPrompt } from "./prompts.ts";

/** A shell command an answer ran, and what it printed once it ended. */
export interface RanCommand {
	command: string;
	output?: string;
	isError?: boolean;
}

/** The questions of the level, the answer, and the commands, as the check's input. */
function checkInput(level: AsideLevel, ex: Exchange, commands: RanCommand[]): string {
	const earlier = level.thread.filter((e) => !e.from && e !== ex).map((e) => `- ${e.question}`);
	const listed = commands.map((c, i) => {
		const status = c.output === undefined ? "did not finish" : c.isError ? "failed" : "succeeded";
		const output = c.output?.trim() ? `\nOutput:\n${clip(c.output.trim(), COMMAND_CHECK_OUTPUT_MAX_CHARS)}` : "";
		return `<command n="${i + 1}" status="${status}">\n${clip(c.command, COMMAND_CHECK_COMMAND_MAX_CHARS)}${output}\n</command>`;
	});
	return [
		earlier.length ? `<earlier_questions>\n${earlier.join("\n")}\n</earlier_questions>` : "",
		`<question>\n${ex.question}\n</question>`,
		`<answer>\n${clip(answerText(ex).trim(), COMMAND_CHECK_ANSWER_MAX_CHARS)}\n</answer>`,
		`<commands>\n${listed.join("\n")}\n</commands>`,
	]
		.filter(Boolean)
		.join("\n\n");
}

/** The model's verdict: changes for the commands it reports, none when the user asked for no change. */
function verdictChanges(text: string, commands: RanCommand[]): Change[] {
	const json = text.match(/\{[\s\S]*\}/)?.[0];
	if (!json) throw new Error("the check returned no verdict");
	const verdict = JSON.parse(json) as { requested?: unknown; changed?: unknown };
	if (verdict.requested !== true || !Array.isArray(verdict.changed)) return [];
	return verdict.changed.flatMap((c: { command?: unknown; effect?: unknown }) => {
		const ran = typeof c?.command === "number" ? commands[c.command - 1] : undefined;
		if (!ran) return [];
		const effect = typeof c.effect === "string" && c.effect.trim() ? `: ${c.effect.trim()}` : "";
		return [local(`ran \`${clip(ran.command, 500)}\`${effect}`)];
	});
}

/** Without a verdict (stopped or failed), every command is listed, as it may have changed anything. */
export const unchecked = (commands: RanCommand[]): Change[] => commands.map((c) => local(`ran \`${clip(c.command, 500)}\` (not checked)`));

/** The changes `commands`, run while answering `ex`, made at the user's request. */
export async function commandChanges(env: AsideEnv, level: AsideLevel, ex: Exchange, commands: RanCommand[], signal: AbortSignal): Promise<Change[]> {
	try {
		const response = await env.ctx.modelRegistry
			.streamSimple(
				level.model,
				{ systemPrompt: commandCheckPrompt(), messages: [{ role: "user", content: checkInput(level, ex, commands), timestamp: Date.now() }] },
				{ signal },
			)
			.result();
		addUsage(level, response.usage);
		if (response.stopReason === "aborted" || response.stopReason === "error") return unchecked(commands);
		return verdictChanges(textOf(response.content), commands);
	} catch {
		return unchecked(commands);
	}
}
