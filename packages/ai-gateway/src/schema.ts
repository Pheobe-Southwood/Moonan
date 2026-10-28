import { Type, type Static } from "typebox";

/**
 * The data shape of the AI gateway.
 *
 * Everything in this file is shared by the server facet, the browser facet and the
 * tests. The schemas are not documentation: chord validates every cell write against
 * them, and the HTTP surface validates its inputs with them too.
 */

// ---------------------------------------------------------------------------
// Vocabularies, mirroring pi-ai 1.4.0
// ---------------------------------------------------------------------------

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export const REASONING_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
export const INPUT_MODALITIES = ["text", "image"] as const;
export const CACHE_RETENTIONS = ["none", "short", "long"] as const;
export const TRANSPORTS = ["auto", "sse", "websocket", "websocket-cached"] as const;
export const TOOL_CHOICES = ["auto", "none"] as const;
export const API_IDS = [
	"openai-completions",
	"openai-responses",
	"azure-openai-responses",
	"openai-codex-responses",
	"anthropic-messages",
	"google-generative-ai",
	"google-vertex",
	"mistral-conversations",
	"bedrock-converse-stream",
	"pi-messages",
] as const;

export type ThinkingLevel = (typeof THINKING_LEVELS)[number];
export type InputModality = (typeof INPUT_MODALITIES)[number];
export type CacheRetention = (typeof CACHE_RETENTIONS)[number];
export type Transport = (typeof TRANSPORTS)[number];
export type ToolChoice = (typeof TOOL_CHOICES)[number];

export const ThinkingLevelSchema = Type.Union([
	Type.Literal("off"),
	Type.Literal("minimal"),
	Type.Literal("low"),
	Type.Literal("medium"),
	Type.Literal("high"),
	Type.Literal("xhigh"),
	Type.Literal("max"),
]);
export const InputModalitySchema = Type.Union([Type.Literal("text"), Type.Literal("image")]);
export const CacheRetentionSchema = Type.Union([
	Type.Literal("none"),
	Type.Literal("short"),
	Type.Literal("long"),
]);
export const TransportSchema = Type.Union([
	Type.Literal("auto"),
	Type.Literal("sse"),
	Type.Literal("websocket"),
	Type.Literal("websocket-cached"),
]);
export const ToolChoiceSchema = Type.Union([Type.Literal("auto"), Type.Literal("none")]);
export const ReasoningLevelSchema = Type.Union([
	Type.Literal("minimal"),
	Type.Literal("low"),
	Type.Literal("medium"),
	Type.Literal("high"),
	Type.Literal("xhigh"),
	Type.Literal("max"),
]);

export const API_LABELS: Record<string, string> = {
	"openai-completions": "OpenAI Chat Completions",
	"openai-responses": "OpenAI Responses",
	"azure-openai-responses": "Azure OpenAI Responses",
	"openai-codex-responses": "OpenAI Codex Responses",
	"anthropic-messages": "Anthropic Messages",
	"google-generative-ai": "Google Generative AI",
	"google-vertex": "Google Vertex AI",
	"mistral-conversations": "Mistral Conversations",
	"bedrock-converse-stream": "AWS Bedrock Converse",
	"pi-messages": "Pi Messages",
};

// ---------------------------------------------------------------------------
// JSON helpers
// ---------------------------------------------------------------------------

/** An arbitrary JSON value. Used for pi-ai's open-ended maps (`samplingParams`, `compat`, …). */
export const JsonValueSchema = Type.Any();

const StringMapSchema = Type.Record(Type.String(), Type.String());
const HeaderMapSchema = Type.Record(Type.String(), Type.Union([Type.String(), Type.Null()]));
const JsonMapSchema = Type.Record(Type.String(), JsonValueSchema);

// ---------------------------------------------------------------------------
// Model parameters
// ---------------------------------------------------------------------------

export const ModelCostRatesSchema = Type.Object(
	{
		input: Type.Number({ minimum: 0 }),
		output: Type.Number({ minimum: 0 }),
		cacheRead: Type.Number({ minimum: 0 }),
		cacheWrite: Type.Number({ minimum: 0 }),
	},
	{ additionalProperties: false },
);

export const ModelCostTierSchema = Type.Object(
	{
		input: Type.Number({ minimum: 0 }),
		output: Type.Number({ minimum: 0 }),
		cacheRead: Type.Number({ minimum: 0 }),
		cacheWrite: Type.Number({ minimum: 0 }),
		inputTokensAbove: Type.Number({ minimum: 0 }),
	},
	{ additionalProperties: false },
);

export const ModelCostSchema = Type.Object(
	{
		input: Type.Number({ minimum: 0 }),
		output: Type.Number({ minimum: 0 }),
		cacheRead: Type.Number({ minimum: 0 }),
		cacheWrite: Type.Number({ minimum: 0 }),
		tiers: Type.Optional(Type.Array(ModelCostTierSchema)),
	},
	{ additionalProperties: false },
);

export const ModelImageResizeSchema = Type.Object(
	{
		maxWidth: Type.Optional(Type.Integer({ minimum: 1 })),
		maxHeight: Type.Optional(Type.Integer({ minimum: 1 })),
		maxBytes: Type.Optional(Type.Integer({ minimum: 1 })),
		jpegQuality: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
	},
	{ additionalProperties: false },
);

export const ModelInputLimitsSchema = Type.Object(
	{
		maxRequestBytes: Type.Optional(Type.Integer({ minimum: 1 })),
		images: Type.Optional(
			Type.Object(
				{
					maxPerMessage: Type.Optional(Type.Integer({ minimum: 1 })),
					maxPerRequest: Type.Optional(Type.Integer({ minimum: 1 })),
					resize: Type.Optional(ModelImageResizeSchema),
				},
				{ additionalProperties: false },
			),
		),
	},
	{ additionalProperties: false },
);

export const ThinkingLevelMapSchema = Type.Object(
	{
		off: Type.Optional(Type.Union([Type.String(), Type.Null()])),
		minimal: Type.Optional(Type.Union([Type.String(), Type.Null()])),
		low: Type.Optional(Type.Union([Type.String(), Type.Null()])),
		medium: Type.Optional(Type.Union([Type.String(), Type.Null()])),
		high: Type.Optional(Type.Union([Type.String(), Type.Null()])),
		xhigh: Type.Optional(Type.Union([Type.String(), Type.Null()])),
		max: Type.Optional(Type.Union([Type.String(), Type.Null()])),
	},
	{ additionalProperties: false },
);

export const PromptCacheSchema = Type.Object(
	{
		short: Type.Optional(Type.Number({ minimum: 0 })),
		long: Type.Optional(Type.Number({ minimum: 0 })),
	},
	{ additionalProperties: false },
);

export const SamplingParamsByLevelSchema = Type.Record(Type.String(), JsonMapSchema);

/** One chat model, exactly the fields pi-ai's `Model` carries. */
export const ModelConfigSchema = Type.Object(
	{
		id: Type.String({ minLength: 1 }),
		name: Type.String({ minLength: 1 }),
		/** Defaults to the provider's API when omitted. */
		api: Type.Optional(Type.String({ minLength: 1 })),
		/** A per-model endpoint override; the provider's Base URL is used when omitted. */
		baseUrl: Type.Optional(Type.String()),
		/** Chat is the default model type in pi-ai; keep it explicit in the file. */
		type: Type.Optional(Type.Literal("chat")),
		input: Type.Array(InputModalitySchema, { minItems: 1 }),
		inputLimits: Type.Optional(ModelInputLimitsSchema),
		cost: ModelCostSchema,
		contextWindow: Type.Integer({ minimum: 1 }),
		maxTokens: Type.Integer({ minimum: 1 }),
		reasoning: Type.Boolean(),
		thinkingLevelMap: Type.Optional(ThinkingLevelMapSchema),
		promptCache: Type.Optional(PromptCacheSchema),
		samplingParams: Type.Optional(JsonMapSchema),
		samplingParamsByThinkingLevel: Type.Optional(SamplingParamsByLevelSchema),
		/** pi-ai's per-API compatibility overrides. Kept open-ended on purpose. */
		compat: Type.Optional(JsonMapSchema),
		headers: Type.Optional(StringMapSchema),
		createdAt: Type.Optional(Type.String()),
		updatedAt: Type.Optional(Type.String()),
	},
	{ additionalProperties: false },
);

export type ModelConfig = Static<typeof ModelConfigSchema>;

// ---------------------------------------------------------------------------
// Providers and the on-disk gateway configuration
// ---------------------------------------------------------------------------

export const ProviderSourceSchema = Type.Union([Type.Literal("builtin"), Type.Literal("custom")]);
export type ProviderSource = Static<typeof ProviderSourceSchema>;

export const AuthKindSchema = Type.Union([
	Type.Literal("api-key"),
	Type.Literal("api-key+oauth"),
	Type.Literal("oauth"),
]);
export type AuthKind = Static<typeof AuthKindSchema>;

export const ProviderConfigSchema = Type.Object(
	{
		id: Type.String({ minLength: 1 }),
		name: Type.String({ minLength: 1 }),
		source: ProviderSourceSchema,
		/** Set for a provider added from pi-ai's built-in catalogue. */
		presetId: Type.Optional(Type.String()),
		enabled: Type.Boolean(),
		api: Type.String({ minLength: 1 }),
		baseUrl: Type.String(),
		/** Stored server-side only; never included in a snapshot or HTTP response. */
		apiKey: Type.Optional(Type.String()),
		keyUpdatedAt: Type.Optional(Type.String()),
		headers: Type.Optional(HeaderMapSchema),
		env: Type.Optional(StringMapSchema),
		models: Type.Array(ModelConfigSchema),
		createdAt: Type.Optional(Type.String()),
		updatedAt: Type.Optional(Type.String()),
	},
	{ additionalProperties: false },
);

export type ProviderConfig = Static<typeof ProviderConfigSchema>;

export const GatewaySettingsSchema = Type.Object(
	{
		discoveryTimeoutMs: Type.Integer({ minimum: 1_000, maximum: 120_000 }),
		requestDefaults: Type.Object(
			{
				temperature: Type.Optional(Type.Number({ minimum: 0, maximum: 2 })),
				maxTokens: Type.Optional(Type.Integer({ minimum: 1 })),
				transport: Type.Optional(TransportSchema),
				cacheRetention: Type.Optional(CacheRetentionSchema),
				timeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
				maxRetries: Type.Optional(Type.Integer({ minimum: 0 })),
				maxRetryDelayMs: Type.Optional(Type.Integer({ minimum: 0 })),
				websocketConnectTimeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
				toolChoice: Type.Optional(ToolChoiceSchema),
				reasoning: Type.Optional(ReasoningLevelSchema),
				thinkingBudgets: Type.Optional(
					Type.Object(
						{
							minimal: Type.Optional(Type.Integer({ minimum: 1 })),
							low: Type.Optional(Type.Integer({ minimum: 1 })),
							medium: Type.Optional(Type.Integer({ minimum: 1 })),
							high: Type.Optional(Type.Integer({ minimum: 1 })),
						},
						{ additionalProperties: false },
					),
				),
				deferred: Type.Optional(Type.Boolean()),
				metadata: Type.Optional(JsonMapSchema),
				samplingParams: Type.Optional(JsonMapSchema),
			},
			{ additionalProperties: false },
		),
	},
	{ additionalProperties: false },
);

export type GatewaySettings = Static<typeof GatewaySettingsSchema>;
export type RequestDefaults = GatewaySettings["requestDefaults"];

export const GatewayConfigSchema = Type.Object(
	{
		version: Type.Literal(1),
		providers: Type.Array(ProviderConfigSchema),
		settings: GatewaySettingsSchema,
		createdAt: Type.String(),
		updatedAt: Type.String(),
	},
	{ additionalProperties: false },
);

export type GatewayConfig = Static<typeof GatewayConfigSchema>;

// ---------------------------------------------------------------------------
// Views and options sent to the browser
// ---------------------------------------------------------------------------

export const ProviderViewSchema = Type.Object(
	{
		id: Type.String(),
		name: Type.String(),
		source: ProviderSourceSchema,
		presetId: Type.Optional(Type.String()),
		enabled: Type.Boolean(),
		api: Type.String(),
		baseUrl: Type.String(),
		headers: Type.Optional(HeaderMapSchema),
		env: Type.Optional(StringMapSchema),
		hasKey: Type.Boolean(),
		keyHint: Type.Optional(Type.String()),
		keyUpdatedAt: Type.Optional(Type.String()),
		authKind: AuthKindSchema,
		models: Type.Array(ModelConfigSchema),
		createdAt: Type.Optional(Type.String()),
		updatedAt: Type.Optional(Type.String()),
	},
	{ additionalProperties: false },
);

export type ProviderView = Static<typeof ProviderViewSchema>;

export const PresetSummarySchema = Type.Object(
	{
		id: Type.String(),
		name: Type.String(),
		baseUrl: Type.Optional(Type.String()),
		authKind: AuthKindSchema,
		modelCount: Type.Integer({ minimum: 0 }),
		apis: Type.Array(Type.String()),
	},
	{ additionalProperties: false },
);

export type PresetSummary = Static<typeof PresetSummarySchema>;

export const CompatFieldSchema = Type.Object(
	{
		key: Type.String(),
		label: Type.String(),
		kind: Type.Union([
			Type.Literal("boolean"),
			Type.Literal("enum"),
			Type.Literal("number"),
			Type.Literal("string"),
			Type.Literal("json"),
		]),
		options: Type.Optional(Type.Array(Type.String())),
		description: Type.Optional(Type.String()),
		default: Type.Optional(JsonValueSchema),
	},
	{ additionalProperties: false },
);

export type CompatField = Static<typeof CompatFieldSchema>;

export const ApiOptionSchema = Type.Object(
	{
		id: Type.String(),
		label: Type.String(),
		compatFields: Type.Array(CompatFieldSchema),
	},
	{ additionalProperties: false },
);

export type ApiOption = Static<typeof ApiOptionSchema>;

export const GatewayOptionsSchema = Type.Object(
	{
		apis: Type.Array(ApiOptionSchema),
		thinkingLevels: Type.Array(Type.String()),
		inputModalities: Type.Array(Type.String()),
		cacheRetentions: Type.Array(Type.String()),
		transports: Type.Array(Type.String()),
		toolChoices: Type.Array(Type.String()),
	},
	{ additionalProperties: false },
);

export type GatewayOptions = Static<typeof GatewayOptionsSchema>;

export const StorageInfoSchema = Type.Object(
	{
		configPath: Type.String(),
		backupPath: Type.String(),
		directory: Type.String(),
		exists: Type.Boolean(),
		mode: Type.Optional(Type.String()),
		writable: Type.Boolean(),
		lastSavedAt: Type.Optional(Type.String()),
		notice: Type.Optional(Type.String()),
	},
	{ additionalProperties: false },
);

export type StorageInfo = Static<typeof StorageInfoSchema>;

export const GatewaySnapshotSchema = Type.Object(
	{
		version: Type.String(),
		generatedAt: Type.String(),
		providers: Type.Array(ProviderViewSchema),
		presets: Type.Array(PresetSummarySchema),
		settings: GatewaySettingsSchema,
		storage: StorageInfoSchema,
		options: GatewayOptionsSchema,
	},
	{ additionalProperties: false },
);

export type GatewaySnapshot = Static<typeof GatewaySnapshotSchema>;

// ---------------------------------------------------------------------------
// Method inputs and discovery results
// ---------------------------------------------------------------------------

export const ProviderIdInputSchema = Type.Object({ id: Type.String({ minLength: 1 }) }, { additionalProperties: false });

export const AddBuiltinProviderInputSchema = Type.Object(
	{ presetId: Type.String({ minLength: 1 }) },
	{ additionalProperties: false },
);

export const AddProviderInputSchema = Type.Object(
	{
		id: Type.String({ minLength: 1 }),
		name: Type.Optional(Type.String()),
		api: Type.String({ minLength: 1 }),
		baseUrl: Type.String(),
		apiKey: Type.Optional(Type.String()),
		headers: Type.Optional(HeaderMapSchema),
		env: Type.Optional(StringMapSchema),
	},
	{ additionalProperties: false },
);

export const ProviderPatchSchema = Type.Object(
	{
		name: Type.Optional(Type.String({ minLength: 1 })),
		api: Type.Optional(Type.String({ minLength: 1 })),
		baseUrl: Type.Optional(Type.String()),
		enabled: Type.Optional(Type.Boolean()),
		headers: Type.Optional(HeaderMapSchema),
		env: Type.Optional(StringMapSchema),
		/** Empty string clears the stored key. */
		apiKey: Type.Optional(Type.String()),
	},
	{ additionalProperties: false },
);

export const SaveProviderInputSchema = Type.Object(
	{ id: Type.String({ minLength: 1 }), patch: ProviderPatchSchema },
	{ additionalProperties: false },
);

export const SetProviderEnabledInputSchema = Type.Object(
	{ id: Type.String({ minLength: 1 }), enabled: Type.Boolean() },
	{ additionalProperties: false },
);

export const SaveModelInputSchema = Type.Object(
	{
		providerId: Type.String({ minLength: 1 }),
		model: ModelConfigSchema,
		/** Present when the id was edited; the old id is removed in the same write. */
		previousId: Type.Optional(Type.String()),
	},
	{ additionalProperties: false },
);

export const DeleteModelInputSchema = Type.Object(
	{ providerId: Type.String({ minLength: 1 }), modelId: Type.String({ minLength: 1 }) },
	{ additionalProperties: false },
);

export const DiscoveredModelSchema = Type.Object(
	{
		id: Type.String({ minLength: 1 }),
		name: Type.String(),
		api: Type.Optional(Type.String()),
		contextWindow: Type.Optional(Type.Integer({ minimum: 1 })),
		maxTokens: Type.Optional(Type.Integer({ minimum: 1 })),
		input: Type.Optional(Type.Array(InputModalitySchema)),
		reasoning: Type.Optional(Type.Boolean()),
		cost: Type.Optional(ModelCostSchema),
		ownedBy: Type.Optional(Type.String()),
		created: Type.Optional(Type.Number()),
	},
	{ additionalProperties: false },
);

export type DiscoveredModel = Static<typeof DiscoveredModelSchema>;

export const DiscoveryResultSchema = Type.Object(
	{
		providerId: Type.String(),
		endpoint: Type.String(),
		fetchedAt: Type.String(),
		source: Type.Union([Type.Literal("upstream"), Type.Literal("catalog")]),
		models: Type.Array(
			Type.Object(
				{
					id: Type.String(),
					name: Type.String(),
					api: Type.Optional(Type.String()),
					contextWindow: Type.Optional(Type.Integer()),
					maxTokens: Type.Optional(Type.Integer()),
					input: Type.Optional(Type.Array(InputModalitySchema)),
					reasoning: Type.Optional(Type.Boolean()),
					cost: Type.Optional(ModelCostSchema),
					ownedBy: Type.Optional(Type.String()),
					created: Type.Optional(Type.Number()),
					alreadyConfigured: Type.Boolean(),
				},
				{ additionalProperties: false },
			),
		),
		warnings: Type.Array(Type.String()),
	},
	{ additionalProperties: false },
);

export type DiscoveryResult = Static<typeof DiscoveryResultSchema>;

export const ImportModelsInputSchema = Type.Object(
	{
		providerId: Type.String({ minLength: 1 }),
		models: Type.Array(DiscoveredModelSchema),
		mode: Type.Union([Type.Literal("skip"), Type.Literal("replace")]),
	},
	{ additionalProperties: false },
);

export const ImportResultSchema = Type.Object(
	{
		added: Type.Integer(),
		skipped: Type.Integer(),
		replaced: Type.Integer(),
		total: Type.Integer(),
	},
	{ additionalProperties: false },
);

export type ImportResult = Static<typeof ImportResultSchema>;

export const SaveSettingsInputSchema = Type.Object(
	{ settings: GatewaySettingsSchema },
	{ additionalProperties: false },
);

export const GatewayHealthSchema = Type.Object(
	{
		ok: Type.Boolean(),
		version: Type.String(),
		configPath: Type.String(),
		providers: Type.Integer(),
		enabledProviders: Type.Integer(),
		models: Type.Integer(),
		updatedAt: Type.String(),
	},
	{ additionalProperties: false },
);

export type GatewayHealth = Static<typeof GatewayHealthSchema>;
