/**
 * The aside stack: its levels, their panes, and the one overlay that shows them. Pushing and popping
 * changes the list of levels; the overlay re-reads its size and layout on every render.
 */

import {
	type AgentSession,
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	type KeybindingsManager,
	type MarkdownTransformer,
	SettingsManager,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import type { AutocompleteProvider, OverlayHandle, TUI } from "@earendil-works/pi-tui";
import { ask } from "./agent/ask.ts";
import { toolCallLine } from "./agent/changes.ts";
import type { AsideEnv } from "./agent/env.ts";
import { levelSession } from "./agent/session.ts";
import { sendChanges, sendThread, summarize } from "./agent/handoff.ts";
import { asideAutocomplete, type CommandHost, runCommand } from "./commands.ts";
import { AUTOCOMPLETE_MAX_VISIBLE, MAX_DEPTH } from "./config.ts";
import { type Part, partsFromThread, turnsFromBranch } from "./context/parts.ts";
import { type AsideLevel, createLevel, discardLevel, isBusy, levelThinking, usageLabel } from "./level.ts";
import type { Model } from "./types.ts";
import { liveOverlayOptions } from "./ui/layout.ts";
import { AsidePane } from "./ui/pane.ts";
import { reflowAround } from "./ui/reflow.ts";
import { StackView } from "./ui/stack-view.ts";
import { ToolCall } from "./ui/tool-call.ts";

export class AsideStack {
	private levels: AsideLevel[] = [];
	private panes: AsidePane[] = [];
	private env: AsideEnv;
	/** Main conversation turns, rebuilt on demand after the conversation moved on. */
	private turns: Part[] = [];
	private turnsStale = true;
	/** Turns by their entries, so a rebuild only parses what changed. */
	private turnCache = new Map<string, Part>();
	private tui?: TUI;
	private theme?: Theme;
	private keybindings?: KeybindingsManager;
	private handle?: OverlayHandle;
	private view?: StackView;
	private finish?: () => void;
	/** Gives the main conversation its full screen back. */
	private unreflow?: () => void;
	private closed = false;
	private shuttingDown = false;
	/**
	 * Whether thinking shows as one line: pi's thinking-block setting when the stack opens, then
	 * pi's thinking toggle in an aside. Read from pi's settings, which pi saves on every toggle.
	 */
	private thinkingHidden: boolean;
	/**
	 * Extensions' Markdown transformers, from the first aside session that starts: the main
	 * conversation's are not readable, and every aside session loads the same extensions.
	 */
	private transformers: readonly MarkdownTransformer[] = [];
	private transformersRead = false;

	constructor(
		private ctx: ExtensionContext,
		pi: ExtensionAPI,
		/** The main conversation's model when the stack opened, copied into aside 1. */
		private mainModel: Model,
		/** The autocomplete provider of pi's editor, which the question boxes use too. */
		private mainAutocomplete: AutocompleteProvider | undefined,
		/** Summaries of aside 1 still being written; they outlive the stack. */
		toMain: Set<AbortController>,
	) {
		const settings = SettingsManager.create(ctx.cwd, getAgentDir(), { projectTrusted: ctx.isProjectTrusted() });
		this.thinkingHidden = settings.getHideThinkingBlock();
		const toolOptions = { outputPad: settings.getOutputPad(), imageWidthCells: settings.getImageWidthCells() };
		this.env = {
			ctx,
			pi,
			toMain,
			mainTurns: () => this.mainTurns(),
			parentOf: (level) => this.levels[this.levels.indexOf(level) - 1],
			toolCall: (name, id, args, renderers) => {
				if (!this.tui) throw new Error("aside: TUI not ready");
				const line = toolCallLine(name, args);
				return new ToolCall(this.tui, name, id, args, renderers, ctx.cwd, toolOptions, () => line);
			},
			render: () => this.tui?.requestRender(),
		};
	}

	/** Slash commands work the same at every level; `/model` and `/thinking` change only `level`. */
	private commandHost(level: AsideLevel): CommandHost {
		return {
			pi: this.env.pi,
			ctx: this.ctx,
			level,
			openNested: () => this.push(),
			summarize: () => summarize(this.env, level, () => this.closeIfTop(level)),
			sendThread: () => sendThread(this.env, level, () => this.closeIfTop(level)),
			close: () => this.closeIfTop(level),
		};
	}

	private get depth() {
		return this.levels.length;
	}

	private mainTurns(): Part[] {
		if (this.turnsStale) {
			const fresh = turnsFromBranch(this.ctx.sessionManager.getBranch(), this.turnCache);
			if (fresh.length) this.turns = fresh;
			this.turnsStale = false;
		}
		return this.turns;
	}

	hasTurns() {
		return this.mainTurns().length > 0;
	}

	/** The main conversation moved on; turns are rebuilt when next read. */
	mainChanged() {
		this.turnsStale = true;
		this.tui?.requestRender();
	}

	/** Give keyboard focus back to the top aside. */
	refocus() {
		this.handle?.focus();
	}

	/** Ask `text` at `level`, or run it as a slash command. Returns false to keep it in the box. */
	private submit(level: AsideLevel, text: string): boolean {
		if (isBusy(level)) return false;
		const result = runCommand(text, this.commandHost(level));
		if (!result || result.kind === "ask") {
			ask(this.env, level, text, result?.prompt);
			return true;
		}
		if (result.notice) level.notice = result.notice;
		this.tui?.requestRender();
		return result.kind === "done";
	}

	/** Add the pane for `level`, and start its session in the background. */
	private addPane(level: AsideLevel) {
		if (!this.tui || !this.theme || !this.keybindings) throw new Error("aside: TUI not ready");
		this.panes.push(
			new AsidePane(this.tui, this.theme, this.keybindings, level, {
				submit: (text) => this.submit(level, text),
				autocomplete: asideAutocomplete(this.commandHost(level), this.mainAutocomplete),
				autocompleteMaxVisible: this.env.pi.getSettings().autocompleteMaxVisible ?? AUTOCOMPLETE_MAX_VISIBLE,
				markdownTransformers: () => this.transformers,
				// Read for each box: editor extensions set it again on every session start.
				editorFactory: this.ctx.ui.getEditorComponent(),
				status: () => [level.model.id, levelThinking(level), usageLabel(level.usage)].filter(Boolean).join(" · "),
				summarize: () => summarize(this.env, level, () => this.closeIfTop(level)),
				sendThread: () => sendThread(this.env, level, () => this.closeIfTop(level)),
				openNested: () => this.push(),
				expanded: () => this.ctx.ui.getToolsExpanded(),
				toggleExpanded: () => {
					this.ctx.ui.setToolsExpanded(!this.ctx.ui.getToolsExpanded());
					this.tui?.requestRender();
				},
				thinkingHidden: () => this.thinkingHidden,
				toggleThinking: () => {
					this.thinkingHidden = !this.thinkingHidden;
					level.notice = `Thinking blocks: ${this.thinkingHidden ? "hidden" : "visible"}`;
					this.tui?.requestRender();
				},
				close: () => this.pop(),
			}),
		);
		// After the pane is drawn, so the first frame is not held up.
		setTimeout(() => {
			if (this.levels.includes(level)) {
				void levelSession(this.env.pi, this.ctx.cwd, level)
					.then((session) => this.readTransformers(session))
					.catch(() => {});
			}
		}, 0);
	}

	private readTransformers(session: AgentSession) {
		if (this.transformersRead) return;
		this.transformersRead = true;
		const transformers = session.extensionRunner.getMarkdownTransformers();
		if (!transformers.length) return;
		this.transformers = transformers;
		this.tui?.requestRender();
	}

	/** Open aside 1. Resolves when the whole stack closed. */
	async open(): Promise<void> {
		const level = createLevel(1, () => this.mainTurns(), this.mainModel, this.env.pi.getThinkingLevel());
		this.levels = [level];
		try {
			await this.ctx.ui.custom<void>(
				(tui, theme, keybindings, done) => {
					this.tui = tui;
					this.theme = theme;
					this.keybindings = keybindings;
					this.finish = () => done(undefined);
					this.addPane(level);
					this.view = new StackView(tui, theme, () => this.panes);
					this.view.sync();
					this.unreflow = reflowAround(tui);
					return this.view;
				},
				{
					overlay: true,
					overlayOptions: () => liveOverlayOptions(this.tui!, () => this.depth),
					onHandle: (h) => {
						this.handle = h;
					},
				},
			);
		} finally {
			this.dispose();
		}
	}

	private notice(level: AsideLevel, text: string) {
		level.notice = text;
		this.ctx.ui.notify(text, "info");
		this.tui?.requestRender();
	}

	/** Open a nested aside about the top aside. */
	private push() {
		const parent = this.levels[this.levels.length - 1];
		if (!parent || this.closed) return;
		// Nothing to ask about yet: ignore the key silently.
		if (!parent.thread.length) return;
		// Only an aside that could otherwise open a nested one hears about the limit.
		if (this.depth >= MAX_DEPTH) {
			this.notice(parent, `Asides can stack at most ${MAX_DEPTH} deep.`);
			return;
		}
		// A nested aside does not list what it sent down itself.
		let levelId = -1;
		const level = createLevel(parent.depth + 1, () => partsFromThread(parent.thread, levelId), parent.model, levelThinking(parent));
		levelId = level.id;
		parent.notice = undefined;
		this.levels.push(level);
		this.addPane(level);
		this.view?.sync();
	}

	/**
	 * Close the top aside at once, stopping what it is doing and discarding its thread; what it changed
	 * and did not send down still goes to the level below, including what the stopped work had not
	 * listed yet. Closing the last one closes the overlay.
	 */
	private pop() {
		const level = this.levels[this.levels.length - 1];
		if (!level) return;
		if (!this.shuttingDown) {
			if (level.task?.unsettled) level.changes.push(...level.task.unsettled());
			sendChanges(this.env, level);
		}
		this.levels.pop();
		this.panes.pop();
		discardLevel(level);
		if (this.depth === 0) this.finish?.();
		else this.view?.sync();
	}

	/** Close `level` if it is still the top aside (a nested aside opened on it keeps it open). */
	private closeIfTop(level: AsideLevel) {
		if (this.levels[this.levels.length - 1] === level) this.pop();
	}

	/** pi is shutting down or switching sessions: close without writing to the main conversation. */
	closeAll() {
		this.shuttingDown = true;
		while (this.depth) this.pop();
	}

	private dispose() {
		this.closed = true;
		this.unreflow?.();
		this.unreflow = undefined;
		for (const level of this.levels) discardLevel(level);
		this.levels = [];
		this.panes = [];
		this.view = undefined;
		this.handle = undefined;
	}
}
