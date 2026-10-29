import {
	createModels,
	createProvider,
	envApiKeyAuth,
	type Api,
	type Credential,
	type CredentialInfo,
	type CredentialStore,
	type Model,
	type MutableModels,
	type Provider,
	type ProviderStreams,
} from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { azureOpenAIResponsesApi } from "@earendil-works/pi-ai/api/azure-openai-responses.lazy";
import { bedrockConverseStreamApi } from "@earendil-works/pi-ai/api/bedrock-converse-stream.lazy";
import { googleGenerativeAIApi } from "@earendil-works/pi-ai/api/google-generative-ai.lazy";
import { googleVertexApi } from "@earendil-works/pi-ai/api/google-vertex.lazy";
import { mistralConversationsApi } from "@earendil-works/pi-ai/api/mistral-conversations.lazy";
import { openAICodexResponsesApi } from "@earendil-works/pi-ai/api/openai-codex-responses.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { piMessagesApi } from "@earendil-works/pi-ai/api/pi-messages.lazy";
import { presetById } from "./catalog.js";
import type { GatewayConfig, ModelConfig, ProviderConfig } from "./schema.js";
import { normalizeBaseUrl } from "./util.js";

const ADAPTERS: Record<string, () => ProviderStreams> = {
	"openai-completions": openAICompletionsApi,
	"openai-responses": openAIResponsesApi,
	"azure-openai-responses": azureOpenAIResponsesApi,
	"openai-codex-responses": openAICodexResponsesApi,
	"anthropic-messages": anthropicMessagesApi,
	"google-generative-ai": googleGenerativeAIApi,
	"google-vertex": googleVertexApi,
	"mistral-conversations": mistralConversationsApi,
	"bedrock-converse-stream": bedrockConverseStreamApi,
	"pi-messages": piMessagesApi,
};

export function isKnownApi(api: string): boolean {
	return ADAPTERS[api] !== undefined;
}

export function knownApis(): string[] {
	return Object.keys(ADAPTERS);
}

/**
 * Credentials are the gateway configuration itself. The store is read-only from pi-ai's
 * point of view: the UI is the only writer, and it writes through the gateway's own
 * validated service methods. OAuth refresh is not used because the gateway stores API
 * keys; a provider that needs OAuth still works through pi-ai's ambient auth.
 */
export class ConfigCredentialStore implements CredentialStore {
	constructor(private readonly config: () => GatewayConfig) {}

	private provider(id: string): ProviderConfig | undefined {
		return this.config().providers.find((provider) => provider.id === id);
	}

	async read(providerId: string): Promise<Credential | undefined> {
		const provider = this.provider(providerId);
		if (!provider) return undefined;
		if (!provider.apiKey && !provider.env) return undefined;
		return {
			type: "api_key",
			...(provider.apiKey ? { key: provider.apiKey } : {}),
			...(provider.env ? { env: provider.env } : {}),
		};
	}

	async list(): Promise<readonly CredentialInfo[]> {
		return this.config()
			.providers.filter((provider) => provider.apiKey !== undefined || provider.env !== undefined)
			.map((provider) => ({ providerId: provider.id, type: "api_key" as const }));
	}

	async modify(): Promise<Credential | undefined> {
		throw new Error("the ai-gateway credential store is read-only; use saveProvider instead");
	}

	async delete(): Promise<void> {
		throw new Error("the ai-gateway credential store is read-only; use saveProvider instead");
	}
}

export interface ProviderRuntime {
	provider: Provider;
	models: MutableModels;
	warnings: string[];
}

function modelConfigToModel(model: ModelConfig, provider: ProviderConfig): Model<Api> | undefined {
	const api = model.api ?? provider.api;
	const baseUrl = normalizeBaseUrl(model.baseUrl ?? provider.baseUrl);
	if (!baseUrl) return undefined;
	return {
		id: model.id,
		name: model.name || model.id,
		api,
		provider: provider.id,
		baseUrl,
		input: [...model.input],
		...(model.inputLimits ? { inputLimits: model.inputLimits } : {}),
		cost: model.cost,
		contextWindow: model.contextWindow,
		maxTokens: model.maxTokens,
		reasoning: model.reasoning,
		...(model.thinkingLevelMap ? { thinkingLevelMap: model.thinkingLevelMap } : {}),
		...(model.promptCache ? { promptCache: model.promptCache } : {}),
		...(model.samplingParams ? { samplingParams: model.samplingParams } : {}),
		...(model.samplingParamsByThinkingLevel
			? { samplingParamsByThinkingLevel: model.samplingParamsByThinkingLevel }
			: {}),
		...(model.compat ? { compat: model.compat } : {}),
		...(model.headers ? { headers: { ...model.headers } } : {}),
		type: "chat",
	} as Model<Api>;
}

/**
 * Rebuilds the pi-ai provider described by one gateway record.
 *
 * This is the "is it real?" check behind the UI: every model is fed through the same
 * `createProvider` path pi-ai's own built-ins use, so a bad API id, a missing Base URL or
 * an unsupported compatibility shape shows up here rather than in a future chat call.
 */
export function buildProvider(
	getConfig: () => GatewayConfig,
	provider: ProviderConfig,
): { provider: Provider; warnings: string[] } {
	const warnings: string[] = [];
	const preset = provider.presetId ? presetById(provider.presetId) : undefined;
	const models: Model<Api>[] = [];
	const apiMap: Partial<Record<string, ProviderStreams>> = {};

	for (const model of provider.models) {
		const api = model.api ?? provider.api;
		const adapter = ADAPTERS[api];
		if (!adapter) {
			warnings.push(`模型 "${model.id}" 使用未知 API "${api}"，不会进入运行时。`);
			continue;
		}
		const built = modelConfigToModel(model, provider);
		if (!built) {
			warnings.push(`模型 "${model.id}" 没有可用的 Base URL，不会进入运行时。`);
			continue;
		}
		models.push(built);
		apiMap[api] = adapter();
	}

	if (Object.keys(apiMap).length === 0) {
		// A provider with no usable model still needs an implementation for auth
		// resolution. Fall back to the most common chat API; any model that later uses
		// an unknown API is skipped above with its own warning.
		const fallback = ADAPTERS[provider.api] ? provider.api : "openai-completions";
		apiMap[fallback] = ADAPTERS[fallback]!();
		if (!isKnownApi(provider.api)) warnings.push(`提供商 API "${provider.api}" 不受支持，运行时回退到 openai-completions。`);
	}

	const auth = preset?.provider.auth ?? { apiKey: envApiKeyAuth(`${provider.name} API key`, []) };
	const headers = provider.headers
		? Object.fromEntries(Object.entries(provider.headers).filter(([, value]) => value !== null)) as Record<string, string>
		: undefined;
	const baseUrl = normalizeBaseUrl(provider.baseUrl) || undefined;

	const runtimeProvider = createProvider({
		id: provider.id,
		name: provider.name,
		...(baseUrl ? { baseUrl } : {}),
		...(headers ? { headers } : {}),
		auth,
		models,
		...(Object.keys(apiMap).length > 0 ? { api: apiMap } : {}),
	});
	return { provider: runtimeProvider, warnings };
}

export function buildProviderRuntime(getConfig: () => GatewayConfig, provider: ProviderConfig): ProviderRuntime {
	const built = buildProvider(getConfig, provider);
	const runtimeModels = createModels({ credentials: new ConfigCredentialStore(getConfig) });
	runtimeModels.setProvider(built.provider);
	return { provider: built.provider, models: runtimeModels, warnings: built.warnings };
}

/**
 * The runtime exposed through `ModelProviders`.
 *
 * One `MutableModels` owns every enabled provider, so a consumer can resolve any configured
 * provider/model from the same handle. Credentials are read live from the gateway config;
 * the handle itself is rebuilt when the config revision changes.
 */
export function buildGatewayModels(getConfig: () => GatewayConfig): {
	models: MutableModels;
	warnings: string[];
} {
	const warnings: string[] = [];
	const models = createModels({ credentials: new ConfigCredentialStore(getConfig) });
	for (const provider of getConfig().providers) {
		if (!provider.enabled) continue;
		const built = buildProvider(getConfig, provider);
		warnings.push(...built.warnings);
		models.setProvider(built.provider);
	}
	return { models, warnings };
}

/** Resolve auth exactly as a future request would, including provider env overrides. */
export async function resolveAuth(
	getConfig: () => GatewayConfig,
	provider: ProviderConfig,
	signal?: AbortSignal,
): Promise<{
	apiKey?: string;
	headers?: Record<string, string | null>;
	baseUrl?: string;
	env?: Record<string, string>;
	source?: string;
} | undefined> {
	const runtime = buildProviderRuntime(getConfig, provider);
	const auth = await runtime.models.getAuth(provider.id, {
		...(provider.env ? { env: provider.env } : {}),
		...(signal ? { signal } : {}),
	});
	return auth?.auth;
}
