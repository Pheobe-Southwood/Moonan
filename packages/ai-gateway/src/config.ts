import { invalid, type DatasetCodec, type JsonValue } from "@moonan_ai/sdk";
import { Value } from "typebox/value";
import { GatewayConfigSchema, type GatewayConfig, type GatewaySettings } from "./schema.js";
import { cloneJson, nowIso } from "./util.js";

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

export function assertConfig(value: unknown): asserts value is GatewayConfig {
	if (Value.Check(GatewayConfigSchema, value)) return;
	const first = [...Value.Errors(GatewayConfigSchema, value)][0];
	const path = first?.instancePath || "(root)";
	throw invalid("data", `配置校验失败：${path} ${first?.message ?? "shape mismatch"}`);
}

export function migrateConfig(value: unknown, fromVersion: number): GatewayConfig {
	if (!Number.isInteger(fromVersion) || fromVersion < 1) {
		throw invalid("data", `unsupported ai-gateway config version ${String(fromVersion)}`);
	}
	if (fromVersion > GATEWAY_CONFIG_VERSION) {
		throw invalid("data", `ai-gateway config version ${fromVersion} is newer than this build`);
	}
	const clean = cloneJson(value);
	assertConfig(clean);
	return clean;
}

/**
 * Key-free copy for export/import. It drops `apiKey`/`keyUpdatedAt` only: `headers` and
 * `env` are ordinary provider configuration here, not credentials, so keep secrets out of
 * them (they also travel in the remote snapshot).
 */
export function redactConfig(config: GatewayConfig): GatewayConfig {
	const next = cloneJson(config);
	for (const provider of next.providers) {
		delete provider.apiKey;
		delete provider.keyUpdatedAt;
	}
	return next;
}

/**
 * Restore keys that a redacted export deliberately omitted. Providers are matched by id;
 * an imported provider that carries its own key wins.
 */
export function mergeSecretKeys(next: GatewayConfig, current: GatewayConfig | undefined): GatewayConfig {
	if (!current) return next;
	for (const provider of next.providers) {
		if (provider.apiKey !== undefined) continue;
		const existing = current.providers.find((candidate) => candidate.id === provider.id);
		if (!existing?.apiKey) continue;
		provider.apiKey = existing.apiKey;
		if (existing.keyUpdatedAt !== undefined) provider.keyUpdatedAt = existing.keyUpdatedAt;
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
		const out = options.includeSecrets ? cloneJson(value) : redactConfig(value);
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
