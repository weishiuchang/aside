/**
 * Slash commands in an aside's question box.
 *
 *   aside commands   /model, /thinking, /aside [summary|send|close]: handled by the aside.
 *   expanded         /skill:<name> and prompt templates: expanded into the question as pi's editor
 *                    does. Nothing reaches the main conversation.
 *   pi commands      built-in and extension commands only run from pi's editor, so the aside puts
 *                    the command there (when it is empty) and tells the user to close the asides.
 *                    /reload only gets a warning: it replaces every extension, the asides included.
 *
 * Other text starting with "/" is asked as a plain question, as in pi.
 */

import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { type ExtensionAPI, type ExtensionContext, parseFrontmatter, stripFrontmatter } from "@earendil-works/pi-coding-agent";
import { type AutocompleteItem, type AutocompleteProvider, CombinedAutocompleteProvider, fuzzyFilter, type SlashCommand } from "@earendil-works/pi-tui";
import { type AsideLevel, levelThinking } from "./level.ts";
import type { Model, ThinkingLevel } from "./types.ts";

/**
 * pi's built-in commands (BUILTIN_SLASH_COMMANDS in pi 1.5.0, not exported), which only run from
 * pi's editor. `model` and `thinking` are left out: in an aside they are aside commands.
 */
const PI_BUILTINS: Record<string, string> = {
	settings: "Open settings menu",
	tree: "Navigate session tree (switch branches)",
	"scoped-models": "Enable/disable models for Ctrl+P cycling",
	export: "Export session (HTML default, or specify path: .html/.jsonl)",
	import: "Import a JSONL session, preserving its ID and working directory",
	share: "Share session via a Radius artifact or a GitHub gist",
	bug: "Report a bug to the Pi developers",
	copy: "Copy last agent message to clipboard",
	name: "Set session display name",
	session: "Show session info and stats",
	changelog: "Show changelog entries",
	hotkeys: "Show all keyboard shortcuts",
	fork: "Create a new fork from a previous user message",
	clone: "Duplicate the current session at the current position",
	trust: "Save project trust decision for future sessions",
	login: "Configure provider authentication",
	logout: "Remove provider authentication",
	new: "Start a new session",
	compact: "Manually compact the session context",
	resume: "Resume another session",
	reload: "Reload keybindings, extensions, skills, prompts, themes, and context files",
	quit: "Quit pi",
};

const ASIDE_COMMANDS: Record<string, string> = {
	model: "Model for this aside (other asides and the main conversation keep theirs)",
	thinking: "Thinking level for this aside",
	aside: "Open a nested aside about this one, or: summary, send, close",
};

/** `/aside <verb>` in an aside: the same actions as its keys. */
const ASIDE_VERBS = {
	summary: "Summarize to the level below and close (ctrl+s)",
	send: "Send the whole thread to the level below and close (ctrl+shift+s)",
	close: "Close without sending (ctrl+d)",
} as const;
type AsideVerb = keyof typeof ASIDE_VERBS;
export const ASIDE_VERB_NAMES = Object.keys(ASIDE_VERBS) as AsideVerb[];

/** What the commands need from the stack, for the level they are typed in. */
export interface CommandHost {
	pi: ExtensionAPI;
	ctx: ExtensionContext;
	level: AsideLevel;
	openNested(): void;
	summarize(): void;
	sendThread(): void;
	close(): void;
}

export type CommandResult =
	/** Ask the model. `question` is shown in the thread, `prompt` is what the model gets. */
	| { kind: "ask"; question: string; prompt: string }
	/** Handled; clear the input and show `notice`. */
	| { kind: "done"; notice?: string }
	/** Not done; keep the text in the input and show `notice` if given. */
	| { kind: "keep"; notice?: string };

function parse(text: string): { name: string; args: string } | undefined {
	const m = text.match(/^\/(\S+)(?:\s+([\s\S]*))?$/);
	return m ? { name: m[1], args: (m[2] ?? "").trim() } : undefined;
}

// Ported from pi 1.5.0 prompt-templates.ts (parseCommandArgs and substituteArgs are not exported).
function parseCommandArgs(s: string): string[] {
	const args: string[] = [];
	let cur = "";
	// Quoted empty strings ("" or '') are kept as arguments.
	let hasToken = false;
	let quote: string | null = null;
	for (const ch of s) {
		if (quote) {
			if (ch === quote) quote = null;
			else cur += ch;
		} else if (ch === '"' || ch === "'") {
			quote = ch;
			hasToken = true;
		} else if (/\s/.test(ch)) {
			if (hasToken) args.push(cur);
			cur = "";
			hasToken = false;
		} else {
			cur += ch;
			hasToken = true;
		}
	}
	if (hasToken) args.push(cur);
	return args;
}

function substituteArgs(content: string, args: string[]): string {
	const all = args.join(" ");
	return content.replace(
		/\$\{(\d+|ARGUMENTS|@):-([^}]*)\}|\$\{@:(\d+)(?::(\d+))?\}|\$(ARGUMENTS|@|\d+)/g,
		(_m, defTarget, defValue, sliceStart, sliceLen, simple) => {
			if (defTarget) {
				const v = defTarget === "@" || defTarget === "ARGUMENTS" ? all : args[Number.parseInt(defTarget, 10) - 1];
				return v ? v : defValue;
			}
			if (sliceStart) {
				const start = Math.max(0, Number.parseInt(sliceStart, 10) - 1);
				return sliceLen ? args.slice(start, start + Number.parseInt(sliceLen, 10)).join(" ") : args.slice(start).join(" ");
			}
			if (simple === "ARGUMENTS" || simple === "@") return all;
			return args[Number.parseInt(simple, 10) - 1] ?? "";
		},
	);
}

/** Same block pi builds for /skill:<name> in its editor. */
function expandSkill(name: string, path: string, baseDir: string | undefined, args: string): string {
	const body = stripFrontmatter(readFileSync(path, "utf-8")).trim();
	const block = `<skill name="${name}" location="${path}">\nReferences are relative to ${baseDir ?? dirname(path)}.\n\n${body}\n</skill>`;
	return args ? `${block}\n\n${args}` : block;
}

function expandTemplate(path: string, args: string): string {
	const { body } = parseFrontmatter(readFileSync(path, "utf-8"));
	return substituteArgs(body, parseCommandArgs(args));
}

const modelKey = (m: Model) => `${m.provider}/${m.id}`;

function findModel(host: CommandHost, query: string): Model | Model[] {
	const models = host.ctx.modelRegistry.getAvailable() as Model[];
	const exact = models.find((m) => modelKey(m) === query) ?? models.filter((m) => m.id === query);
	if (!Array.isArray(exact)) return exact;
	if (exact.length === 1) return exact[0];
	const fuzzy = fuzzyFilter(models, query, modelKey);
	return fuzzy.length === 1 ? fuzzy[0] : fuzzy;
}

function modelCommand(host: CommandHost, args: string): CommandResult {
	if (!args) return { kind: "keep", notice: `This aside's model: ${modelKey(host.level.model)}. Type /model <name> to change it.` };
	const found = findModel(host, args);
	if (Array.isArray(found)) {
		return {
			kind: "keep",
			notice: found.length ? `${found.length} models match "${args}". Keep typing or pick one from the list.` : `No available model matches "${args}".`,
		};
	}
	host.level.model = found;
	return { kind: "done", notice: `This aside's model: ${modelKey(found)} (thinking ${levelThinking(host.level)}).` };
}

function thinkingCommand(host: CommandHost, args: string): CommandResult {
	const levels = getSupportedThinkingLevels(host.level.model) as ThinkingLevel[];
	if (!args) return { kind: "keep", notice: `This aside's thinking: ${levelThinking(host.level)}. Levels for this model: ${levels.join(", ")}.` };
	const level = levels.find((l) => l === args.toLowerCase());
	if (!level) return { kind: "keep", notice: `"${args}" is not a thinking level for ${host.level.model.id}. Use one of: ${levels.join(", ")}.` };
	host.level.thinking = level;
	return { kind: "done", notice: `This aside's thinking: ${level}.` };
}

function asideCommand(host: CommandHost, args: string): CommandResult {
	const actions: Record<AsideVerb | "", () => void> = {
		"": host.openNested,
		summary: host.summarize,
		send: host.sendThread,
		close: host.close,
	};
	if (!(args in actions)) return { kind: "keep", notice: `Unknown /aside verb "${args}". Use /aside, or /aside ${ASIDE_VERB_NAMES.join(", ")}.` };
	actions[args as AsideVerb | ""]();
	return { kind: "done" };
}

/** Run `text` as a slash command. Undefined: not a command, ask it as a plain question. */
export function runCommand(text: string, host: CommandHost): CommandResult | undefined {
	const cmd = parse(text);
	if (!cmd) return undefined;
	const { name, args } = cmd;
	if (name === "model") return modelCommand(host, args);
	if (name === "thinking") return thinkingCommand(host, args);
	if (name === "aside") return asideCommand(host, args);

	const info = host.pi.getCommands().find((c) => c.name === name);
	if (info?.source === "skill" || info?.source === "prompt") {
		try {
			const prompt =
				info.source === "skill"
					? expandSkill(name.replace(/^skill:/, ""), info.sourceInfo.path, info.sourceInfo.baseDir, args)
					: expandTemplate(info.sourceInfo.path, args);
			return { kind: "ask", question: text, prompt };
		} catch (err) {
			return { kind: "keep", notice: `Could not read /${name}: ${err instanceof Error ? err.message : String(err)}` };
		}
	}
	if (info?.source === "extension" || name in PI_BUILTINS) {
		const why = `/${name} is a pi command and only runs from pi's editor, not inside an aside.`;
		if (name === "reload") return { kind: "done", notice: "Please run /reload from the main pane." };
		if (!host.ctx.ui.getEditorText().trim()) {
			host.ctx.ui.setEditorText(text);
			return { kind: "done", notice: `${why} It is waiting in pi's editor: close the asides with ctrl+d, then press enter.` };
		}
		return { kind: "keep", notice: `${why} pi's editor already has text, so it was not copied there. Close the asides with ctrl+d and run it there.` };
	}
	return undefined;
}

const piOnly = (description?: string) => `pi command, runs after you close the aside${description ? ` · ${description}` : ""}`;

/** The commands typed in an aside, as pi's autocomplete lists them. */
function slashCommands(host: CommandHost): SlashCommand[] {
	// Prefix matched: these are a few short words, where fuzzy matches mislead (`/aside s` matching close).
	const items = (values: string[], q: string, description?: (v: string) => string): AutocompleteItem[] =>
		values.filter((v) => v.startsWith(q.trim().toLowerCase())).map((v) => ({ value: v, label: v, description: description?.(v) }));
	const commands: SlashCommand[] = [
		{
			name: "model",
			description: ASIDE_COMMANDS.model,
			// The same items as pi's /model completion.
			getArgumentCompletions: (q) =>
				fuzzyFilter(host.ctx.modelRegistry.getAvailable() as Model[], q, (m) => `${modelKey(m)} ${m.name}`).map((m) => ({
					value: modelKey(m),
					label: m.id,
					description: m.provider,
				})),
		},
		{
			name: "thinking",
			description: ASIDE_COMMANDS.thinking,
			getArgumentCompletions: (q) => items(getSupportedThinkingLevels(host.level.model), q),
		},
		{
			name: "aside",
			description: ASIDE_COMMANDS.aside,
			getArgumentCompletions: (q) => items(ASIDE_VERB_NAMES, q, (v) => ASIDE_VERBS[v as AsideVerb]),
		},
	];
	for (const c of host.pi.getCommands()) {
		if (c.name in ASIDE_COMMANDS) continue;
		commands.push({ name: c.name, description: c.source === "extension" ? piOnly(c.description) : c.description });
	}
	for (const [name, description] of Object.entries(PI_BUILTINS)) commands.push({ name, description: piOnly(description) });
	return commands;
}

/**
 * pi's editor autocomplete, with the aside's commands: a command name or its arguments at the start
 * of the first line complete from the aside's commands; everything else (paths on tab, `@` files,
 * other extensions' completions) comes from `main`, the provider of pi's editor, unchanged.
 */
export function asideAutocomplete(host: CommandHost, main: AutocompleteProvider | undefined): AutocompleteProvider {
	const commands = new CombinedAutocompleteProvider(slashCommands(host), host.ctx.cwd);
	const rest: AutocompleteProvider = main ?? commands;
	let last: AutocompleteProvider = rest;
	return {
		triggerCharacters: rest.triggerCharacters,
		getSuggestions(lines, cursorLine, cursorCol, options) {
			const before = (lines[cursorLine] ?? "").slice(0, cursorCol);
			// As pi's editor decides: tab (force) after a command name completes paths, and `@` files.
			const command = cursorLine === 0 && !options.force && before.trimStart().startsWith("/") && !/(^|\s)@\S*$/.test(before);
			last = command ? commands : rest;
			return last.getSuggestions(lines, cursorLine, cursorCol, options);
		},
		applyCompletion: (...args) => last.applyCompletion(...args),
		shouldTriggerFileCompletion: (...args) => rest.shouldTriggerFileCompletion?.(...args) ?? true,
	};
}
