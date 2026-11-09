/**
 * The question box: the editor pi's main pane uses, built by the same editor factory (pi's
 * CustomEditor, or what editor extensions make of it), with the autocomplete provider pi's editor
 * uses, drawn without its plain borders. Every key the pane does not take for aside-specific actions
 * comes here, so editing, new lines, submitting, pastes, ↑↓ history, tab completion, the
 * autocomplete list, and editor extensions behave as in pi's editor.
 */

import { type AppKeybinding, CustomEditor, type ExtensionUIContext, getSelectListTheme, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { type AutocompleteProvider, CURSOR_MARKER, type EditorComponent, type EditorTheme, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { HISTORY_MAX } from "../config.ts";

/** pi's editor factory, as editor extensions set it; undefined means pi's own editor. */
export type EditorFactory = NonNullable<ReturnType<ExtensionUIContext["getEditorComponent"]>>;

/**
 * What the box uses beyond pi's editor interface, present when the editor is pi's CustomEditor or
 * built on it. Checked by shape, as pi does: an extension's copy of pi's classes fails `instanceof`.
 */
type Editor = EditorComponent & {
	focused?: boolean;
	onEscape?: () => void;
	onCtrlD?: () => void;
	actionHandlers?: Map<AppKeybinding, () => void>;
	disableSubmit?: boolean;
	isShowingAutocomplete?: () => boolean;
};

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
	private editor: Editor;
	/** How many entries of `history` this box's editor has been given. */
	private historySeen = 0;
	private _focused = false;

	constructor(
		private tui: TUI,
		private keybindings: KeybindingsManager,
		private autocomplete: AutocompleteProvider,
		private autocompleteMaxVisible: number,
		private handlers: BoxHandlers,
		private placeholder: string,
		private placeholderStyle: (t: string) => string,
		factory: EditorFactory | undefined,
	) {
		this.editor = this.build(factory);
	}

	/**
	 * Build the editor with `factory` and wire it as pi wires its main editor; pi's own editor when
	 * there is no factory or it fails.
	 */
	private build(factory: EditorFactory | undefined): Editor {
		const theme: EditorTheme = { borderColor: (t) => BORDER + t, selectList: getSelectListTheme() };
		let editor: Editor | undefined;
		if (factory) {
			try {
				editor = factory(this.tui, theme, this.keybindings) as Editor;
				this.wire(editor, theme);
			} catch {
				editor = undefined;
			}
		}
		if (!editor) {
			editor = new CustomEditor(this.tui, theme, this.keybindings, { paddingX: 0, autocompleteMaxVisible: this.autocompleteMaxVisible });
			this.wire(editor, theme);
		}
		this.historySeen = 0;
		return editor;
	}

	/** What pi does for its main editor (`setCustomEditorComponent`), with the box's handlers. */
	private wire(editor: Editor, theme: EditorTheme) {
		const h = this.handlers;
		editor.onSubmit = h.submit;
		editor.onChange = h.change;
		if (editor.borderColor !== undefined) editor.borderColor = theme.borderColor;
		editor.setPaddingX?.(0);
		editor.setAutocompleteMaxVisible?.(this.autocompleteMaxVisible);
		editor.setAutocompleteProvider?.(this.autocomplete);
		if (editor.actionHandlers instanceof Map) {
			// An editor extension's own handlers win, as in pi.
			editor.onEscape ??= h.escape;
			editor.onCtrlD ??= h.exit;
			editor.actionHandlers.set("app.tools.expand", h.toggleExpanded);
			editor.actionHandlers.set("app.thinking.toggle", h.toggleThinking);
		}
	}

	/**
	 * Run `f` on the editor. If an editor extension's code throws, the box falls back to pi's own
	 * editor, keeping the text, so it cannot break the pane.
	 */
	private guard<T>(f: (editor: Editor) => T, failed: T): T {
		try {
			return f(this.editor);
		} catch {
			const text = this.safeText();
			this.editor = this.build(undefined);
			this.editor.setText(text);
			this.editor.focused = this._focused;
			return failed;
		}
	}

	private safeText(): string {
		try {
			return this.editor.getExpandedText?.() ?? this.editor.getText();
		} catch {
			return "";
		}
	}

	set focused(v: boolean) {
		this._focused = v;
		this.guard((e) => {
			e.focused = v;
		}, undefined);
	}

	/** Enter does nothing while set (an answer is streaming), as `disableSubmit` in pi's editor. */
	set submitDisabled(v: boolean) {
		this.guard((e) => {
			if ("disableSubmit" in e) e.disableSubmit = v;
		}, undefined);
	}

	/** Whether the editor's autocomplete list is open; it takes esc, ↑↓, and page keys. */
	get autocompleteOpen(): boolean {
		return this.guard((e) => e.isShowingAutocomplete?.() ?? false, false);
	}

	/** Full text, with collapsed pastes expanded. */
	getValue(): string {
		return this.guard((e) => e.getExpandedText?.() ?? e.getText(), "");
	}

	/** Replace the text and put the cursor at the end. */
	setValue(value: string) {
		this.guard((e) => e.setText(value), undefined);
	}

	handleInput(data: string) {
		this.syncHistory();
		this.guard((e) => e.handleInput(data), undefined);
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
		const add = this.editor.addToHistory?.bind(this.editor);
		if (add) this.guard(() => history.slice(this.historySeen).forEach((q) => add(q)), undefined);
		this.historySeen = history.length;
	}

	invalidate() {
		this.guard((e) => e.invalidate(), undefined);
	}

	/**
	 * Render the text in at most `maxRows` rows, keeping the cursor row visible, and the open
	 * autocomplete list (empty when closed) for the pane to place below it, as pi's editor does.
	 */
	render(width: number, maxRows: number): { text: string[]; list: string[]; above?: string; below?: string } {
		const inner = Math.max(1, width - PROMPT.length);
		// The editor draws a border row above and below its text, then the autocomplete list. An
		// editor without border rows is all text.
		const all = this.guard((e) => e.render(inner), [""]);
		const top = all[0]?.startsWith(BORDER) ? 0 : -1;
		const bottom = top < 0 ? -1 : all.findIndex((l, i) => i > 0 && l.startsWith(BORDER));
		const body = bottom < 0 ? all.slice(top + 1) : all.slice(top + 1, bottom);
		const list = bottom < 0 ? [] : all.slice(bottom + 1).map((l) => INDENT + l);
		const lines = body.length ? body : [""];
		const empty = this.guard((e) => e.getText() === "", true);
		const rows = lines.map((l, i) => (i === 0 ? PROMPT : INDENT) + (empty ? l.trimEnd() + this.placeholderStyle(this.placeholder) : l));
		// Border rows with more than the plain line (pi's "↑ N more", an extension's mode label) are shown.
		const marked = (row: string | undefined) => (row !== undefined && !isPlainBorder(row) ? INDENT + row.slice(BORDER.length) : undefined);
		const edges = { above: top < 0 ? undefined : marked(all[top]), below: bottom < 0 ? undefined : marked(all[bottom]) };
		const max = Math.max(1, maxRows);
		if (rows.length <= max) return { text: rows, list, ...edges };
		const cursor = rows.findIndex((r) => r.includes(CURSOR_MARKER));
		const end = Math.min(rows.length, Math.max(max, cursor + 1));
		const start = end - max;
		const shown = rows.slice(start, end);
		// Mark hidden rows above and below in the prompt column.
		const mark = (r: string, m: string) => this.placeholderStyle(m) + r.slice(INDENT.length - 1);
		if (start > 0) shown[0] = mark(shown[0], "\u2191");
		if (end < rows.length && max > 1) shown[max - 1] = mark(shown[max - 1], "\u2193");
		return { text: shown, list, ...edges };
	}
}

/** A border row that is only the line: nothing on it worth a row. */
function isPlainBorder(row: string): boolean {
	const plain = row.replace(/\x1b\[[0-9;]*m/g, "").trim();
	return visibleWidth(plain) === 0 || /^─+$/.test(plain);
}
