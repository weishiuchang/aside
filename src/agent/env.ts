/** What asking and handing off need from the stack: pi, the main conversation, and other levels. */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Part } from "../context/parts.ts";
import { MESSAGE_TYPE } from "../config.ts";
import type { AsideLevel } from "../level.ts";

export interface AsideEnv {
	ctx: ExtensionContext;
	pi: ExtensionAPI;
	mainTurns: () => Part[];
	/** The level `level` asks about; undefined for level 1. */
	parentOf: (level: AsideLevel) => AsideLevel | undefined;
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
