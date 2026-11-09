/**
 * The question box: pi's own editor (CustomEditor, with the autocomplete provider pi's editor uses)
 * drawn without its borders. Every key the pane does not take for aside-specific actions comes here,
 * so editing, new lines, submitting, pastes, ↑↓ history, tab completion and the autocomplete list
 * behave as in pi's editor.
 */

import { CustomEditor, getSelectListTheme, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { type AutocompleteProvider, CURSOR_MARKER, type TUI } from "@earendil-works/pi-tui";
import { HISTORY_MAX } from "../config.ts";

const PROMPT = "› ";
const INDENT = "  ";
/**
 * Prefixed to the editor's border rows so they can be told apart from text and autocomplete rows.
 * An SGR reset: invisible if it ever showed.
 */
const BORDER = "\x1b[0m\x1b[0m";

/** Questions asked in any aside, oldest first. Shared by every box, in memory for the pi process. */
const history: string[] = [];

/** What the box's editor does on keys that pi's editor turns into app actions. */
export interface BoxHandlers {
	/** Enter, with the text the editor cleared. */
	submit: (text: string) => void;
	change: (text: string) => void;
	/** esc while no autocomplete list is open. */
	escape: () => void;
	/** pi's exit key on an empty box. */
	exit: () => void;
	toggleExpanded: () => void;
	toggleThinking: () => void;
}

export class QuestionBox {
	private editor: CustomEditor;
	/** How many entries of `history` this box's editor has been given. */
	private historySeen = 0;

	constructor(
		tui: TUI,
		keybindings: KeybindingsManager,
		autocomplete: AutocompleteProvider,
		autocompleteMaxVisible: number,
		handlers: BoxHandlers,
		private placeholder: string,
		private placeholderStyle: (t: string) => string,
	) {
		const editor = new CustomEditor(
			tui,
			{ borderColor: (t) => BORDER + t, selectList: getSelectListTheme() },
			keybindings,
			{ paddingX: 0, autocompleteMaxVisible },
		);
		editor.setAutocompleteProvider(autocomplete);
		editor.onSubmit = handlers.submit;
		editor.onChange = handlers.change;
		editor.onEscape = handlers.escape;
		editor.onCtrlD = handlers.exit;
		editor.onAction("app.tools.expand", handlers.toggleExpanded);
		editor.onAction("app.thinking.toggle", handlers.toggleThinking);
		this.editor = editor;
	}

	set focused(v: boolean) {
		this.editor.focused = v;
	}

	/** Enter does nothing while set (an answer is streaming), as `disableSubmit` in pi's editor. */
	set submitDisabled(v: boolean) {
		this.editor.disableSubmit = v;
	}

	/** Whether the editor's autocomplete list is open; it takes esc, ↑↓, and page keys. */
	get autocompleteOpen(): boolean {
		return this.editor.isShowingAutocomplete();
	}

	/** Full text, with collapsed pastes expanded. */
	getValue(): string {
		return this.editor.getExpandedText();
	}

	/** Replace the text and put the cursor at the end. */
	setValue(value: string) {
		this.editor.setText(value);
	}

	handleInput(data: string) {
		this.syncHistory();
		this.editor.handleInput(data);
	}

	/** Add a question to the shared history. */
	addToHistory(text: string) {
		const t = text.trim();
		if (!t || history[history.length - 1] === t) return;
		history.push(t);
		if (history.length > HISTORY_MAX) {
			history.shift();
			this.historySeen--;
		}
	}

	/** Give the editor the questions asked since it last looked, e.g. in a nested aside. */
	private syncHistory() {
		if (this.historySeen > history.length) this.historySeen = 0;
		for (const q of history.slice(this.historySeen)) this.editor.addToHistory(q);
		this.historySeen = history.length;
	}

	invalidate() {
		this.editor.invalidate();
	}

	/**
	 * Render the text in at most `maxRows` rows, keeping the cursor row visible, and the open
	 * autocomplete list (empty when closed) for the pane to place below it, as pi's editor does.
	 */
	render(width: number, maxRows: number): { text: string[]; list: string[] } {
		const inner = Math.max(1, width - PROMPT.length);
		// The editor draws a border row above and below its text, then the autocomplete list.
		const all = this.editor.render(inner);
		const bottom = all.findIndex((l, i) => i > 0 && l.startsWith(BORDER));
		const body = all.slice(1, bottom);
		const list = all.slice(bottom + 1).map((l) => INDENT + l);
		const lines = body.length ? body : [""];
		const empty = this.editor.getText() === "";
		const rows = lines.map((l, i) => (i === 0 ? PROMPT : INDENT) + (empty ? l.trimEnd() + this.placeholderStyle(this.placeholder) : l));
		const max = Math.max(1, maxRows);
		if (rows.length <= max) return { text: rows, list };
		const cursor = rows.findIndex((r) => r.includes(CURSOR_MARKER));
		const end = Math.min(rows.length, Math.max(max, cursor + 1));
		const start = end - max;
		const shown = rows.slice(start, end);
		// Mark hidden rows above and below in the prompt column.
		const mark = (r: string, m: string) => this.placeholderStyle(m) + r.slice(INDENT.length - 1);
		if (start > 0) shown[0] = mark(shown[0], "\u2191");
		if (end < rows.length && max > 1) shown[max - 1] = mark(shown[max - 1], "\u2193");
		return { text: shown, list };
	}
}
