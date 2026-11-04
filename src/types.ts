import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export type Model = NonNullable<ExtensionContext["model"]>;
export type ThinkingLevel = ReturnType<ExtensionAPI["getThinkingLevel"]>;
