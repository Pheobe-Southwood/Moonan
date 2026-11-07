import { copyJson } from "@earendil-works/chord";
import {
	compile,
	invalid,
	type Ctx,
	type DataStore,
	type DataStoreStorageInfo,
	type Ref,
	type StoredDataset,
} from "@moonan_ai/sdk";
import {
	ModelConfigSchema,
	type DiscoveryResult,
	type DiscoveredModel,
	type GatewayConfig,
	type GatewayHealth,
	type GatewaySettings,
	type GatewaySnapshot,
	type ImportResult,
	type ModelConfig,
	type ProviderConfig,
	type ProviderView,
	type StorageInfo,
} from "./schema.js";
import { gatewayOptions, modelToConfig, presetById, presetSummaries } from "./catalog.js";
import {
	AI_GATEWAY_DATASET,
	GATEWAY_CONFIG_VERSION,
	emptyConfig,
	assertConfig,
	migrateConfig,
} from "./config.js";
import { discoverModels } from "./discovery.js";
import type { AiGatewayRuntime, ModelInfo } from "./model-provider.js";
import type { SerialQueue } from "./queue.js";
import { buildGatewayModels } from "./runtime.js";
import {
	displayNameFromId,
	isValidProviderId,
	keyHint,
	normalizeBaseUrl,
	nowIso,
} from "./util.js";

export interface GatewayServiceOptions {
	version: string;
	data: Ref<typeof DataStore>;
	namespace: string;
	queue: SerialQueue;
	getConfig: () => GatewayConfig;
	commit: (next: GatewayConfig, ctx: Ctx) => void;
}

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

const modelValidator = compile(ModelConfigSchema);

function validateModel(value: ModelConfig): ModelConfig {
	const clean = copyJson(value) as ModelConfig;
	if (!modelValidator.check(clean)) {
		const first = modelValidator.errors(clean)[0];
		throw invalid("args", `模型校验失败：${first?.path || "/"} ${first?.message ?? "shape mismatch"}`);
	}
	if (!clean.input.some((input) => input === "text")) clean.input = ["text", ...clean.input];
	clean.input = [...new Set(clean.input)];
	return clean;
}

function emptyToUndefined(value: string | undefined): string | undefined {
	if (value === undefined) return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function defaultDiscoveredModel(discovered: DiscoveredModel, provider: ProviderConfig, at: string): ModelConfig {
	const model: ModelConfig = {
		id: discovered.id.trim(),
		name: (discovered.name || displayNameFromId(discovered.id)).trim(),
		...(emptyToUndefined(discovered.api) ? { api: emptyToUndefined(discovered.api) } : {}),
		type: "chat",
		input: discovered.input && discovered.input.length > 0 ? [...discovered.input] : ["text"],
		cost: discovered.cost ? (copyJson(discovered.cost) as ModelConfig["cost"]) : { ...ZERO_COST },
		contextWindow: discovered.contextWindow ?? 128_000,
		maxTokens: discovered.maxTokens ?? 8_192,
		reasoning: discovered.reasoning ?? false,
		createdAt: at,
		updatedAt: at,
	};
	if (!model.input.includes("text")) model.input = ["text", ...model.input];
	return validateModel(model);
}

function providerView(provider: ProviderConfig): ProviderView {
	const preset = provider.presetId ? presetById(provider.presetId) : undefined;
	return {
		id: provider.id,
		name: provider.name,
		source: provider.source,
		...(provider.presetId ? { presetId: provider.presetId } : {}),
		enabled: provider.enabled,
		api: provider.api,
		baseUrl: provider.baseUrl,
		...(provider.headers ? { headers: copyJson(provider.headers) as ProviderConfig["headers"] } : {}),
		...(provider.env ? { env: copyJson(provider.env) as ProviderConfig["env"] } : {}),
		hasKey: Boolean(provider.apiKey),
		...(keyHint(provider.apiKey) ? { keyHint: keyHint(provider.apiKey) } : {}),
		...(provider.keyUpdatedAt ? { keyUpdatedAt: provider.keyUpdatedAt } : {}),
		authKind: preset?.summary.authKind ?? "api-key",
		models: provider.models.map((model) => copyJson(model) as ModelConfig),
		...(provider.createdAt ? { createdAt: provider.createdAt } : {}),
		...(provider.updatedAt ? { updatedAt: provider.updatedAt } : {}),
	};
}

/**
 * The gateway's server-side brain. It owns no Chord object itself: the facet hands it the
 * `DataStore` reference, a queue that survives reload, a function to read the current
 * projection cell, and a function to commit a new projection value. Every write goes
 * through {@link GatewayService.mutate}, which stores the unified dataset before the cell
 * is replaced; the data store, not the cell, is the authority.
 */
export class GatewayService {
	private runtimeCache: { key: string; runtime: AiGatewayRuntime } | undefined;

	constructor(private readonly options: GatewayServiceOptions) {}

	get version(): string {
		return this.options.version;
	}

	snapshot(
		source: GatewayConfig = this.options.getConfig(),
		storage: DataStoreStorageInfo = this.options.data.storage.value,
	): GatewaySnapshot {
		return {
			version: this.options.version,
			generatedAt: source.updatedAt,
			providers: source.providers.map(providerView),
			presets: presetSummaries(),
			settings: copyJson(source.settings) as GatewaySettings,
			storage: this.storageView(storage),
			options: gatewayOptions(),
		};
	}

	health(): GatewayHealth {
		const config = this.options.getConfig();
		return {
			ok: true,
			version: this.options.version,
			dataPath: this.options.data.storage.value.file,
			providers: config.providers.length,
			enabledProviders: config.providers.filter((provider) => provider.enabled).length,
			models: config.providers.reduce((total, provider) => total + provider.models.length, 0),
			updatedAt: config.updatedAt,
		};
	}

	storageInfo(): StorageInfo {
		return this.storageView(this.options.data.storage.value);
	}

	/**
	 * The gateway's view of the platform data file. It is derived from the store's
	 * `storage` cell, so the snapshot's `storage` block must be recomputed whenever that
	 * cell changes (the snapshot derivation lists it as a source), not only when the
	 * gateway's own config cell does.
	 */
	private storageView(info: DataStoreStorageInfo): StorageInfo {
		return {
			dataPath: info.file,
			backupPath: info.backup,
			namespace: this.options.namespace,
			exists: info.exists,
			...(info.mode === undefined ? {} : { mode: info.mode }),
			writable: info.writable,
			...(info.lastSavedAt === undefined ? {} : { lastSavedAt: info.lastSavedAt }),
			...(info.notice === undefined ? {} : { notice: info.notice }),
			revision: info.revision,
			datasets: info.datasets,
		};
	}

	/** The key-free catalog exposed through `ModelProviders`. */
	modelInfos(): ModelInfo[] {
		return this.modelRuntime().models.getModels().map((model) => ({
			providerId: model.provider,
			modelId: model.id,
			name: model.name,
			contextWindow: model.contextWindow,
			maxTokens: model.maxTokens,
			input: [...model.input],
			reasoning: model.reasoning,
		}));
	}

	/** The server-only runtime exposed through `ModelProviders`. */
	modelRuntime(): AiGatewayRuntime {
		const config = this.options.getConfig();
		const key = `${config.updatedAt}:${config.providers
			.map((provider) => `${provider.id}:${provider.enabled}:${provider.models.length}`)
			.join(",")}`;
		if (this.runtimeCache?.key === key) return this.runtimeCache.runtime;
		const built = buildGatewayModels(() => this.options.getConfig());
		const runtime: AiGatewayRuntime = {
			models: built.models,
			warnings: built.warnings,
			revision: config.updatedAt,
		};
		this.runtimeCache = { key, runtime };
		return runtime;
	}

	async addBuiltinProvider(presetId: string, ctx: Ctx): Promise<ProviderView> {
		return this.mutate(ctx, (config, at) => {
			const preset = presetById(presetId);
			if (!preset) throw invalid("args", `未知的内置提供商：${presetId}`);
			if (config.providers.some((provider) => provider.id === preset.id)) {
				throw invalid("args", `提供商 "${preset.id}" 已经存在。`);
			}
			const provider: ProviderConfig = {
				id: preset.id,
				name: preset.summary.name,
				source: "builtin",
				presetId: preset.id,
				enabled: true,
				api: preset.summary.apis[0] ?? "openai-completions",
				baseUrl: preset.provider.baseUrl ?? "",
				models: preset.models.map((model) => modelToConfig(model, preset.provider.baseUrl ?? "", at)),
				createdAt: at,
				updatedAt: at,
			};
			config.providers.push(provider);
			return providerView(provider);
		});
	}

	async addProvider(
		input: {
			id: string;
			name?: string;
			api: string;
			baseUrl: string;
			apiKey?: string;
			headers?: Record<string, string | null>;
			env?: Record<string, string>;
		},
		ctx: Ctx,
	): Promise<ProviderView> {
		return this.mutate(ctx, (config, at) => {
			const id = input.id.trim();
			if (!isValidProviderId(id)) {
				throw invalid("args", '提供商 ID 只能包含字母、数字、点、下划线和短横线，并以字母或数字开头（最多 64 个字符）。');
			}
			if (config.providers.some((provider) => provider.id === id)) {
				throw invalid("args", `提供商 "${id}" 已经存在。`);
			}
			const apiKey = emptyToUndefined(input.apiKey);
			const provider: ProviderConfig = {
				id,
				name: emptyToUndefined(input.name) ?? id,
				source: "custom",
				enabled: true,
				api: emptyToUndefined(input.api) ?? "openai-completions",
				baseUrl: normalizeBaseUrl(input.baseUrl),
				...(apiKey ? { apiKey, keyUpdatedAt: at } : {}),
				...(input.headers && Object.keys(input.headers).length > 0
					? { headers: copyJson(input.headers) as ProviderConfig["headers"] }
					: {}),
				...(input.env && Object.keys(input.env).length > 0
					? { env: copyJson(input.env) as ProviderConfig["env"] }
					: {}),
				models: [],
				createdAt: at,
				updatedAt: at,
			};
			config.providers.push(provider);
			return providerView(provider);
		});
	}

	async saveProvider(
		id: string,
		patch: {
			name?: string;
			api?: string;
			baseUrl?: string;
			enabled?: boolean;
			headers?: Record<string, string | null>;
			env?: Record<string, string>;
			apiKey?: string;
		},
		ctx: Ctx,
	): Promise<ProviderView> {
		return this.mutate(ctx, (config, at) => {
			const provider = mustProvider(config, id);
			if (patch.name !== undefined) {
				const name = patch.name.trim();
				if (!name) throw invalid("args", "提供商名称不能为空。");
				provider.name = name;
			}
			if (patch.api !== undefined) {
				const api = patch.api.trim();
				if (!api) throw invalid("args", "API 不能为空。");
				provider.api = api;
			}
			if (patch.baseUrl !== undefined) provider.baseUrl = normalizeBaseUrl(patch.baseUrl);
			if (patch.enabled !== undefined) provider.enabled = patch.enabled;
			if (patch.headers !== undefined) {
				if (Object.keys(patch.headers).length === 0) delete provider.headers;
				else provider.headers = copyJson(patch.headers) as ProviderConfig["headers"];
			}
			if (patch.env !== undefined) {
				if (Object.keys(patch.env).length === 0) delete provider.env;
				else provider.env = copyJson(patch.env) as ProviderConfig["env"];
			}
			if (patch.apiKey !== undefined) {
				const key = patch.apiKey.trim();
				if (key.length === 0) {
					delete provider.apiKey;
					delete provider.keyUpdatedAt;
				} else {
					provider.apiKey = key;
					provider.keyUpdatedAt = at;
				}
			}
			provider.updatedAt = at;
			return providerView(provider);
		});
	}

	async deleteProvider(id: string, ctx: Ctx): Promise<void> {
		await this.mutate(ctx, (config) => {
			const index = config.providers.findIndex((provider) => provider.id === id);
			if (index === -1) throw invalid("args", `提供商 "${id}" 不存在。`);
			config.providers.splice(index, 1);
			return undefined;
		});
	}

	async setProviderEnabled(id: string, enabled: boolean, ctx: Ctx): Promise<ProviderView> {
		return this.mutate(ctx, (config, at) => {
			const provider = mustProvider(config, id);
			provider.enabled = enabled;
			provider.updatedAt = at;
			return providerView(provider);
		});
	}

	async saveModel(
		providerId: string,
		input: ModelConfig,
		previousId: string | undefined,
		ctx: Ctx,
	): Promise<ModelConfig> {
		return this.mutate(ctx, (config, at) => {
			const provider = mustProvider(config, providerId);
			const model = validateModel({ ...(copyJson(input) as ModelConfig), updatedAt: at });
			model.id = model.id.trim();
			model.name = model.name.trim() || model.id;
			if (!model.id) throw invalid("args", "模型 ID 不能为空。");
			const api = emptyToUndefined(model.api);
			if (api) model.api = api;
			else delete model.api;
			const baseUrl = emptyToUndefined(model.baseUrl);
			if (baseUrl) model.baseUrl = baseUrl;
			else delete model.baseUrl;
			model.createdAt ??= at;
			const oldId = previousId ?? model.id;
			const existingIndex = provider.models.findIndex((candidate) => candidate.id === oldId);
			const collision = provider.models.findIndex(
				(candidate, index) => candidate.id === model.id && index !== existingIndex,
			);
			if (collision !== -1) throw invalid("args", `模型 "${model.id}" 已经存在。`);
			if (existingIndex === -1) {
				provider.models.push(model);
			} else {
				const previous = provider.models[existingIndex]!;
				model.createdAt = previous.createdAt ?? at;
				provider.models[existingIndex] = model;
			}
			provider.updatedAt = at;
			return copyJson(model) as ModelConfig;
		});
	}

	async deleteModel(providerId: string, modelId: string, ctx: Ctx): Promise<void> {
		await this.mutate(ctx, (config, at) => {
			const provider = mustProvider(config, providerId);
			const index = provider.models.findIndex((model) => model.id === modelId);
			if (index === -1) throw invalid("args", `模型 "${modelId}" 不存在。`);
			provider.models.splice(index, 1);
			provider.updatedAt = at;
			return undefined;
		});
	}

	async importModels(
		providerId: string,
		models: DiscoveredModel[],
		mode: "skip" | "replace",
		ctx: Ctx,
	): Promise<ImportResult> {
		return this.mutate(ctx, (config, at) => {
			const provider = mustProvider(config, providerId);
			let added = 0;
			let skipped = 0;
			let replaced = 0;
			for (const discovered of models) {
				const id = discovered.id.trim();
				if (!id) {
					skipped += 1;
					continue;
				}
				const existing = provider.models.find((model) => model.id === id);
				if (existing) {
					if (mode === "skip") {
						skipped += 1;
						continue;
					}
					const next = defaultDiscoveredModel({ ...discovered, id }, provider, at);
					next.createdAt = existing.createdAt ?? at;
					next.updatedAt = at;
					const index = provider.models.indexOf(existing);
					provider.models[index] = next;
					replaced += 1;
					continue;
				}
				provider.models.push(defaultDiscoveredModel({ ...discovered, id }, provider, at));
				added += 1;
			}
			provider.models.sort((a, b) => a.id.localeCompare(b.id, "en"));
			provider.updatedAt = at;
			return { added, skipped, replaced, total: models.length };
		});
	}

	async setSettings(settings: GatewaySettings, ctx: Ctx): Promise<GatewaySettings> {
		return this.mutate(ctx, (config, at) => {
			config.settings = copyJson(settings) as GatewaySettings;
			config.updatedAt = at;
			return copyJson(config.settings) as GatewaySettings;
		});
	}

	async discover(providerId: string, ctx: Ctx): Promise<DiscoveryResult> {
		const config = this.options.getConfig();
		const provider = mustProvider(config, providerId);
		const result = await discoverModels(() => this.options.getConfig(), provider, {
			timeoutMs: config.settings.discoveryTimeoutMs,
			signal: ctx.signal,
		});
		const existing = new Set(provider.models.map((model) => model.id));
		return {
			...result,
			models: result.models.map((model) => ({ ...model, alreadyConfigured: existing.has(model.id) })),
		};
	}

	async reloadFromDisk(ctx: Ctx): Promise<GatewaySnapshot> {
		return this.serialize(async () => {
			await this.options.data.reload(ctx);
			const stored = (await this.options.data.read(
				{ namespace: this.options.namespace },
				ctx,
			)) as StoredDataset | undefined;
			if (stored === undefined) throw invalid("data", "the gateway dataset is missing from the data store");
			const config = migrateConfig(stored.value, stored.version);
			this.options.commit(config, ctx);
			this.runtimeCache = undefined;
			return this.snapshot();
		});
	}

	/**
	 * The only write path. The data store is the authority: the read-modify-write runs in
	 * its serial queue, then the projection cell is updated. A post-write cell failure
	 * leaves the dataset durable and the cell stale until the next revision/restart.
	 */
	private async mutate<T>(
		ctx: Ctx,
		change: (config: GatewayConfig, at: string) => T | Promise<T>,
	): Promise<T> {
		return this.serialize(async () => {
			ctx.signal.throwIfAborted();
			const at = nowIso();
			let result: T | undefined;
			const stored = await this.options.data.update(
				{
					namespace: this.options.namespace,
					version: GATEWAY_CONFIG_VERSION,
					update: async (current: StoredDataset | undefined) => {
						const base =
							current === undefined ? emptyConfig() : migrateConfig(current.value, current.version);
						const next = copyJson(base) as GatewayConfig;
						result = await change(next, at);
						next.updatedAt = at;
						// Chord's diff cost walks every value and does not tolerate an own property set
						// to undefined. JSON is the contract boundary, so sanitize once here.
						const published = copyJson(next) as GatewayConfig;
						assertConfig(published);
						return { value: published, version: GATEWAY_CONFIG_VERSION };
					},
				},
				ctx,
			);
			const published = migrateConfig(stored.value, stored.version);
			ctx.signal.throwIfAborted();
			this.options.commit(published, ctx);
			return result as T;
		});
	}

	private serialize<T>(task: () => Promise<T>): Promise<T> {
		return this.options.queue.run(task);
	}
}

function mustProvider(config: GatewayConfig, id: string): ProviderConfig {
	const provider = config.providers.find((candidate) => candidate.id === id);
	if (!provider) throw invalid("args", `提供商 "${id}" 不存在。`);
	return provider;
}
