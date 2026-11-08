import { copyJson } from "@earendil-works/chord";
import { compile, invalid, type DatasetCodec, type JsonValue } from "@moonan_ai/sdk";
import { GatewayConfigSchema, type GatewayConfig, type GatewaySettings } from "./schema.js";
import { maskSensitiveMap, restoreSensitiveMap } from "./secrets.js";
import { nowIso } from "./util.js";

/** The only dataset ai-gateway owns in the platform data store. */
export const AI_GATEWAY_DATASET = "ai-gateway/config";

/**
 * Stored shape version; it belongs to the dataset, not to the Chord contract.
 *
 * Chord versions a *cell* separately (`self.state(name, schema, init, { version, migrate })`).
 * A `GatewayConfigSchema` change is two bumps: raise this constant for the data at rest
 * (codec `migrate`, and the `config` cell's `init`), and raise the `config` cell's state
 * version with a cell `migrate` for the value a reload keeps in memory. Bumping only the
 * dataset version leaves the reload refused with "schema changed without a raised version".
 */
export const GATEWAY_CONFIG_VERSION = 1;

export function defaultSettings(): GatewaySettings {
	return {
		discoveryTimeoutMs: 20_000,
		requestDefaults: {
			cacheRetention: "short",
			transport: "auto",
			maxRetries: 2,
			maxRetryDelayMs: 60_000,
			timeoutMs: 600_000,
		},
	};
}

export function emptyConfig(): GatewayConfig {
	const at = nowIso();
	return { version: 1, providers: [], settings: defaultSettings(), createdAt: at, updatedAt: at };
}

const configValidator = compile(GatewayConfigSchema);

export function assertConfig(value: unknown): asserts value is GatewayConfig {
	if (configValidator.check(value)) return;
	const first = configValidator.errors(value)[0];
	throw invalid("data", `配置校验失败：${first?.path || "/"} ${first?.message ?? "shape mismatch"}`);
}

export function migrateConfig(value: unknown, fromVersion: number): GatewayConfig {
	if (!Number.isInteger(fromVersion) || fromVersion < 1) {
		throw invalid("data", `unsupported ai-gateway config version ${String(fromVersion)}`);
	}
	if (fromVersion > GATEWAY_CONFIG_VERSION) {
		throw invalid("data", `ai-gateway config version ${fromVersion} is newer than this build`);
	}
	const clean = copyJson(value);
	assertConfig(clean);
	return clean;
}

/**
 * Key-free copy for export/import. It drops `apiKey`/`keyUpdatedAt` and masks
 * credential-like provider/model `headers` and `env` values (an `Authorization` header,
 * `AWS_SECRET_ACCESS_KEY`, …) with {@link REDACTED}; the import restores them from the
 * current config, exactly like the key. The exported file stays a valid config because
 * only values change, never the schema.
 */
export function redactConfig(config: GatewayConfig): GatewayConfig {
	const next = copyJson(config) as unknown as GatewayConfig;
	for (const provider of next.providers) {
		delete provider.apiKey;
		delete provider.keyUpdatedAt;
		const headers = maskSensitiveMap(provider.headers);
		if (headers !== undefined) provider.headers = headers;
		const env = maskSensitiveMap(provider.env);
		if (env !== undefined) provider.env = env;
		for (const model of provider.models) {
			const modelHeaders = maskSensitiveMap(model.headers);
			if (modelHeaders !== undefined) model.headers = modelHeaders;
		}
	}
	return next;
}

/**
 * Restore secrets that a redacted export deliberately masked. Providers are matched by id
 * and models by id; an imported provider or model that carries its own value wins. A masked
 * value with nothing stored to restore is dropped rather than stored as the sentinel.
 */
export function mergeSecretKeys(next: GatewayConfig, current: GatewayConfig | undefined): GatewayConfig {
	for (const provider of next.providers) {
		const existing = current?.providers.find((candidate) => candidate.id === provider.id);
		if (provider.apiKey === undefined && existing?.apiKey !== undefined) {
			provider.apiKey = existing.apiKey;
			if (existing.keyUpdatedAt !== undefined) provider.keyUpdatedAt = existing.keyUpdatedAt;
		}
		// Also runs without a current config: then every sentinel is dropped instead of stored.
		// An emptied map is removed rather than kept as `{}`, matching how a cleared map is stored.
		const headers = restoreSensitiveMap(provider.headers, existing?.headers);
		if (headers === undefined || Object.keys(headers).length === 0) delete provider.headers;
		else provider.headers = headers;
		const env = restoreSensitiveMap(provider.env, existing?.env);
		if (env === undefined || Object.keys(env).length === 0) delete provider.env;
		else provider.env = env;
		for (const model of provider.models) {
			const currentModel = existing?.models.find((candidate) => candidate.id === model.id);
			const modelHeaders = restoreSensitiveMap(model.headers, currentModel?.headers);
			if (modelHeaders === undefined || Object.keys(modelHeaders).length === 0) delete model.headers;
			else model.headers = modelHeaders;
		}
	}
	return next;
}

/**
 * The dataset codec for the unified data store.
 *
 * `migrate` is also used by the `config` cell's `init`; `export` redacts by default and
 * `import` uses the currently stored value to preserve omitted keys.
 */
export const gatewayCodec: DatasetCodec<GatewayConfig> = {
	namespace: AI_GATEWAY_DATASET,
	version: GATEWAY_CONFIG_VERSION,
	migrate: (value, fromVersion) => migrateConfig(value, fromVersion),
	export: (value, options) => {
		assertConfig(value);
		const out = options.includeSecrets ? copyJson(value) : redactConfig(value);
		return out as unknown as JsonValue;
	},
	import: (value, fromVersion, current) => {
		const next = migrateConfig(value, fromVersion);
		const currentConfig =
			current === undefined ? undefined : migrateConfig(current, GATEWAY_CONFIG_VERSION);
		const merged = mergeSecretKeys(next, currentConfig);
		merged.updatedAt = nowIso();
		assertConfig(merged);
		return merged;
	},
};
