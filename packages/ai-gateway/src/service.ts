import { accessSync, constants, statSync } from "node:fs";
import { Value } from "typebox/value";
import type { Ctx } from "@moonan_ai/sdk";
import {
	GatewayConfigSchema,
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
import { discoverModels } from "./discovery.js";
import type { ConfigStore } from "./store.js";
import {
	cloneJson,
	displayNameFromId,
	isValidProviderId,
	keyHint,
	normalizeBaseUrl,
	nowIso,
} from "./util.js";

export interface GatewayServiceOptions {
	version: string;
	store: ConfigStore;
	getConfig: () => GatewayConfig;
	commit: (next: GatewayConfig, ctx: Ctx) => void;
}

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

function assertConfig(value: unknown): asserts value is GatewayConfig {
	if (Value.Check(GatewayConfigSchema, value)) return;
	const first = [...Value.Errors(GatewayConfigSchema, value)][0];
	const path = first?.instancePath || "(root)";
	throw new Error(`配置校验失败：${path} ${first?.message ?? "shape mismatch"}`);
}

function validateModel(value: ModelConfig): ModelConfig {
	const clean = cloneJson(value);
	if (!Value.Check(ModelConfigSchema, clean)) {
		const first = [...Value.Errors(ModelConfigSchema, clean)][0];
		const path = first?.instancePath || "(root)";
		throw new Error(`模型校验失败：${path} ${first?.message ?? "shape mismatch"}`);
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
		cost: discovered.cost ? cloneJson(discovered.cost) : { ...ZERO_COST },
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
		...(provider.headers ? { headers: cloneJson(provider.headers) } : {}),
		...(provider.env ? { env: cloneJson(provider.env) } : {}),
		hasKey: Boolean(provider.apiKey),
		...(keyHint(provider.apiKey) ? { keyHint: keyHint(provider.apiKey) } : {}),
		...(provider.keyUpdatedAt ? { keyUpdatedAt: provider.keyUpdatedAt } : {}),
		authKind: preset?.summary.authKind ?? "api-key",
		models: provider.models.map((model) => cloneJson(model)),
		...(provider.createdAt ? { createdAt: provider.createdAt } : {}),
		...(provider.updatedAt ? { updatedAt: provider.updatedAt } : {}),
	};
}

/**
 * The gateway's server-side brain. It owns no Chord object itself: the facet hands it
 * two functions, one to read the current cell and one to commit a new value with the
 * caller's root. Every write goes through {@link GatewayService.mutate}, which saves to
 * disk *before* the cell is replaced, so a failed write cannot become UI-only state.
 */
export class GatewayService {
	private queue: Promise<unknown> = Promise.resolve();

	constructor(private readonly options: GatewayServiceOptions) {}

	get version(): string {
		return this.options.version;
	}

	snapshot(source: GatewayConfig = this.options.getConfig()): GatewaySnapshot {
		return {
			version: this.options.version,
			generatedAt: source.updatedAt,
			providers: source.providers.map(providerView),
			presets: presetSummaries(),
			settings: cloneJson(source.settings),
			storage: this.storageInfo(source),
			options: gatewayOptions(),
		};
	}

	health(): GatewayHealth {
		const config = this.options.getConfig();
		return {
			ok: true,
			version: this.options.version,
			configPath: this.options.store.configPath,
			providers: config.providers.length,
			enabledProviders: config.providers.filter((provider) => provider.enabled).length,
			models: config.providers.reduce((total, provider) => total + provider.models.length, 0),
			updatedAt: config.updatedAt,
		};
	}

	storageInfo(source: GatewayConfig = this.options.getConfig()): StorageInfo {
		const info: StorageInfo = {
			configPath: this.options.store.configPath,
			backupPath: this.options.store.backupPath,
			directory: this.options.store.directory,
			exists: false,
			writable: false,
			...(this.options.store.currentNotice ? { notice: this.options.store.currentNotice } : {}),
		};
		try {
			const stat = statSync(this.options.store.configPath);
			info.exists = true;
			info.mode = `0${(stat.mode & 0o777).toString(8)}`;
		} catch {
			/* not written yet */
		}
		try {
			accessSync(this.options.store.directory, constants.W_OK);
			info.writable = true;
		} catch {
			/* directory may not exist yet; the first save creates it */
		}
		if (source.updatedAt) info.lastSavedAt = source.updatedAt;
		return info;
	}

	async addBuiltinProvider(presetId: string, ctx: Ctx): Promise<ProviderView> {
		return this.mutate(ctx, (config, at) => {
			const preset = presetById(presetId);
			if (!preset) throw new Error(`未知的内置提供商：${presetId}`);
			if (config.providers.some((provider) => provider.id === preset.id)) {
				throw new Error(`提供商 "${preset.id}" 已经存在。`);
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
				throw new Error('提供商 ID 只能包含字母、数字、点、下划线和短横线，并以字母或数字开头（最多 64 个字符）。');
			}
			if (config.providers.some((provider) => provider.id === id)) {
				throw new Error(`提供商 "${id}" 已经存在。`);
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
				...(input.headers && Object.keys(input.headers).length > 0 ? { headers: cloneJson(input.headers) } : {}),
				...(input.env && Object.keys(input.env).length > 0 ? { env: cloneJson(input.env) } : {}),
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
				if (!name) throw new Error("提供商名称不能为空。");
				provider.name = name;
			}
			if (patch.api !== undefined) {
				const api = patch.api.trim();
				if (!api) throw new Error("API 不能为空。");
				provider.api = api;
			}
			if (patch.baseUrl !== undefined) provider.baseUrl = normalizeBaseUrl(patch.baseUrl);
			if (patch.enabled !== undefined) provider.enabled = patch.enabled;
			if (patch.headers !== undefined) {
				if (Object.keys(patch.headers).length === 0) delete provider.headers;
				else provider.headers = cloneJson(patch.headers);
			}
			if (patch.env !== undefined) {
				if (Object.keys(patch.env).length === 0) delete provider.env;
				else provider.env = cloneJson(patch.env);
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
			if (index === -1) throw new Error(`提供商 "${id}" 不存在。`);
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
			const model = validateModel({ ...cloneJson(input), updatedAt: at });
			model.id = model.id.trim();
			model.name = model.name.trim() || model.id;
			if (!model.id) throw new Error("模型 ID 不能为空。");
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
			if (collision !== -1) throw new Error(`模型 "${model.id}" 已经存在。`);
			if (existingIndex === -1) {
				provider.models.push(model);
			} else {
				const previous = provider.models[existingIndex]!;
				model.createdAt = previous.createdAt ?? at;
				provider.models[existingIndex] = model;
			}
			provider.updatedAt = at;
			return cloneJson(model);
		});
	}

	async deleteModel(providerId: string, modelId: string, ctx: Ctx): Promise<void> {
		await this.mutate(ctx, (config, at) => {
			const provider = mustProvider(config, providerId);
			const index = provider.models.findIndex((model) => model.id === modelId);
			if (index === -1) throw new Error(`模型 "${modelId}" 不存在。`);
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
			config.settings = cloneJson(settings);
			config.updatedAt = at;
			return cloneJson(config.settings);
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
			const loaded = await this.options.store.load();
			assertConfig(loaded.config);
			this.options.commit(loaded.config, ctx);
			return this.snapshot();
		});
	}

	/**
	 * The only write path. Save first, publish second: a state cell and the file never
	 * disagree about what the user was told was saved.
	 */
	private async mutate<T>(
		ctx: Ctx,
		change: (config: GatewayConfig, at: string) => T | Promise<T>,
	): Promise<T> {
		return this.serialize(async () => {
			ctx.signal.throwIfAborted();
			const at = nowIso();
			const next = cloneJson(this.options.getConfig());
			const result = await change(next, at);
			next.updatedAt = at;
			// Chord's diff cost walks every value and does not tolerate an own property set
			// to undefined. JSON is the contract boundary, so sanitize once here.
			const published = cloneJson(next);
			assertConfig(published);
			const saved = await this.options.store.save(published);
			published.updatedAt = saved.savedAt;
			assertConfig(published);
			ctx.signal.throwIfAborted();
			this.options.commit(published, ctx);
			return result;
		});
	}

	private serialize<T>(task: () => Promise<T>): Promise<T> {
		const run = this.queue.then(task, task);
		this.queue = run.catch(() => undefined);
		return run;
	}
}

function mustProvider(config: GatewayConfig, id: string): ProviderConfig {
	const provider = config.providers.find((candidate) => candidate.id === id);
	if (!provider) throw new Error(`提供商 "${id}" 不存在。`);
	return provider;
}
