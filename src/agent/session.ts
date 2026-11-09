/**
 * Each aside answers through its own in-memory pi agent session. It loads the user's extensions
 * (except this one) and has the main agent's active tools plus pi's file and shell tools, so asides
 * get MCP servers and every extension's tools and hooks.
 */

import { realpathSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { clampThinkingLevel } from "@earendil-works/pi-ai";
import {
	type AgentSession,
	createAgentSession,
	DefaultResourceLoader,
	type Extension,
	type ExtensionAPI,
	getAgentDir,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { SHUTDOWN_WAIT_MS } from "../config.ts";
import type { AsideLevel } from "../level.ts";
import type { Model, ThinkingLevel } from "../types.ts";
import { asideInstructions } from "./prompts.ts";

/** Tools every aside has, on top of the main agent's active tools. */
const BASE_TOOLS = ["read", "grep", "find", "ls", "bash", "edit", "write"];

const realPath = (path: string) => {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
};
/** This extension's root directory (two up from this file), to leave it out of aside sessions. */
const OWN_ROOT = resolve(dirname(realPath(fileURLToPath(import.meta.url))), "../..") + sep;

async function createAsideSession(pi: ExtensionAPI, cwd: string, depth: number): Promise<AgentSession> {
	const agentDir = getAgentDir();
	const settingsManager = SettingsManager.create(cwd, agentDir);
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		// Keeps pi's prompt (tool list, guidelines, rules, the user's SYSTEM.md and APPEND_SYSTEM.md)
		// and adds the aside's instructions before the context files and skills.
		appendSystemPromptOverride: (base) => [...base, asideInstructions(depth)],
		// Inside an aside session this extension would only register keys and commands that never run.
		extensionsOverride: (base) => ({
			...base,
			extensions: base.extensions.filter((e) => !realPath(e.resolvedPath).startsWith(OWN_ROOT)),
		}),
	});
	await resourceLoader.reload();
	const { session } = await createAgentSession({
		cwd,
		agentDir,
		settingsManager,
		resourceLoader,
		sessionManager: SessionManager.inMemory(cwd),
		tools: [...new Set([...BASE_TOOLS, ...pi.getActiveTools()])],
	});
	// Starts the extensions (MCP clients, providers) without UI: the aside owns the screen.
	await session.bindExtensions({});
	return session;
}

/**
 * Release a session the way pi's runtime does on quit: extensions get `session_shutdown` (to stop
 * timers and finish their work) before `dispose()` makes their ctx stale. A ctx an extension uses
 * after that throws, and from a timer that brings down pi.
 *
 * Defensive against any extension. pi runs the handlers one after another, so one that never
 * settles would keep every later extension from cleaning up. Here each extension gets the event on
 * its own (its handlers in order, as in pi), all at once; a handler that throws is reported like pi
 * reports it, and extensions still busy after SHUTDOWN_WAIT_MS are given up on, so the session is
 * always disposed.
 */
export async function closeSession(session: AgentSession) {
	const runner = session.extensionRunner;
	const event = { type: "session_shutdown", reason: "quit" } as const;
	const shutDown = async (extension: Extension) => {
		const handlers = extension.handlers.get(event.type)?.slice() ?? [];
		if (!handlers.length) return;
		const ctx = runner.createContext();
		for (const handler of handlers) {
			try {
				await handler(event, ctx);
			} catch (err) {
				runner.emitError({
					extensionPath: extension.path,
					event: event.type,
					error: err instanceof Error ? err.message : String(err),
					stack: err instanceof Error ? err.stack : undefined,
				});
			}
		}
	};
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			Promise.allSettled(session.resourceLoader.getExtensions().extensions.map(shutDown)),
			new Promise((resolve) => {
				timer = setTimeout(resolve, SHUTDOWN_WAIT_MS);
				timer.unref?.();
			}),
		]);
	} finally {
		clearTimeout(timer);
		session.dispose();
	}
}

/**
 * The level's session, started on first use. Called when a level opens so the first answer does
 * not wait for it; a failed start is retried by the next call.
 */
export function levelSession(pi: ExtensionAPI, cwd: string, level: AsideLevel): Promise<AgentSession> {
	if (!level.session) {
		const session = createAsideSession(pi, cwd, level.depth);
		level.session = session;
		session.catch(() => {
			if (level.session === session) level.session = undefined;
		});
	}
	return level.session;
}

/** Point the session at the aside model and thinking level. */
export async function applyModel(session: AgentSession, model: Model, thinking: ThinkingLevel) {
	if (session.model?.provider !== model.provider || session.model?.id !== model.id) {
		const available = await session.modelRuntime.getAvailable();
		const match = available.find((m) => m.provider === model.provider && m.id === model.id);
		if (!match) throw new Error(`${model.provider}/${model.id} is not available to asides`);
		await session.setModel(match);
	}
	session.setThinkingLevel(clampThinkingLevel(model, thinking));
}
