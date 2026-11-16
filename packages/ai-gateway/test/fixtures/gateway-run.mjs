import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
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
const dataDb = join(home, "data.db");
const authDb = join(home, "auth.db");
const pluginsFile = join(home, "plugins.json");
const consumerDir = fileURLToPath(new URL("./consumer-plugin", import.meta.url));

const ADMIN = { username: "root", password: "root-password-123" };
const BOB = { username: "bob", password: "bob-password-123" };

/**
 * `node:sqlite` prints Node's one-time "SQLite is an experimental feature" warning when it
 * loads, and the platform only starts filtering that warning when its DataStore opens
 * (`start()`). The import is therefore deferred until after the app is up; a top-level
 * import would run first and land on stderr, which `gateway.test.ts` asserts stays empty.
 */
async function openDb(path, options) {
	const { DatabaseSync } = await import("node:sqlite");
	// Node's constructor rejects an explicit `undefined` second argument, so a plain open
	// has to pass an empty options object rather than the `undefined` default.
	return new DatabaseSync(path, options ?? {});
}

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
let bobClient;
let cookie;
let adminUserId;
let bobCookie;
let bobUserId;

/** One HTTP request carrying a session cookie; every API below `/api/` needs one. */
function fetchAs(sessionCookie, path, init = {}) {
	return fetch(`${app.url}${path}`, {
		...init,
		headers: { ...(init.headers ?? {}), ...(sessionCookie ? { cookie: sessionCookie } : {}) },
	});
}

/** An administrator request: all gateway routes and the data/plugin surfaces are per user. */
function authFetch(path, init) {
	return fetchAs(cookie, path, init);
}

function postJson(sessionCookie, path, body) {
	return fetchAs(sessionCookie, path, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

/**
 * Public authentication: setup creates the first administrator and returns a session
 * cookie; login creates another session for an existing account. Chord and every HTTP
 * route authenticate from that cookie alone.
 */
async function authenticate(path, account) {
	const response = await postJson("", path, account);
	assert.equal(response.status, 200, `${path} for ${account.username}: ${await response.clone().text()}`);
	const body = await response.json();
	const setCookie = response.headers.getSetCookie()[0];
	assert.ok(setCookie, `${path} sets a session cookie`);
	return { cookie: setCookie.split(";")[0], user: body.user };
}

async function connect(target, sessionCookie) {
	const socket = new WebSocket(target.url.replace(/^http/, "ws") + "/ws", {
		headers: { cookie: sessionCookie },
	});
	const host = createHost({ kind: "client", self: { kind: "browser" }, onError: () => undefined });
	host.connect(webSocketLink(socket), { principal: { kind: "host" } });
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
		dataDb,
		authDb,
		pluginsFile,
		official: false,
		logger: silentLogger,
	});

	// Public status works before setup; everything else is closed until a session exists.
	const initialStatus = await (await fetch(`${app.url}/api/auth/status`)).json();
	assert.equal(initialStatus.setupRequired, true);
	assert.equal(initialStatus.authenticated, false);
	const anonymous = await fetch(`${app.url}/api/ai-gateway/status`);
	assert.equal(anonymous.status, 401);
	assert.equal((await anonymous.json()).code, "unauthorized");

	const admin = await authenticate("/api/auth/setup", ADMIN);
	cookie = admin.cookie;
	adminUserId = admin.user.id;
	assert.equal(admin.user.role, "admin");
	const adminOwner = `user:${adminUserId}`;
	assert.deepEqual(
		{ id: admin.user.id, username: admin.user.username },
		{ id: adminUserId, username: ADMIN.username },
	);

	// The HTTP face creates (and releases) a per-request reference to the caller's own
	// object; no browser client is connected yet and it must still answer from the owner row.
	const preflight = await (await authFetch("/api/ai-gateway/status")).json();
	assert.equal(preflight.providers, 0);
	assert.equal(preflight.models, 0);
	assert.equal(preflight.database, dataDb);
	assert.equal(preflight.storage.namespace, "ai-gateway/config");
	assert.equal(preflight.storage.datasets, 0);

	client = await connect(app, cookie);
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

	// The HTTP face answers from the caller's own per-user object; it is only reachable
	// with the session cookie.
	const status = await (await authFetch("/api/ai-gateway/status")).json();
	assert.equal(status.version, packageJson.version);
	assert.equal(status.providers, 1);
	assert.equal(status.models, 4);
	// The health surface and the storage view both name the one SQLite database.
	assert.equal(status.database, dataDb);
	assert.equal(status.storage.database, dataDb);
	assert.equal(status.storage.mode, "0600");
	assert.equal(status.storage.schemaVersion, 2);
	assert.equal(status.storage.journalMode, "wal");
	assert.equal(status.storage.exists, true);
	assert.equal(status.storage.namespace, "ai-gateway/config");
	assert.equal(status.storage.datasets, 1);

	const configText = await (await authFetch("/api/ai-gateway/config")).text();
	assert.ok(!configText.includes("sk-upstream-12345678"));
	assert.ok(configText.includes("•••• 5678"));
	for (const secret of ["tok-header-secret", "sk-env-secret", "sk-model-secret"]) {
		assert.ok(!configText.includes(secret), `config leaked ${secret}`);
	}
	assert.ok(configText.includes(REDACTED));

	const exported = await (await authFetch("/api/data/export")).json();
	assert.ok(exported.datasets.some((dataset) => dataset.namespace === "ai-gateway/config"));
	assert.ok(!JSON.stringify(exported).includes("sk-upstream-12345678"));
	for (const secret of ["tok-header-secret", "sk-env-secret", "sk-model-secret"]) {
		assert.ok(!JSON.stringify(exported).includes(secret), `export leaked ${secret}`);
	}
	const withSecrets = await (await authFetch("/api/data/export?includeSecrets=1")).json();
	assert.ok(JSON.stringify(withSecrets).includes("sk-upstream-12345678"));
	for (const secret of ["tok-header-secret", "sk-env-secret", "sk-model-secret"]) {
		assert.ok(JSON.stringify(withSecrets).includes(secret), `includeSecrets omitted ${secret}`);
	}
	const importResponse = await fetchAs(cookie, "/api/data/import", {
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

	const consumer = await (await authFetch("/api/model-provider")).json();
	assert.ok(consumer.models.includes("hand-written"));

	// The HTTP surface maps a Chord error to a status and carries its code: a bad provider
	// id is the caller's mistake (400), not a gateway failure.
	const badDiscover = await authFetch("/api/ai-gateway/discover", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ providerId: "no-such-provider" }),
	});
	assert.equal(badDiscover.status, 400);
	const badDiscoverBody = await badDiscover.json();
	assert.equal(badDiscoverBody.code, "invalid");
	assert.match(badDiscoverBody.error, /不存在/);

	// A malformed body is the caller's mistake too (400), not a gateway failure (502).
	const malformed = await authFetch("/api/ai-gateway/discover", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: "{",
	});
	assert.equal(malformed.status, 400);
	assert.equal((await malformed.json()).code, "invalid");

	await ref.addProvider({ id: "bad-auth", name: "Bad Auth", api: "openai-completions", baseUrl: upstreamUrl, apiKey: "wrong-key" });
	const badAuth = await authFetch("/api/ai-gateway/discover", {
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
	const unreachable = await authFetch("/api/ai-gateway/discover", {
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

	// Another plugin writes a dataset of its own into this user's partition. Only the
	// store's `storage` cell changes, so a gateway snapshot that only followed its own
	// `config` cell would stay stale.
	assert.equal(ref.snapshot.value.storage.datasets, 1);
	const touch = await authFetch("/api/data-touch");
	assert.equal(touch.status, 200);
	const touched = await waitFor(
		() => ref.snapshot.value,
		(value) => value.storage.datasets === 2,
		"gateway snapshot storage",
	);
	assert.ok(touched.storage.revision > 0);

	// The unified store is one SQLite database; inspect it directly. The database is the
	// server-side authority: the masked round-trips restored the real values instead of
	// persisting the sentinel, and the panel/export never see these plaintext values. Every
	// row belongs to one account's owner, so the query names it instead of reading whatever
	// happens to be in the table.
	const db = await openDb(dataDb, { readOnly: true });
	const adminRow = db
		.prepare("SELECT owner, version, value FROM moonan_data_datasets WHERE owner = ? AND namespace = ?")
		.get(adminOwner, "ai-gateway/config");
	const aiGatewayRows = db
		.prepare("SELECT COUNT(*) AS count FROM moonan_data_datasets WHERE namespace = ?")
		.get("ai-gateway/config");
	db.close();
	assert.ok(adminRow, "the administrator's ai-gateway dataset is stored in the SQLite database");
	assert.equal(adminRow.owner, adminOwner);
	assert.equal(adminRow.version, 1);
	assert.equal(aiGatewayRows.count, 1);
	const raw = adminRow.value;
	assert.ok(raw.includes("sk-upstream-12345678"));
	for (const secret of ["tok-header-secret", "sk-env-secret", "sk-model-secret"]) {
		assert.ok(raw.includes(secret), `database lost ${secret}`);
	}
	assert.ok(!raw.includes(REDACTED));
	// The stored values are the real ones, not just present somewhere in the row.
	const stored = JSON.parse(raw);
	const rawProvider = stored.providers.find((provider) => provider.id === "atlas");
	assert.equal(rawProvider.headers["x-secret-token"], "tok-header-secret");
	assert.equal(rawProvider.headers["x-project-id"], "proj-1");
	assert.equal(rawProvider.env.OPENAI_API_KEY, "sk-env-secret");
	const rawModel = rawProvider.models.find((model) => model.id === "hand-written");
	assert.equal(rawModel.headers.authorization, "Bearer sk-model-secret");
	assert.equal((await stat(dataDb)).mode & 0o777, 0o600);

	const reload = await authFetch("/api/plugins/reload", { method: "POST" });
	assert.equal(reload.status, 200);
	await new Promise((resolve) => setTimeout(resolve, 100));
	assert.equal(ref.snapshot.value.providers[0]?.models.length, 4);

	// An external writer (another process, or a manual `sqlite3` session) edits the stored
	// dataset. It also bumps the meta revision/updated_at, as a real writer would, so the
	// reload path has honest bookkeeping to reconcile.
	const edited = JSON.parse(raw);
	edited.providers[0].name = "Atlas Renamed";
	const writer = await openDb(dataDb);
	const editedAt = new Date().toISOString();
	writer
		.prepare("UPDATE moonan_data_datasets SET value = ?, updated_at = ? WHERE owner = ? AND namespace = ?")
		.run(JSON.stringify(edited), editedAt, adminOwner, "ai-gateway/config");
	writer
		.prepare("UPDATE moonan_data_meta SET revision = revision + 1, updated_at = ? WHERE singleton = 1")
		.run(editedAt);
	writer.close();
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

	// A second account gets an independent gateway object and an independent DataStore
	// partition. The administrator creates the account; the account signs in through the
	// public login endpoint and holds its own Chord session and cookie.
	const created = await postJson(cookie, "/api/v1/users/create", {
		username: BOB.username,
		password: BOB.password,
		role: "user",
	});
	assert.equal(created.status, 200);
	const createdBody = await created.json();
	bobUserId = createdBody.user.id;
	assert.equal(createdBody.user.role, "user");
	const bobOwner = `user:${bobUserId}`;
	assert.notEqual(bobOwner, adminOwner);

	const bobAuth = await authenticate("/api/auth/login", BOB);
	bobCookie = bobAuth.cookie;
	assert.equal(bobAuth.user.id, bobUserId);

	bobClient = await connect(app, bobCookie);
	const bobRef = bobClient.ref;
	const bobInitial = await waitFor(
		() => bobRef.snapshot.value,
		(value) => Array.isArray(value.providers),
		"bob snapshot",
	);
	// Same remote contract, different principal: no sign of the administrator's providers.
	assert.deepEqual(bobInitial.providers, []);
	assert.equal(bobInitial.settings.discoveryTimeoutMs, defaultSettings().discoveryTimeoutMs);

	await bobRef.addProvider({
		id: "bob-only",
		name: "Bob Only",
		api: "openai-completions",
		baseUrl: upstreamUrl,
		apiKey: "sk-bob-secret-1234",
	});
	const bobSnapshot = await waitFor(
		() => bobRef.snapshot.value,
		(value) => value.providers.some((provider) => provider.id === "bob-only"),
		"bob provider in snapshot",
	);
	assert.equal(bobSnapshot.providers.length, 1);
	assert.equal(bobSnapshot.providers[0]?.hasKey, true);
	assert.ok(!JSON.stringify(bobSnapshot).includes("sk-upstream-12345678"));

	// The administrator's object and HTTP config did not change: a write by one user is
	// invisible to another even though both objects live on the same server host.
	const adminSnapshot = ref.snapshot.value;
	assert.equal(adminSnapshot.providers.length, 2);
	assert.ok(!adminSnapshot.providers.some((provider) => provider.id === "bob-only"));
	assert.ok(!JSON.stringify(adminSnapshot).includes("sk-bob-secret-1234"));
	const adminConfig = await (await authFetch("/api/ai-gateway/config")).json();
	assert.deepEqual(
		adminConfig.providers.map((provider) => provider.id).sort(),
		["anthropic", "atlas"],
	);
	const bobConfig = await (await fetchAs(bobCookie, "/api/ai-gateway/config")).json();
	assert.deepEqual(
		bobConfig.providers.map((provider) => provider.id),
		["bob-only"],
	);
	assert.ok(!JSON.stringify(bobConfig).includes("sk-upstream-12345678"));

	// The health/storage surface follows the caller too.
	const adminHealth = await (await authFetch("/api/ai-gateway/health")).json();
	const bobHealth = await (await fetchAs(bobCookie, "/api/ai-gateway/health")).json();
	assert.equal(adminHealth.providers, 2);
	assert.equal(adminHealth.models, 4 + anthropic.models.length);
	assert.equal(bobHealth.providers, 1);
	assert.equal(bobHealth.models, 0);
	assert.equal(bobHealth.updatedAt, bobSnapshot.generatedAt);

	// The ModelProviders contribution is global but reads the caller's partition: the
	// consumer plugin sees the administrator's models with the administrator's cookie and
	// an empty catalog for bob.
	const bobConsumer = await (await fetchAs(bobCookie, "/api/model-provider")).json();
	assert.deepEqual(bobConsumer.models, []);
	assert.equal(bobConsumer.model, null);

	// Both accounts' datasets are rows of the one database, separated by owner. Neither
	// row carries the other account's provider or credential.
	const splitDb = await openDb(dataDb, { readOnly: true });
	const rows = splitDb
		.prepare("SELECT owner, value FROM moonan_data_datasets WHERE namespace = ? ORDER BY owner")
		.all("ai-gateway/config");
	splitDb.close();
	assert.equal(rows.length, 2);
	const byOwner = new Map(rows.map((row) => [row.owner, JSON.parse(row.value)]));
	const adminStored = byOwner.get(adminOwner);
	const bobStored = byOwner.get(bobOwner);
	assert.ok(adminStored, "administrator dataset row present");
	assert.ok(bobStored, "bob dataset row present");
	assert.ok(adminStored.providers.some((provider) => provider.id === "atlas"));
	assert.ok(!adminStored.providers.some((provider) => provider.id === "bob-only"));
	assert.ok(bobStored.providers.some((provider) => provider.id === "bob-only"));
	assert.ok(!bobStored.providers.some((provider) => provider.id === "atlas"));
	assert.ok(!JSON.stringify(adminStored).includes("sk-bob-secret-1234"));
	assert.ok(!JSON.stringify(bobStored).includes("sk-upstream-12345678"));

	// A restart keeps both partitions: the session cookie survives (sessions live in the
	// auth database) and the per-user config cell is re-initialized from each owner's row.
	await closeClient(bobClient);
	bobClient = undefined;
	await closeClient(client);
	client = undefined;
	await app.close();
	app = await start({
		port: 0,
		plugins: ["@moonan_ai/ai-gateway", consumerDir],
		pluginsDir,
		dataDb,
		authDb,
		pluginsFile,
		official: false,
		logger: silentLogger,
	});
	client = await connect(app, cookie);
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

	bobClient = await connect(app, bobCookie);
	const bobRestored = await waitFor(
		() => bobClient.ref.snapshot.value,
		(value) => value.providers.length === 1,
		"restored bob providers",
	);
	assert.equal(bobRestored.providers[0]?.id, "bob-only");
	assert.equal(bobRestored.providers[0]?.hasKey, true);
	assert.notEqual(bobRestored.generatedAt, restored.generatedAt);

	console.log(JSON.stringify({ ok: true, providers: restored.providers.length, models: status.models }));
} catch (error) {
	console.error(error.stack || error);
	process.exitCode = 1;
} finally {
	await closeClient(bobClient).catch(() => undefined);
	await closeClient(client).catch(() => undefined);
	await app?.close().catch(() => undefined);
	await new Promise((resolve) => upstream.close(() => resolve()));
	await rm(home, { recursive: true, force: true });
	await rm(pluginsDir, { recursive: true, force: true });
}
