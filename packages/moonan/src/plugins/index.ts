import type { BuiltinPlugin } from "@moonan_ai/core";
import agents from "./agents/server.js";
import chat from "./chat/server.js";
import logs from "./logs/server.js";
import mcp from "./mcp/server.js";
import providers from "./providers/server.js";

export const VERSION = "0.0.1-alpha1";

/**
 * Order matters: `agents` registers the main agent before anything attaches a
 * tool to it. alpha1 ships only these five, and they are always on.
 */
export const builtinPlugins: BuiltinPlugin[] = [
	{ id: "agents", name: "Agent 管理", version: VERSION, facet: agents, hasWeb: true },
	{ id: "providers", name: "提供商", version: VERSION, facet: providers, hasWeb: true },
	{ id: "chat", name: "对话", version: VERSION, facet: chat, hasWeb: true },
	{ id: "mcp", name: "MCP", version: VERSION, facet: mcp, hasWeb: true },
	{ id: "logs", name: "日志", version: VERSION, facet: logs, hasWeb: true },
];
