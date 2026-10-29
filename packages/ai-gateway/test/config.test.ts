import { describe, expect, it } from "vitest";
import {
	emptyConfig,
	GATEWAY_CONFIG_VERSION,
	gatewayCodec,
	mergeSecretKeys,
	migrateConfig,
	redactConfig,
} from "../src/config.js";
import type { GatewayConfig } from "../src/schema.js";

function configWithKey(name = "Atlas"): GatewayConfig {
	const config = emptyConfig();
	config.providers.push({
		id: "atlas",
		name,
		source: "custom",
		enabled: true,
		api: "openai-completions",
		baseUrl: "http://127.0.0.1:1234/v1",
		apiKey: "sk-secret-12345678",
		keyUpdatedAt: "2026-01-01T00:00:00.000Z",
		models: [],
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
	});
	return config;
}

describe("gateway config codec", () => {
	it("redacts keys by default and preserves them when requested", () => {
		const config = configWithKey();
		const redacted = redactConfig(config);
		expect(redacted.providers[0]?.apiKey).toBeUndefined();
		expect(redacted.providers[0]?.keyUpdatedAt).toBeUndefined();
		expect(config.providers[0]?.apiKey).toBe("sk-secret-12345678");

		const exported = gatewayCodec.export(config, { includeSecrets: true });
		expect(JSON.stringify(exported)).toContain("sk-secret-12345678");
	});

	it("merges omitted keys from the current config", () => {
		const current = configWithKey();
		const imported = redactConfig(configWithKey("Imported"));
		const merged = mergeSecretKeys(imported, current);
		expect(merged.providers[0]?.name).toBe("Imported");
		expect(merged.providers[0]?.apiKey).toBe("sk-secret-12345678");
	});

	it("migrates only the current version", () => {
		expect(migrateConfig(configWithKey(), GATEWAY_CONFIG_VERSION).providers[0]?.id).toBe("atlas");
		expect(() => migrateConfig(configWithKey(), GATEWAY_CONFIG_VERSION + 1)).toThrow(/newer/);
		expect(() => migrateConfig({ version: 99 }, GATEWAY_CONFIG_VERSION)).toThrow(/配置校验失败/);
	});
});
