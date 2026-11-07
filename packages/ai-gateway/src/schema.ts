import {
	arr,
	bool,
	int,
	literal,
	nul,
	num,
	obj,
	opt,
	record,
	str,
	union,
	unknown,
	type Static,
} from "@moonan_ai/sdk";

/**
 * The data shape of the AI gateway.
 *
 * Everything in this file is shared by the server facet, the browser facet and the
 * tests. The schemas are not documentation: chord validates every cell write against
 * them, and the HTTP surface validates its inputs with them too.
 */

// ---------------------------------------------------------------------------
// Vocabularies, mirroring pi-ai 1.5.0
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

export const ThinkingLevelSchema = union([
	literal("off"),
	literal("minimal"),
	literal("low"),
	literal("medium"),
	literal("high"),
	literal("xhigh"),
	literal("max"),
]);
export const InputModalitySchema = union([literal("text"), literal("image")]);
export const CacheRetentionSchema = union([
	literal("none"),
	literal("short"),
	literal("long"),
]);
export const TransportSchema = union([
	literal("auto"),
	literal("sse"),
	literal("websocket"),
	literal("websocket-cached"),
]);
export const ToolChoiceSchema = union([literal("auto"), literal("none")]);
export const ReasoningLevelSchema = union([
	literal("minimal"),
	literal("low"),
	literal("medium"),
	literal("high"),
	literal("xhigh"),
	literal("max"),
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
export const JsonValueSchema = unknown();

const StringMapSchema = record(str());
const HeaderMapSchema = record(union([str(), nul()]));
const JsonMapSchema = record(JsonValueSchema);

// ---------------------------------------------------------------------------
// Model parameters
// ---------------------------------------------------------------------------

export const ModelCostRatesSchema = obj({
	input: num({ minimum: 0 }),
	output: num({ minimum: 0 }),
	cacheRead: num({ minimum: 0 }),
	cacheWrite: num({ minimum: 0 }),
});

export const ModelCostTierSchema = obj({
	input: num({ minimum: 0 }),
	output: num({ minimum: 0 }),
	cacheRead: num({ minimum: 0 }),
	cacheWrite: num({ minimum: 0 }),
	inputTokensAbove: num({ minimum: 0 }),
});

export const ModelCostSchema = obj({
	input: num({ minimum: 0 }),
	output: num({ minimum: 0 }),
	cacheRead: num({ minimum: 0 }),
	cacheWrite: num({ minimum: 0 }),
	tiers: opt(arr(ModelCostTierSchema)),
});

export const ModelImageResizeSchema = obj({
	maxWidth: opt(int({ minimum: 1 })),
	maxHeight: opt(int({ minimum: 1 })),
	maxBytes: opt(int({ minimum: 1 })),
	jpegQuality: opt(int({ minimum: 1, maximum: 100 })),
});

export const ModelInputLimitsSchema = obj({
	maxRequestBytes: opt(int({ minimum: 1 })),
	images: opt(
		obj({
			maxPerMessage: opt(int({ minimum: 1 })),
			maxPerRequest: opt(int({ minimum: 1 })),
			resize: opt(ModelImageResizeSchema),
		}),
	),
});

export const ThinkingLevelMapSchema = obj({
	off: opt(union([str(), nul()])),
	minimal: opt(union([str(), nul()])),
	low: opt(union([str(), nul()])),
	medium: opt(union([str(), nul()])),
	high: opt(union([str(), nul()])),
	xhigh: opt(union([str(), nul()])),
	max: opt(union([str(), nul()])),
});

export const PromptCacheSchema = obj({
	short: opt(num({ minimum: 0 })),
	long: opt(num({ minimum: 0 })),
});

export const SamplingParamsByLevelSchema = record(JsonMapSchema);

/** One chat model, exactly the fields pi-ai's `Model` carries. */
export const ModelConfigSchema = obj({
	id: str({ minLength: 1 }),
	name: str({ minLength: 1 }),
	/** Defaults to the provider's API when omitted. */
	api: opt(str({ minLength: 1 })),
	/** A per-model endpoint override; the provider's Base URL is used when omitted. */
	baseUrl: opt(str()),
	/** Chat is the default model type in pi-ai; keep it explicit in the file. */
	type: opt(literal("chat")),
	input: arr(InputModalitySchema, { minItems: 1 }),
	inputLimits: opt(ModelInputLimitsSchema),
	cost: ModelCostSchema,
	contextWindow: int({ minimum: 1 }),
	maxTokens: int({ minimum: 1 }),
	reasoning: bool(),
	thinkingLevelMap: opt(ThinkingLevelMapSchema),
	promptCache: opt(PromptCacheSchema),
	samplingParams: opt(JsonMapSchema),
	samplingParamsByThinkingLevel: opt(SamplingParamsByLevelSchema),
	/** pi-ai's per-API compatibility overrides. Kept open-ended on purpose. */
	compat: opt(JsonMapSchema),
	headers: opt(StringMapSchema),
	createdAt: opt(str()),
	updatedAt: opt(str()),
});

export type ModelConfig = Static<typeof ModelConfigSchema>;

// ---------------------------------------------------------------------------
// Providers and the on-disk gateway configuration
// ---------------------------------------------------------------------------

export const ProviderSourceSchema = union([literal("builtin"), literal("custom")]);
export type ProviderSource = Static<typeof ProviderSourceSchema>;

export const AuthKindSchema = union([
	literal("api-key"),
	literal("api-key+oauth"),
	literal("oauth"),
]);
export type AuthKind = Static<typeof AuthKindSchema>;

export const ProviderConfigSchema = obj({
	id: str({ minLength: 1 }),
	name: str({ minLength: 1 }),
	source: ProviderSourceSchema,
	/** Set for a provider added from pi-ai's built-in catalogue. */
	presetId: opt(str()),
	enabled: bool(),
	api: str({ minLength: 1 }),
	baseUrl: str(),
	/** Stored server-side only; never included in a snapshot or HTTP response. */
	apiKey: opt(str()),
	keyUpdatedAt: opt(str()),
	headers: opt(HeaderMapSchema),
	env: opt(StringMapSchema),
	models: arr(ModelConfigSchema),
	createdAt: opt(str()),
	updatedAt: opt(str()),
});

export type ProviderConfig = Static<typeof ProviderConfigSchema>;

export const GatewaySettingsSchema = obj({
	discoveryTimeoutMs: int({ minimum: 1_000, maximum: 120_000 }),
	requestDefaults: obj({
		temperature: opt(num({ minimum: 0, maximum: 2 })),
		maxTokens: opt(int({ minimum: 1 })),
		transport: opt(TransportSchema),
		cacheRetention: opt(CacheRetentionSchema),
		timeoutMs: opt(int({ minimum: 1 })),
		maxRetries: opt(int({ minimum: 0 })),
		maxRetryDelayMs: opt(int({ minimum: 0 })),
		websocketConnectTimeoutMs: opt(int({ minimum: 1 })),
		toolChoice: opt(ToolChoiceSchema),
		reasoning: opt(ReasoningLevelSchema),
		thinkingBudgets: opt(
			obj({
				minimal: opt(int({ minimum: 1 })),
				low: opt(int({ minimum: 1 })),
				medium: opt(int({ minimum: 1 })),
				high: opt(int({ minimum: 1 })),
			}),
		),
		deferred: opt(bool()),
		metadata: opt(JsonMapSchema),
		samplingParams: opt(JsonMapSchema),
	}),
});

export type GatewaySettings = Static<typeof GatewaySettingsSchema>;
export type RequestDefaults = GatewaySettings["requestDefaults"];

export const GatewayConfigSchema = obj({
	version: literal(1),
	providers: arr(ProviderConfigSchema),
	settings: GatewaySettingsSchema,
	createdAt: str(),
	updatedAt: str(),
});

export type GatewayConfig = Static<typeof GatewayConfigSchema>;

// ---------------------------------------------------------------------------
// Views and options sent to the browser
// ---------------------------------------------------------------------------

export const ProviderViewSchema = obj({
	id: str(),
	name: str(),
	source: ProviderSourceSchema,
	presetId: opt(str()),
	enabled: bool(),
	api: str(),
	baseUrl: str(),
	headers: opt(HeaderMapSchema),
	env: opt(StringMapSchema),
	hasKey: bool(),
	keyHint: opt(str()),
	keyUpdatedAt: opt(str()),
	authKind: AuthKindSchema,
	models: arr(ModelConfigSchema),
	createdAt: opt(str()),
	updatedAt: opt(str()),
});

export type ProviderView = Static<typeof ProviderViewSchema>;

export const PresetSummarySchema = obj({
	id: str(),
	name: str(),
	baseUrl: opt(str()),
	authKind: AuthKindSchema,
	modelCount: int({ minimum: 0 }),
	apis: arr(str()),
});

export type PresetSummary = Static<typeof PresetSummarySchema>;

export const CompatFieldSchema = obj({
	key: str(),
	label: str(),
	kind: union([
		literal("boolean"),
		literal("enum"),
		literal("number"),
		literal("string"),
		literal("json"),
	]),
	options: opt(arr(str())),
	description: opt(str()),
	default: opt(JsonValueSchema),
});

export type CompatField = Static<typeof CompatFieldSchema>;

export const ApiOptionSchema = obj({
	id: str(),
	label: str(),
	compatFields: arr(CompatFieldSchema),
});

export type ApiOption = Static<typeof ApiOptionSchema>;

export const GatewayOptionsSchema = obj({
	apis: arr(ApiOptionSchema),
	thinkingLevels: arr(str()),
	inputModalities: arr(str()),
	cacheRetentions: arr(str()),
	transports: arr(str()),
	toolChoices: arr(str()),
});

export type GatewayOptions = Static<typeof GatewayOptionsSchema>;

export const StorageInfoSchema = obj({
	dataPath: str(),
	backupPath: str(),
	namespace: str(),
	exists: bool(),
	mode: opt(str()),
	writable: bool(),
	lastSavedAt: opt(str()),
	notice: opt(str()),
	revision: num(),
	datasets: num(),
});

export type StorageInfo = Static<typeof StorageInfoSchema>;

export const GatewaySnapshotSchema = obj({
	version: str(),
	generatedAt: str(),
	providers: arr(ProviderViewSchema),
	presets: arr(PresetSummarySchema),
	settings: GatewaySettingsSchema,
	storage: StorageInfoSchema,
	options: GatewayOptionsSchema,
});

export type GatewaySnapshot = Static<typeof GatewaySnapshotSchema>;

// ---------------------------------------------------------------------------
// Method inputs and discovery results
// ---------------------------------------------------------------------------

export const ProviderIdInputSchema = obj({ id: str({ minLength: 1 }) });

export const AddBuiltinProviderInputSchema = obj({ presetId: str({ minLength: 1 }) });

export const AddProviderInputSchema = obj({
	id: str({ minLength: 1 }),
	name: opt(str()),
	api: str({ minLength: 1 }),
	baseUrl: str(),
	apiKey: opt(str()),
	headers: opt(HeaderMapSchema),
	env: opt(StringMapSchema),
});

export const ProviderPatchSchema = obj({
	name: opt(str({ minLength: 1 })),
	api: opt(str({ minLength: 1 })),
	baseUrl: opt(str()),
	enabled: opt(bool()),
	headers: opt(HeaderMapSchema),
	env: opt(StringMapSchema),
	/** Empty string clears the stored key. */
	apiKey: opt(str()),
});

export const SaveProviderInputSchema = obj({ id: str({ minLength: 1 }), patch: ProviderPatchSchema });

export const SetProviderEnabledInputSchema = obj({ id: str({ minLength: 1 }), enabled: bool() });

export const SaveModelInputSchema = obj({
	providerId: str({ minLength: 1 }),
	model: ModelConfigSchema,
	/** Present when the id was edited; the old id is removed in the same write. */
	previousId: opt(str()),
});

export const DeleteModelInputSchema = obj({ providerId: str({ minLength: 1 }), modelId: str({ minLength: 1 }) });

export const DiscoveredModelSchema = obj({
	id: str({ minLength: 1 }),
	name: str(),
	api: opt(str()),
	contextWindow: opt(int({ minimum: 1 })),
	maxTokens: opt(int({ minimum: 1 })),
	input: opt(arr(InputModalitySchema)),
	reasoning: opt(bool()),
	cost: opt(ModelCostSchema),
	ownedBy: opt(str()),
	created: opt(num()),
});

export type DiscoveredModel = Static<typeof DiscoveredModelSchema>;

export const DiscoveryResultSchema = obj({
	providerId: str(),
	endpoint: str(),
	fetchedAt: str(),
	source: union([literal("upstream"), literal("catalog")]),
	models: arr(
		obj({
			id: str(),
			name: str(),
			api: opt(str()),
			contextWindow: opt(int()),
			maxTokens: opt(int()),
			input: opt(arr(InputModalitySchema)),
			reasoning: opt(bool()),
			cost: opt(ModelCostSchema),
			ownedBy: opt(str()),
			created: opt(num()),
			alreadyConfigured: bool(),
		}),
	),
	warnings: arr(str()),
});

export type DiscoveryResult = Static<typeof DiscoveryResultSchema>;

export const ImportModelsInputSchema = obj({
	providerId: str({ minLength: 1 }),
	models: arr(DiscoveredModelSchema),
	mode: union([literal("skip"), literal("replace")]),
});

export const ImportResultSchema = obj({
	added: int(),
	skipped: int(),
	replaced: int(),
	total: int(),
});

export type ImportResult = Static<typeof ImportResultSchema>;

export const SaveSettingsInputSchema = obj({ settings: GatewaySettingsSchema });

export const GatewayHealthSchema = obj({
	ok: bool(),
	version: str(),
	dataPath: str(),
	providers: int(),
	enabledProviders: int(),
	models: int(),
	updatedAt: str(),
});

export type GatewayHealth = Static<typeof GatewayHealthSchema>;
