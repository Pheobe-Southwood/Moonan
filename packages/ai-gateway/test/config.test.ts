import { describe, expect, it } from "vitest";
import {
	emptyConfig,
	GATEWAY_CONFIG_VERSION,
	gatewayCodec,
	mergeSecretKeys,
	migrateConfig,
	redactConfig,
} from "../src/config.js";
import { REDACTED } from "../src/secrets.js";
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
		headers: { Authorization: "Bearer sk-header-secret", "x-project-id": "proj-1" },
		env: { OPENAI_API_KEY: "sk-env-secret", AWS_REGION: "us-east-1" },
		models: [
			{
				id: "atlas-4o",
				name: "Atlas 4o",
				type: "chat",
				input: ["text"],
				cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 64_000,
				maxTokens: 8_192,
				reasoning: false,
				headers: { authorization: "Bearer sk-model-secret" },
				createdAt: "2026-01-01T00:00:00.000Z",
				updatedAt: "2026-01-01T00:00:00.000Z",
			},
		],
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

	it("masks credential-like headers and env values in a redacted export", () => {
		const redacted = redactConfig(configWithKey());
		const provider = redacted.providers[0]!;
		expect(provider.headers).toEqual({ Authorization: REDACTED, "x-project-id": "proj-1" });
		expect(provider.env).toEqual({ OPENAI_API_KEY: REDACTED, AWS_REGION: "us-east-1" });
		expect(provider.models[0]?.headers).toEqual({ authorization: REDACTED });
		const text = JSON.stringify(redacted);
		for (const secret of ["sk-header-secret", "sk-env-secret", "sk-model-secret"]) {
			expect(text).not.toContain(secret);
		}
	});

	it("merges omitted keys and masked values from the current config", () => {
		const current = configWithKey();
		const imported = redactConfig(configWithKey("Imported"));
		const merged = mergeSecretKeys(imported, current);
		const provider = merged.providers[0]!;
		expect(provider.name).toBe("Imported");
		expect(provider.apiKey).toBe("sk-secret-12345678");
		expect(provider.headers?.Authorization).toBe("Bearer sk-header-secret");
		expect(provider.env?.OPENAI_API_KEY).toBe("sk-env-secret");
		expect(provider.models[0]?.headers?.authorization).toBe("Bearer sk-model-secret");
	});

	it("drops masked values that have nothing to restore", () => {
		const merged = mergeSecretKeys(redactConfig(configWithKey()), undefined);
		// The sensitive entries are gone; ordinary configuration is not a secret and stays.
		expect(merged.providers[0]?.headers).toEqual({ "x-project-id": "proj-1" });
		expect(merged.providers[0]?.env).toEqual({ AWS_REGION: "us-east-1" });
		expect(merged.providers[0]?.models[0]?.headers).toBeUndefined();
	});

	it("migrates only the current version", () => {
		expect(migrateConfig(configWithKey(), GATEWAY_CONFIG_VERSION).providers[0]?.id).toBe("atlas");
		expect(() => migrateConfig(configWithKey(), GATEWAY_CONFIG_VERSION + 1)).toThrow(/newer/);
		expect(() => migrateConfig({ version: 99 }, GATEWAY_CONFIG_VERSION)).toThrow(/配置校验失败/);
	});
});
