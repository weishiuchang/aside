/**
 * One tool call in the thread, drawn by pi's own tool component with the tool's renderers, as in
 * pi's main pane: its call, its live progress (partial results), and its result.
 */

import { ToolExecutionComponent, type ToolRenderers } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";

/** Display settings pi's main pane passes to its tool components. */
export interface ToolCallOptions {
	outputPad: number;
	imageWidthCells: number;
}

/** A tool result as pi's session events carry it. */
export interface ToolCallResult {
	// biome-ignore lint/suspicious/noExplicitAny: tool results are untyped JSON
	content: any[];
	// biome-ignore lint/suspicious/noExplicitAny: tool details are untyped JSON
	details?: any;
	isError: boolean;
	durationMs?: number;
}

export class ToolCall {
	private view: ToolExecutionComponent | undefined;
	private expanded?: boolean;

	constructor(
		tui: TUI,
		name: string,
		id: string,
		args: unknown,
		renderers: ToolRenderers | undefined,
		cwd: string,
		options: ToolCallOptions,
		/** Shown instead when pi's component fails, so another extension's renderer cannot break the pane. */
		private fallback: () => string,
	) {
		// Images stay off: an overlay splices rendered lines, which breaks terminal image sequences.
		this.view = this.guard(
			() => new ToolExecutionComponent(name, id, args, { ...options, showImages: false }, renderers, tui, cwd),
			undefined,
		);
	}

	/** Run `f` on pi's component; on a throw, drop the component and show the fallback from then on. */
	private guard<T>(f: () => T, failed: T): T {
		try {
			return f();
		} catch {
			this.view = undefined;
			return failed;
		}
	}

	updateArgs(args: unknown) {
		this.guard(() => this.view?.updateArgs(args), undefined);
	}

	markExecutionStarted() {
		this.guard(() => this.view?.markExecutionStarted(), undefined);
	}

	setArgsComplete() {
		this.guard(() => this.view?.setArgsComplete(), undefined);
	}

	updateResult(result: ToolCallResult, isPartial = false) {
		this.guard(() => this.view?.updateResult(result, isPartial), undefined);
	}

	/** Lines at `width`, with pi's tool-output expansion. pi's component caches what did not change. */
	render(width: number, expanded: boolean): string[] {
		if (this.view && this.expanded !== expanded) {
			this.expanded = expanded;
			this.guard(() => this.view?.setExpanded(expanded), undefined);
		}
		const lines = this.view ? this.guard(() => this.view?.render(width), undefined) : undefined;
		return lines ?? [this.fallback()];
	}
}
