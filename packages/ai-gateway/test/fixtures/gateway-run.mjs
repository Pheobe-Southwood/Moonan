import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHost, webSocketLink } from "@earendil-works/chord";
import WebSocket from "ws";
import { start } from "../../../platform/dist/index.js";
import { silentLogger } from "../../../platform/dist/logger.js";
import { AiGateway } from "../../dist/contract.js";
import { defaultSettings } from "../../dist/config.js";
import { REDACTED } from "../../dist/secrets.js";

const packageJson = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));

const home = await mkdtemp(join(tmpdir(), "moonan-gateway-home-"));
const pluginsDir = await mkdtemp(join(tmpdir(), "moonan-gateway-plugins-"));
const dataFile = join(home, "data.json");
const consumerDir = fileURLToPath(new URL("./consumer-plugin", import.meta.url));

const upstream = createServer((request, response) => {
	if (request.url === "/v1/models" && request.headers.authorization === "Bearer sk-upstream-12345678") {
		response.writeHead(200, { "content-type": "application/json" });
		response.end(
			JSON.stringify({
				data: [
					{
						id: "atlas-4o",
						name: "Atlas 4o",
						context_length: 200_000,
						max_completion_tokens: 32_768,
						architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
						pricing: { prompt: "0.0000025", completion: "0.00001" },
					},
					{ id: "atlas-coder", name: "Atlas Coder", context_length: 262_144, max_completion_tokens: 32_768 },
					{ id: "atlas-reasoner", name: "Atlas Reasoner", context_length: 1_000_000, reasoning: true },
				],
			}),
		);
		return;
	}
	response.writeHead(401, { "content-type": "application/json" });
	response.end(JSON.stringify({ error: { message: "bad key" } }));
});
await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
const address = upstream.address();
if (typeof address !== "object" || address === null) throw new Error("no upstream port");
const upstreamUrl = `http://127.0.0.1:${address.port}/v1`;

let app;
let client;

async function connect(target) {
	const socket = new WebSocket(target.url.replace(/^http/, "ws") + "/ws");
	const host = createHost({ kind: "client", self: { id: "browser" }, onError: () => undefined });
	host.connect(webSocketLink(socket), { principal: { id: "host" } });
	await new Promise((resolve, reject) => {
		socket.once("open", () => resolve());
		socket.once("error", reject);
	});
	const ref = await host.get(AiGateway, {});
	return { socket, host, ref };
}

async function closeClient(current) {
	if (!current) return;
	current.ref?.release?.();
	await current.host.close().catch(() => undefined);
	current.socket.terminate();
}

async function waitFor(read, predicate, label) {
	const deadline = Date.now() + 8_000;
	for (;;) {
		try {
			const value = read();
			if (predicate(value)) return value;
		} catch {
			/* not ready */
		}
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

try {
	app = await start({
		port: 0,
		plugins: ["@moonan_ai/ai-gateway", consumerDir],
		pluginsDir,
		dataFile,
		logger: silentLogger,
	});
	client = await connect(app);
	const ref = client.ref;

	await ref.addProvider({
		id: "atlas",
		name: "Atlas Local",
		api: "openai-completions",
		baseUrl: upstreamUrl,
		apiKey: "sk-upstream-12345678",
		// Credential-like values stay server-side; `x-project-id` is ordinary configuration.
		headers: { "x-secret-token": "tok-header-secret", "x-project-id": "proj-1" },
		env: { OPENAI_API_KEY: "sk-env-secret", AWS_REGION: "us-east-1" },
	});
	await waitFor(
		() => ref.snapshot.value,
		(snapshot) => snapshot.providers.some((provider) => provider.id === "atlas"),
		"provider in snapshot",
	);

	await ref.saveModel({
		providerId: "atlas",
		model: {
			id: "hand-written",
			name: "Hand Written",
			api: "openai-completions",
			type: "chat",
			input: ["text"],
			cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 64_000,
			maxTokens: 8_192,
			reasoning: false,
			samplingParams: { top_p: 0.9 },
			headers: { authorization: "Bearer sk-model-secret" },
		},
	});
	await waitFor(
		() => ref.snapshot.value.providers.find((provider) => provider.id === "atlas"),
		(provider) => provider?.models.some((model) => model.id === "hand-written") ?? false,
		"model in snapshot",
	);

	const discovery = await ref.discoverModels({ id: "atlas" });
	assert.equal(discovery.source, "upstream");
	assert.equal(discovery.models.length, 3);
	assert.equal(discovery.models[0]?.alreadyConfigured, false);

	const imported = await ref.importModels({
		providerId: "atlas",
		models: discovery.models.map(({ alreadyConfigured: _ignored, ...model }) => model),
		mode: "skip",
	});
	assert.equal(imported.added, 3);
	assert.equal(imported.skipped, 0);

	await ref.saveSettings({ settings: { ...defaultSettings(), discoveryTimeoutMs: 12_345 } });
	const snapshot = await waitFor(
		() => ref.snapshot.value,
		(value) => value.settings.discoveryTimeoutMs === 12_345 && value.providers[0]?.models.length === 4,
		"settings and imported models",
	);
	assert.equal(snapshot.providers[0]?.hasKey, true);
	assert.equal(snapshot.providers[0]?.keyHint, "•••• 5678");
	assert.ok(!JSON.stringify(snapshot).includes("sk-upstream-12345678"));

	// Credential-like headers, env values and model headers are masked in the browser view;
	// ordinary configuration travels unchanged.
	const atlasView = snapshot.providers[0];
	assert.equal(atlasView.headers["x-secret-token"], REDACTED);
	assert.equal(atlasView.headers["x-project-id"], "proj-1");
	assert.equal(atlasView.env.OPENAI_API_KEY, REDACTED);
	assert.equal(atlasView.env.AWS_REGION, "us-east-1");
	const handWrittenView = atlasView.models.find((model) => model.id === "hand-written");
	assert.equal(handWrittenView.headers.authorization, REDACTED);
	for (const secret of ["tok-header-secret", "sk-env-secret", "sk-model-secret"]) {
		assert.ok(!JSON.stringify(snapshot).includes(secret), `snapshot leaked ${secret}`);
	}

	const status = await (await fetch(`${app.url}/api/ai-gateway/status`)).json();
	assert.equal(status.version, packageJson.version);
	assert.equal(status.providers, 1);
	assert.equal(status.models, 4);
	assert.equal(status.storage.exists, true);
	assert.equal(status.storage.mode, "0600");
	assert.equal(status.storage.dataPath, dataFile);
	assert.equal(status.storage.namespace, "ai-gateway/config");
	assert.equal(status.storage.datasets, 1);

	const configText = await (await fetch(`${app.url}/api/ai-gateway/config`)).text();
	assert.ok(!configText.includes("sk-upstream-12345678"));
	assert.ok(configText.includes("•••• 5678"));
	for (const secret of ["tok-header-secret", "sk-env-secret", "sk-model-secret"]) {
		assert.ok(!configText.includes(secret), `config leaked ${secret}`);
	}
	assert.ok(configText.includes(REDACTED));

	const exported = await (await fetch(`${app.url}/api/data/export`)).json();
	assert.ok(exported.datasets.some((dataset) => dataset.namespace === "ai-gateway/config"));
	assert.ok(!JSON.stringify(exported).includes("sk-upstream-12345678"));
	for (const secret of ["tok-header-secret", "sk-env-secret", "sk-model-secret"]) {
		assert.ok(!JSON.stringify(exported).includes(secret), `export leaked ${secret}`);
	}
	const withSecrets = await (await fetch(`${app.url}/api/data/export?includeSecrets=1`)).json();
	assert.ok(JSON.stringify(withSecrets).includes("sk-upstream-12345678"));
	for (const secret of ["tok-header-secret", "sk-env-secret", "sk-model-secret"]) {
		assert.ok(JSON.stringify(withSecrets).includes(secret), `includeSecrets omitted ${secret}`);
	}
	const importResponse = await fetch(`${app.url}/api/data/import`, {
		method: "POST",
		body: JSON.stringify(exported),
	});
	assert.equal(importResponse.status, 200);
	await waitFor(
		() => ref.snapshot.value,
		(value) => value.providers[0]?.hasKey === true,
		"redacted import preserved the key",
	);

	// The panel saves the masked view back. The server restores stored values instead of
	// persisting the sentinel; a typed value would win, which saveModel/saveProvider share.
	const savedProvider = await ref.saveProvider({ id: "atlas", patch: { headers: atlasView.headers, env: atlasView.env } });
	const savedModel = await ref.saveModel({ providerId: "atlas", model: handWrittenView });
	// Results cross the wire too: a write that restored a secret must answer with the mask.
	assert.equal(savedProvider.headers["x-secret-token"], REDACTED);
	assert.equal(savedProvider.env.OPENAI_API_KEY, REDACTED);
	assert.equal(savedModel.headers.authorization, REDACTED);
	for (const secret of ["tok-header-secret", "sk-env-secret", "sk-model-secret"]) {
		assert.ok(!JSON.stringify(savedProvider).includes(secret), `saveProvider returned ${secret}`);
		assert.ok(!JSON.stringify(savedModel).includes(secret), `saveModel returned ${secret}`);
	}

	const consumer = await (await fetch(`${app.url}/api/model-provider`)).json();
	assert.ok(consumer.models.includes("hand-written"));

	// The HTTP surface maps a Chord error to a status and carries its code: a bad provider
	// id is the caller's mistake (400), not a gateway failure.
	const badDiscover = await fetch(`${app.url}/api/ai-gateway/discover`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ providerId: "no-such-provider" }),
	});
	assert.equal(badDiscover.status, 400);
	const badDiscoverBody = await badDiscover.json();
	assert.equal(badDiscoverBody.code, "invalid");
	assert.match(badDiscoverBody.error, /不存在/);

	// A malformed body is the caller's mistake too (400), not a gateway failure (502).
	const malformed = await fetch(`${app.url}/api/ai-gateway/discover`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: "{",
	});
	assert.equal(malformed.status, 400);
	assert.equal((await malformed.json()).code, "invalid");

	await ref.addProvider({ id: "bad-auth", name: "Bad Auth", api: "openai-completions", baseUrl: upstreamUrl, apiKey: "wrong-key" });
	const badAuth = await fetch(`${app.url}/api/ai-gateway/discover`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ providerId: "bad-auth" }),
	});
	assert.equal(badAuth.status, 400);
	assert.equal((await badAuth.json()).reason, "upstream-auth");

	await ref.addProvider({
		id: "unreachable",
		name: "Unreachable",
		api: "openai-completions",
		baseUrl: "http://127.0.0.1:1/v1",
		apiKey: "sk-unreachable",
	});
	const unreachable = await fetch(`${app.url}/api/ai-gateway/discover`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ providerId: "unreachable" }),
	});
	assert.equal(unreachable.status, 502);
	const unreachableBody = await unreachable.json();
	assert.equal(unreachableBody.code, "unavailable");
	assert.equal(unreachableBody.reason, "upstream");
	await ref.deleteProvider({ id: "bad-auth" });
	await ref.deleteProvider({ id: "unreachable" });

	assert.equal(consumer.model, "hand-written");

	// Another plugin writes a dataset of its own. Only the store's `storage` cell changes,
	// so a gateway snapshot that only followed its own `config` cell would stay stale.
	assert.equal(ref.snapshot.value.storage.datasets, 1);
	const touch = await fetch(`${app.url}/api/data-touch`);
	assert.equal(touch.status, 200);
	const touched = await waitFor(
		() => ref.snapshot.value,
		(value) => value.storage.datasets === 2,
		"gateway snapshot storage",
	);
	assert.ok(touched.storage.revision > 0);

	const raw = await readFile(dataFile, "utf8");
	const stored = JSON.parse(raw);
	assert.ok(raw.includes("sk-upstream-12345678"));
	// The data file is the server-side authority: the masked round-trips restored the real
	// values instead of persisting the sentinel.
	for (const secret of ["tok-header-secret", "sk-env-secret", "sk-model-secret"]) {
		assert.ok(raw.includes(secret), `data file lost ${secret}`);
	}
	assert.ok(!raw.includes(REDACTED));
	// The stored values are the real ones, not just present somewhere in the file.
	const rawProvider = stored.datasets["ai-gateway/config"].value.providers.find((provider) => provider.id === "atlas");
	assert.equal(rawProvider.headers["x-secret-token"], "tok-header-secret");
	assert.equal(rawProvider.headers["x-project-id"], "proj-1");
	assert.equal(rawProvider.env.OPENAI_API_KEY, "sk-env-secret");
	const rawModel = rawProvider.models.find((model) => model.id === "hand-written");
	assert.equal(rawModel.headers.authorization, "Bearer sk-model-secret");
	assert.equal(stored.datasets["ai-gateway/config"].version, 1);
	assert.equal((await stat(dataFile)).mode & 0o777, 0o600);

	const reload = await fetch(`${app.url}/api/plugins/reload`, { method: "POST" });
	assert.equal(reload.status, 200);
	await new Promise((resolve) => setTimeout(resolve, 100));
	assert.equal(ref.snapshot.value.providers[0]?.models.length, 4);

	const edited = JSON.parse(raw);
	edited.datasets["ai-gateway/config"].value.providers[0].name = "Atlas Renamed";
	await writeFile(dataFile, JSON.stringify(edited, null, 2), "utf8");
	const reloaded = await ref.reloadFromDisk();
	assert.equal(reloaded.providers[0]?.name, "Atlas Renamed");

	await ref.addBuiltinProvider({ presetId: "anthropic" });
	const withBuiltin = await waitFor(
		() => ref.snapshot.value,
		(value) => value.providers.some((provider) => provider.id === "anthropic"),
		"built-in provider",
	);
	const anthropic = withBuiltin.providers.find((provider) => provider.id === "anthropic");
	assert.ok(anthropic.models.length > 10);

	await closeClient(client);
	client = undefined;
	await app.close();
	app = await start({
		port: 0,
		plugins: ["@moonan_ai/ai-gateway", consumerDir],
		pluginsDir,
		dataFile,
		logger: silentLogger,
	});
	client = await connect(app);
	const restored = await waitFor(
		() => client.ref.snapshot.value,
		(value) => value.providers.length === 2,
		"restored providers",
	);
	const atlas = restored.providers.find((provider) => provider.id === "atlas");
	assert.equal(atlas?.name, "Atlas Renamed");
	assert.equal(atlas?.hasKey, true);
	assert.equal(atlas?.models.length, 4);
	assert.equal(restored.settings.discoveryTimeoutMs, 12_345);

	console.log(JSON.stringify({ ok: true, providers: restored.providers.length, models: status.models }));
} catch (error) {
	console.error(error.stack || error);
	process.exitCode = 1;
} finally {
	await closeClient(client).catch(() => undefined);
	await app?.close().catch(() => undefined);
	await new Promise((resolve) => upstream.close(() => resolve()));
	await rm(home, { recursive: true, force: true });
	await rm(pluginsDir, { recursive: true, force: true });
}
