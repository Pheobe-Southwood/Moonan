import { Type, type Static } from "typebox";

/** Anything the wire can carry. Chord's JSON boundary rejects functions and class instances. */
export const AnyJsonSchema = Type.Any();

export const ModelRefSchema = Type.Object({
	provider: Type.String(),
	id: Type.String(),
});
export type ModelRef = Static<typeof ModelRefSchema>;

export const ModelInfoSchema = Type.Object({
	id: Type.String(),
	name: Type.String(),
	contextWindow: Type.Number(),
	maxTokens: Type.Number(),
	reasoning: Type.Boolean(),
});
export type ModelInfo = Static<typeof ModelInfoSchema>;

export const VariableSchema = Type.Object({
	key: Type.String(),
	label: Type.String(),
	type: Type.Union([Type.Literal("text"), Type.Literal("textarea")]),
	value: Type.String(),
	/** Scene variables are visible to every agent, not just the owning one. */
	global: Type.Optional(Type.Boolean()),
	placeholder: Type.Optional(Type.String()),
});
export type Variable = Static<typeof VariableSchema>;

export const AgentStatusSchema = Type.Union([
	Type.Literal("idle"),
	Type.Literal("queued"),
	Type.Literal("streaming"),
	Type.Literal("error"),
]);
export type AgentStatus = Static<typeof AgentStatusSchema>;

export const AgentConfigSchema = Type.Object({
	name: Type.String(),
	description: Type.String(),
	systemPrompt: Type.String(),
	variables: Type.Array(VariableSchema),
	model: Type.Union([ModelRefSchema, Type.Null()]),
});
export type AgentConfig = Static<typeof AgentConfigSchema>;

export const AgentConfigPatchSchema = Type.Partial(AgentConfigSchema);
export type AgentConfigPatch = Static<typeof AgentConfigPatchSchema>;

export const AgentSummarySchema = Type.Object({
	id: Type.String(),
	pluginId: Type.String(),
	name: Type.String(),
	description: Type.String(),
	model: Type.Union([ModelRefSchema, Type.Null()]),
	status: AgentStatusSchema,
	/** True when the agent still needs a model before it can be used. */
	needsModel: Type.Boolean(),
});
export type AgentSummary = Static<typeof AgentSummarySchema>;

export const LiveToolSchema = Type.Object({
	id: Type.String(),
	name: Type.String(),
	args: Type.String(),
	state: Type.Union([Type.Literal("running"), Type.Literal("done"), Type.Literal("error")]),
	result: Type.Optional(Type.String()),
});
export type LiveTool = Static<typeof LiveToolSchema>;

export const LiveMessageSchema = Type.Object({
	/** Bumped on every new assistant message so clients can reset their view. */
	turn: Type.Number(),
	text: Type.String(),
	thinking: Type.String(),
	tools: Type.Array(LiveToolSchema),
	error: Type.Optional(Type.String()),
});
export type LiveMessage = Static<typeof LiveMessageSchema>;

export const ChatMessageSchema = Type.Object({
	seq: Type.Number(),
	/** `in` is the person, `out` is the character. */
	direction: Type.Union([Type.Literal("in"), Type.Literal("out")]),
	text: Type.String(),
	createdAt: Type.Number(),
});
export type ChatMessage = Static<typeof ChatMessageSchema>;

export const SendModeSchema = Type.Union([Type.Literal("steer"), Type.Literal("followUp")]);
export type SendMode = Static<typeof SendModeSchema>;

export const TranscriptEntrySchema = Type.Object({
	seq: Type.Number(),
	role: Type.Union([
		Type.Literal("system"),
		Type.Literal("user"),
		Type.Literal("assistant"),
		Type.Literal("toolResult"),
	]),
	/** The raw pi-ai message, verbatim. Rendered by the log view. */
	message: AnyJsonSchema,
	createdAt: Type.Number(),
});
export type TranscriptEntry = Static<typeof TranscriptEntrySchema>;

export const ProviderKindSchema = Type.Union([Type.Literal("builtin"), Type.Literal("custom")]);

export const ProviderInfoSchema = Type.Object({
	id: Type.String(),
	name: Type.String(),
	kind: ProviderKindSchema,
	hasKey: Type.Boolean(),
	/** True when the provider has an OAuth login pi-ai could support; the UI only shows a placeholder for now. */
	oauth: Type.Boolean(),
	api: Type.Optional(Type.String()),
	baseUrl: Type.Optional(Type.String()),
});
export type ProviderInfo = Static<typeof ProviderInfoSchema>;

export const CustomProviderInputSchema = Type.Object({
	id: Type.String(),
	name: Type.String(),
	baseUrl: Type.String(),
	api: Type.String(),
	models: Type.Array(
		Type.Object({
			id: Type.String(),
			name: Type.Optional(Type.String()),
			contextWindow: Type.Optional(Type.Number()),
			maxTokens: Type.Optional(Type.Number()),
			reasoning: Type.Optional(Type.Boolean()),
		}),
	),
});
export type CustomProviderInput = Static<typeof CustomProviderInputSchema>;

export const McpServerInputSchema = Type.Object({
	name: Type.String(),
	transport: Type.Union([Type.Literal("stdio"), Type.Literal("http")]),
	command: Type.Optional(Type.String()),
	args: Type.Optional(Type.Array(Type.String())),
	env: Type.Optional(Type.Record(Type.String(), Type.String())),
	url: Type.Optional(Type.String()),
	headers: Type.Optional(Type.Record(Type.String(), Type.String())),
});
export type McpServerInput = Static<typeof McpServerInputSchema>;

export const McpToolStateSchema = Type.Object({
	name: Type.String(),
	description: Type.String(),
	enabled: Type.Boolean(),
});
export type McpToolState = Static<typeof McpToolStateSchema>;

export const McpServerStateSchema = Type.Object({
	id: Type.String(),
	name: Type.String(),
	transport: Type.Union([Type.Literal("stdio"), Type.Literal("http")]),
	/** What the user should see, e.g. the command line or the URL. */
	target: Type.String(),
	status: Type.Union([
		Type.Literal("idle"),
		Type.Literal("connecting"),
		Type.Literal("connected"),
		Type.Literal("error"),
	]),
	error: Type.Optional(Type.String()),
	tools: Type.Array(McpToolStateSchema),
});
export type McpServerState = Static<typeof McpServerStateSchema>;

export const PluginInfoSchema = Type.Object({
	id: Type.String(),
	name: Type.String(),
	version: Type.String(),
	source: Type.Union([Type.Literal("builtin"), Type.Literal("disk")]),
	hasWeb: Type.Boolean(),
	error: Type.Optional(Type.String()),
});
export type PluginInfo = Static<typeof PluginInfoSchema>;
