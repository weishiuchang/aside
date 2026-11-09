/**
 * aside: ask side questions about parts of the pi conversation in a pane next to it, and stack
 * nested asides that ask about the aside below. See README.md for keys and SPEC.md for behaviour.
 */

import { type ExtensionAPI, type ExtensionContext, keyText } from "@earendil-works/pi-coding-agent";
import { type AutocompleteProvider, Box, Spacer, Text } from "@earendil-works/pi-tui";
import { ASIDE_VERB_NAMES } from "./src/commands.ts";
import { MESSAGE_TYPE, OPEN_KEYS } from "./src/config.ts";
import { AsideStack } from "./src/stack.ts";

export default function aside(pi: ExtensionAPI) {
	let stack: AsideStack | undefined;
	/** The autocomplete provider of pi's editor, so the question boxes complete exactly as it does. */
	let mainAutocomplete: AutocompleteProvider | undefined;
	/** Summaries of aside 1 still being written; they go on after the stack closed. */
	const toMain = new Set<AbortController>();

	async function open(ctx: ExtensionContext) {
		if (ctx.mode !== "tui") {
			ctx.ui.notify("/aside needs the interactive terminal UI", "error");
			return;
		}
		if (stack) {
			stack.refocus();
			return;
		}
		if (!ctx.model) {
			ctx.ui.notify("No model selected", "error");
			return;
		}
		const opened = new AsideStack(ctx, pi, ctx.model, mainAutocomplete, toMain);
		if (!opened.hasTurns()) {
			ctx.ui.notify("Nothing to ask about yet. Send a prompt first.", "info");
			return;
		}
		stack = opened;
		try {
			await opened.open();
		} finally {
			if (stack === opened) stack = undefined;
		}
	}

	pi.registerCommand("aside", {
		description: "Ask a side question about part of the conversation (side pane, not added to history)",
		// The verbs act on an open aside, so they are typed in it, not in pi's editor.
		handler: async (args, ctx) => {
			if (args.trim()) {
				ctx.ui.notify(`/aside takes no arguments here; /aside ${ASIDE_VERB_NAMES.join(", ")} work inside an aside`, "info");
				return;
			}
			await open(ctx);
		},
	});

	// The focused aside handles these keys itself (to open a nested aside); these global shortcuts
	// open the first aside, or give focus back to an open one.
	for (const key of OPEN_KEYS) {
		pi.registerShortcut(key, {
			description: "Open the aside pane (inside an aside: open a nested aside)",
			handler: (ctx) => open(ctx),
		});
	}

	// What an aside sends down shows collapsed to its first line, the way pi shows a branch summary;
	// pi's expand key (ctrl+o) shows it in full with pi's default custom-message rendering. The first
	// line says what it is (summary, whole discussion, or changes).
	pi.registerMessageRenderer(MESSAGE_TYPE, (message, { expanded, outputPad }, theme) => {
		if (expanded) return undefined;
		const content = typeof message.content === "string" ? message.content : message.content.map((c) => (c.type === "text" ? c.text : "")).join("");
		const title = (content.split("\n", 1)[0] ?? "").replace(/[:.]$/, "");
		const box = new Box(outputPad, 1, (t) => theme.bg("customMessageBg", t));
		box.addChild(new Text(theme.fg("customMessageLabel", theme.bold(`[${MESSAGE_TYPE}]`)), 0, 0));
		box.addChild(new Spacer(1));
		box.addChild(
			new Text(
				theme.fg("customMessageText", `${title} (`) +
					theme.fg("dim", keyText("app.tools.expand")) +
					theme.fg("customMessageText", " to expand)"),
				0,
				0,
			),
		);
		return box;
	});

	// A pass-through wrapper: pi hands it the provider of its editor and keeps using it unchanged.
	// pi drops wrappers when it switches sessions, and session_start comes again after.
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		ctx.ui.addAutocompleteProvider((current) => {
			mainAutocomplete = current;
			return current;
		});
	});

	pi.on("turn_end", () => stack?.mainChanged());
	pi.on("agent_end", () => stack?.mainChanged());
	// Quitting or switching sessions drops what has not arrived: the summaries' ctx goes stale.
	pi.on("session_shutdown", (_event, ctx) => {
		stack?.closeAll();
		stack = undefined;
		if (!toMain.size) return;
		const summaries = [...toMain];
		toMain.clear();
		for (const controller of summaries) controller.abort();
		ctx.ui.setStatus(MESSAGE_TYPE, undefined);
	});
}
