import type { BuiltinPlugin } from "@moonan_ai/core";
import { facetModuleUrl } from "./module-url.js";

export const VERSION = "0.0.1-alpha4";

/**
 * The five built-in plugins. They load through the same module path as a disk plugin;
 * only the source of the URL differs. Order is irrelevant now that contributions go
 * through registries, but `agents` stays first so the main agent exists early.
 */
export const builtinPlugins: BuiltinPlugin[] = [
	{ id: "agents", name: "Agent 管理", version: VERSION, module: facetModuleUrl("./agents/server.js"), hasWeb: true },
	{ id: "providers", name: "提供商", version: VERSION, module: facetModuleUrl("./providers/server.js"), hasWeb: true },
	{ id: "chat", name: "对话", version: VERSION, module: facetModuleUrl("./chat/server.js"), hasWeb: true },
	{ id: "mcp", name: "MCP", version: VERSION, module: facetModuleUrl("./mcp/server.js"), hasWeb: true },
	{ id: "logs", name: "日志", version: VERSION, module: facetModuleUrl("./logs/server.js"), hasWeb: true },
];
