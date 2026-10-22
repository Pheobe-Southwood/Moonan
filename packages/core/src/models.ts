import {
	type Api,
	type Model,
	type ModelsSimpleStreamOptions,
	type MutableModels,
	type ProviderStreams,
	type SimpleStreamOptions,
	type TranscriptContext,
	createProvider,
	envApiKeyAuth,
} from "@earendil-works/pi-ai";
import { builtinModels, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import type { CustomProviderInput, ModelInfo, ModelRef, ProviderInfo } from "@moonan/contracts";
import type { Store } from "./storage/store.js";
import type { SqliteCredentialStore } from "./storage/credentials.js";
import type { Logger } from "./util.js";

const STREAMS: Record<string, () => ProviderStreams> = {
	"openai-completions": openAICompletionsApi,
	"anthropic-messages": anthropicMessagesApi,
};

/** Providers whose pi-ai definition advertises an OAuth login. alpha1 only shows a disabled button. */
const OAUTH_LABEL = "not implemented in alpha1";

export class ModelRegistry {
	readonly models: MutableModels;
	private readonly custom = new Map<string, CustomProviderInput>();

	constructor(
		private readonly store: Store,
		private readonly credentials: SqliteCredentialStore,
		private readonly logger: Logger,
	) {
		this.models = builtinModels({ credentials });
		for (const input of this.store.listCustomProviders()) {
			try {
				this.applyCustom(input);
				this.custom.set(input.id, input);
			} catch (error) {
				this.logger.error(`custom provider "${input.id}" could not be restored`, error);
			}
		}
	}

	/** `streamFn` for pi-agent-core: resolve credentials and dispatch through pi-ai. */
	readonly streamFn = (
		model: Model<Api>,
		context: TranscriptContext,
		options?: SimpleStreamOptions,
	): ReturnType<MutableModels["streamSimple"]> => this.models.streamSimple(model, context, options as ModelsSimpleStreamOptions);

	listProviders(): ProviderInfo[] {
		const infos: ProviderInfo[] = [];
		for (const id of getBuiltinProviders()) {
			const provider = this.models.getProvider(id);
			if (!provider) continue;
			infos.push({
				id,
				name: provider.name || id,
				kind: "builtin",
				hasKey: this.store.getCredential(id) !== undefined,
				oauth: Boolean(provider.auth?.oauth),
				baseUrl: provider.baseUrl,
			});
		}
		for (const input of this.custom.values()) {
			infos.push({
				id: input.id,
				name: input.name || input.id,
				kind: "custom",
				hasKey: this.store.getCredential(input.id) !== undefined,
				oauth: false,
				baseUrl: input.baseUrl,
				api: input.api,
			});
		}
		return infos;
	}

	listModels(providerId: string): ModelInfo[] {
		if (!this.models.getProvider(providerId)) return [];
		return this.models.getModels(providerId).map((model) => ({
			id: model.id,
			name: model.name || model.id,
			contextWindow: model.contextWindow,
			maxTokens: model.maxTokens,
			reasoning: Boolean(model.reasoning),
		}));
	}

	resolve(ref: ModelRef): Model<Api> | undefined {
		return this.models.getModel(ref.provider, ref.id) as Model<Api> | undefined;
	}

	async setKey(providerId: string, key: string): Promise<void> {
		await this.credentials.modify(providerId, async () => ({ type: "api_key", key }));
	}

	async clearKey(providerId: string): Promise<void> {
		await this.credentials.delete(providerId);
	}

	addCustom(input: CustomProviderInput): ProviderInfo {
		if (this.models.getProvider(input.id) && !this.custom.has(input.id)) {
			throw new Error(`provider "${input.id}" already exists`);
		}
		if (this.custom.has(input.id)) this.removeCustom(input.id);
		this.applyCustom(input);
		this.custom.set(input.id, input);
		this.store.saveCustomProvider(input);
		return {
			id: input.id,
			name: input.name || input.id,
			kind: "custom",
			hasKey: this.store.getCredential(input.id) !== undefined,
			oauth: false,
			baseUrl: input.baseUrl,
			api: input.api,
		};
	}

	removeCustom(id: string): void {
		this.custom.delete(id);
		this.models.deleteProvider(id);
		this.store.deleteCustomProvider(id);
	}

	async refresh(providerId?: string): Promise<void> {
		try {
			await this.models.refresh({ providers: providerId ? [providerId] : undefined, allowNetwork: false });
		} catch (error) {
			this.logger.warn("model refresh failed", error);
		}
	}

	get oauthNotice(): string {
		return OAUTH_LABEL;
	}

	private applyCustom(input: CustomProviderInput): void {
		const streamFactory = STREAMS[input.api];
		if (!streamFactory) throw new Error(`unsupported api "${input.api}" (expected one of ${Object.keys(STREAMS).join(", ")})`);
		const models: Model<Api>[] = input.models.map((model) => ({
			id: model.id,
			name: model.name || model.id,
			api: input.api as Api,
			provider: input.id,
			baseUrl: input.baseUrl,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: model.contextWindow ?? 128_000,
			maxTokens: model.maxTokens ?? 8_192,
			reasoning: model.reasoning ?? false,
		}));
		this.models.setProvider(
			createProvider({
				id: input.id,
				name: input.name || input.id,
				baseUrl: input.baseUrl,
				auth: { apiKey: envApiKeyAuth(`${input.name || input.id} API key`, []) },
				models,
				api: { [input.api]: streamFactory() },
			}),
		);
	}
}
