import { defineRegistry } from "@earendil-works/chord";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { PanelInfo, Variable } from "./common.js";

/**
 * What a plugin contributes to the app. These tokens are the only channel between
 * a plugin and the kernel besides the capability contracts: the kernel never knows
 * which plugin registered what, and a reload swaps the whole table at commit.
 *
 * Every registration must come from an object served with `{ lifetime: "host" }`.
 */

/** A variable an agent's templates may reference. `global: true` makes it visible to every agent. */
export type AgentVariable = Omit<Variable, "value"> & { value?: string };

/** How a plugin declares the agent it contributes. One definition = one agent instance. */
export interface AgentDefinition {
	/** Unique across all plugins. */
	id: string;
	/** Who contributed it; the registry cannot tell, so the plugin says so. */
	pluginId: string;
	/** Display name template; may reference {{variables}}. */
	name: string;
	/** One-line description template. */
	description: string;
	/** System prompt template; may reference {{variables}}. */
	systemPrompt: string;
	/** Variables this agent owns. */
	variables: AgentVariable[];
	/** Default model (`provider/id`), if the plugin has an opinion. */
	defaultModel?: { provider: string; id: string };
}

/** A tool a plugin offers. `agents` omitted means every agent may use it. */
export interface AgentToolContribution {
	tool: AgentTool;
	agents?: readonly string[];
}

/**
 * A set of tools computed at call time. Use this when the set changes while the plugin
 * runs (MCP servers come and go); the kernel re-reads it at the start of every turn.
 */
export interface AgentToolGroup {
	tools: () => AgentTool[];
	agents?: readonly string[];
}

/** A top-level panel in the web shell. The client maps `id` to a component. */
export type PanelContribution = PanelInfo;

export const AgentDefinitions = defineRegistry<AgentDefinition>("moonan.agents", { conflict: "error" });
export const AgentTools = defineRegistry<AgentToolContribution>("moonan.agent-tools", { conflict: "error" });
export const AgentToolGroups = defineRegistry<AgentToolGroup>("moonan.agent-tool-groups", { conflict: "error" });
export const Panels = defineRegistry<PanelContribution>("moonan.panels", { conflict: "error" });
