/** What asking and handing off need from the stack: pi, the main conversation, and other levels. */

import type { ExtensionAPI, ExtensionContext, ToolRenderers } from "@earendil-works/pi-coding-agent";
import type { Part } from "../context/parts.ts";
import { MESSAGE_TYPE } from "../config.ts";
import type { AsideLevel } from "../level.ts";
import type { ToolCall } from "../ui/tool-call.ts";

export interface AsideEnv {
	ctx: ExtensionContext;
	pi: ExtensionAPI;
	/**
	 * Summaries of aside 1 still being written for the main conversation. They outlive the stack, and
	 * pi quitting or switching sessions removes them, so they send nothing.
	 */
	toMain: Set<AbortController>;
	mainTurns: () => Part[];
	/** The level `level` asks about; undefined for level 1. */
	parentOf: (level: AsideLevel) => AsideLevel | undefined;
	/** A tool call's view in the thread, drawn with the tool's renderers as pi's main pane draws it. */
	toolCall: (name: string, id: string, args: unknown, renderers: ToolRenderers | undefined) => ToolCall;
	/** Request a redraw after state changed. */
	render: () => void;
}

/**
 * Add a visible message to the main conversation without starting a turn; while the agent is busy
 * it is queued for the next turn. Returns whether it was added right away.
 */
export function sendToMain(env: AsideEnv, content: string): boolean {
	const message = { customType: MESSAGE_TYPE, content, display: true };
	const idle = env.ctx.isIdle();
	if (idle) env.pi.sendMessage(message, { triggerTurn: false });
	else env.pi.sendMessage(message, { deliverAs: "nextTurn" });
	return idle;
}

/** Show in pi's footer whether summaries of aside 1 are still on their way to the main conversation. */
export function showMainStatus(env: AsideEnv) {
	env.ctx.ui.setStatus(MESSAGE_TYPE, env.toMain.size ? "aside: summarizing for the main conversation…" : undefined);
}
