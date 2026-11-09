/** Tool calls in an aside: their line in the thread, and what they changed outside the aside. */

import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import { shortLine } from "../context/text.ts";

// biome-ignore lint/suspicious/noExplicitAny: tool arguments and results are untyped JSON
type Json = any;

/** Arguments that say what a call is about, in display order. */
const SALIENT_ARGS = ["command", "tool", "search", "describe", "pattern", "query", "path", "url"];

/** One-line description of a call, shown in the thread. */
export function toolCallLine(name: string, args: Json): string {
	const a = args ?? {};
	const salient = SALIENT_ARGS.filter((k) => typeof a[k] === "string").map((k) => (k === "pattern" ? JSON.stringify(a[k]) : a[k]));
	return `${name} ${shortLine(salient.length ? salient.join(" ") : JSON.stringify(a), 160)}`;
}

/**
 * Something a call may have changed.
 * - `local`: files edited or written, or changed by shell commands the user asked for; the main agent's view may be stale.
 * - `external`: data in another system, through an MCP call or code that calls tools, which acts.
 */
export interface Change {
	kind: "local" | "external";
	text: string;
}

/**
 * What a finished call changed, if anything, from what pi says about the tool. Shell commands are
 * judged per answer (`command-check.ts`).
 * - A failed edit or write changed nothing.
 * - Other calls count only when they succeeded and are not known to be read-only: tools in an MCP
 *   namespace (`mcp__<server>`), and tools that reach other tools (`reachesTools`, e.g. pi's
 *   codemode), which are judged by the code they run.
 */
export function changeOf(name: string, args: Json, isError: boolean, info: ToolInfo | undefined): Change | undefined {
	const a = args ?? {};
	if (name === "edit") return isError ? undefined : local(`edited ${a.path}`);
	if (name === "write") return isError ? undefined : local(`wrote ${a.path}`);
	if (isError || !info || info.annotations?.readOnlyHint) return undefined;
	if (info.reachesTools) {
		if (typeof a.code === "string") return codeActs(a.code) ? external(`ran ${name}: ${shortLine(a.code, 200)}`) : undefined;
		return acts(name, a) ? external(`called ${name} with ${shortLine(JSON.stringify(a), 200)}`) : undefined;
	}
	if (info.namespace?.name.startsWith("mcp__") && acts(name, a)) return external(`called ${name} with ${shortLine(JSON.stringify(a), 200)}`);
	return undefined;
}

/** Whether calling `tool` with `args` may change something. A tool that runs code is judged by the code. */
function acts(tool: string, args: Json): boolean {
	if (typeof args?.code === "string" && /(^|_)(execute|exec|run|eval)(_|$)/i.test(tool)) return codeActs(args.code);
	return !isReadOnlyName(tool);
}

/**
 * Whether code (a codemode script, or code sent to a server's execute tool) may change something:
 * it calls a tool not named as read-only, or calls one whose name it computes.
 */
function codeActs(code: string): boolean {
	if (/\btools\.call\(\s*[^'"`\s]/.test(code)) return true;
	const named = [...code.matchAll(/\btools\.call\(\s*['"`]([^'"`]+)['"`]/g)].map((m) => m[1]);
	const direct = [...code.matchAll(/\b(?:tools|codemode)\.(\w+)\s*\(/g)].map((m) => m[1]).filter((n) => !CODE_HELPERS.has(n));
	return [...named, ...direct].some((n) => !isReadOnlyName(n));
}

/** Helpers of code-mode APIs that look things up but are not tools. */
const CODE_HELPERS = new Set(["call", "search", "describe", "tools", "searchTools", "describeTool", "describeNamespace"]);

/** Words that mark a lookup, and words that mark an action; an action word always wins. */
const READ_WORDS = new Set(
	"get list search find describe read fetch query show view lookup status inspect count explain grep browse preview diff whoami ping".split(" "),
);
const ACT_WORDS = new Set(
	(
		"create update delete remove set add post put patch send write edit toggle enable disable merge close reopen approve reject run " +
		"execute exec eval apply deploy restart start stop cancel upload publish comment assign move rename insert push trigger scale " +
		"kill install uninstall revoke grant invite archive restore reset sync import submit save mutate modify replace drop upsert " +
		"transition rerun retry ack acknowledge resolve snooze mark"
	).split(" "),
);

/**
 * MCP servers rarely declare read-only tools, so a tool is taken as one when its name has a lookup
 * word (`get_issue`, `search_wiki`, `listServers`) and no action word. Anything else may act.
 */
function isReadOnlyName(tool: string): boolean {
	const words = tool
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.toLowerCase()
		.split(/[^a-z0-9]+/);
	return words.some((w) => READ_WORDS.has(w)) && !words.some((w) => ACT_WORDS.has(w));
}

export const local = (text: string): Change => ({ kind: "local", text });
const external = (text: string): Change => ({ kind: "external", text });

/** The note that tells the main agent what its asides changed. */
export function changesNote(changes: Change[]): string {
	const list = (kind: Change["kind"]) => [...new Set(changes.filter((c) => c.kind === kind).map((c) => `- ${c.text}`))].join("\n");
	const sections = ["An aside made changes outside this conversation."];
	const files = list("local");
	if (files) {
		sections.push(`Files and commands. Your view of these files may be out of date: re-read them before relying on them or editing them.\n${files}`);
	}
	const outside = list("external");
	if (outside) {
		sections.push(`MCP calls and code that may have changed data outside the working directory. Check before relying on that data.\n${outside}`);
	}
	return sections.join("\n\n");
}
