import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PluginAdminEntry, PluginAdminSnapshot } from "@moonan_ai/sdk";
import type { Moonan } from "../src/index.js";
import { appFor, cleanup, pluginDir, request, tempDir, tempPluginsFile } from "./support.js";

afterEach(cleanup);

const TOGGLED = `
import { Routes, defineFacet, local, obj } from "@moonan_ai/sdk";

const Root = local("test.toggled", { version: 1, input: obj({}, { open: true }), members: {} });

export default defineFacet((api) => {
	api.serve(Root, (_input, _principal, self) => {
		self.register(Routes, {
			"GET /api/toggled": (_request, response) => {
				response.writeHead(200, { "content-type": "text/plain" });
				response.end("on");
			},
		});
		return {};
	}, { lifetime: "host" });
});
`;

const BAD_SETUP = `export default { setup() { throw new Error("setup boom"); } };\n`;

interface PluginsResponse {
	experimental: boolean;
	plugins: { name: string; web?: { url: string; hash: string } }[];
}

async function snapshot(app: Moonan): Promise<PluginAdminSnapshot> {
	return (await (await fetch(`${app.url}/api/v1/plugins`)).json()) as PluginAdminSnapshot;
}

function entry(app: Moonan, ref: string): Promise<PluginAdminEntry | undefined> {
	return snapshot(app).then((body) => body.plugins.find((plugin) => plugin.ref === ref));
}

function mutation(
	app: Moonan,
	path: string,
	body: unknown,
	options: { origin?: string | null; headers?: Record<string, string> } = {},
) {
	const headers: Record<string, string> = { "content-type": "application/json", ...options.headers };
	if (options.origin !== null) headers.origin = options.origin ?? app.url;
	return request(`${app.url}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
}

async function registryDocument(app: Moonan): Promise<{ plugins: { ref: string; enabled: boolean }[] }> {
	return JSON.parse(await readFile(app.pluginsFile, "utf8")) as {
		plugins: { ref: string; enabled: boolean }[];
	};
}

describe("plugin management API", () => {
	it("publishes a snapshot with the registry path and management state", async () => {
		const pluginsFile = await tempPluginsFile();
		const app = await appFor([], { pluginsFile });
		const body = await snapshot(app);
		expect(body.api).toBe(1);
		expect(body.management).toBe(true);
		expect(body.paths.pluginsFile).toBe(pluginsFile);
		expect(body.paths.dataFile).toBe(app.dataFile);
		expect(body.plugins).toEqual([]);
	});

	it("disables and re-enables a server plugin and persists the intent", async () => {
		const dir = await pluginDir(TOGGLED);
		const pluginsFile = await tempPluginsFile();
		const app = await appFor([dir], { pluginsFile });

		expect((await fetch(`${app.url}/api/toggled`)).status).toBe(200);
		const listed = await entry(app, dir);
		expect(listed).toMatchObject({ enabled: true, loaded: true, builtin: false, ephemeral: true });

		const disabled = await mutation(app, "/api/v1/plugins/disable", { id: dir });
		expect(disabled.status).toBe(200);
		const disabledBody = JSON.parse(disabled.body) as { ok: boolean; reloadBrowser: boolean; plugin: PluginAdminEntry };
		expect(disabledBody.ok).toBe(true);
		expect(disabledBody.reloadBrowser).toBe(false);
		expect(disabledBody.plugin).toMatchObject({ enabled: false, loaded: false, ephemeral: false });
		expect((await fetch(`${app.url}/api/toggled`)).status).toBe(404);
		expect((await registryDocument(app)).plugins).toEqual([{ ref: dir, enabled: false }]);

		// A new process reads the same registry and starts with the plugin disabled.
		const restarted = await appFor([dir], { pluginsFile });
		expect((await entry(restarted, dir))?.enabled).toBe(false);
		expect((await fetch(`${restarted.url}/api/toggled`)).status).toBe(404);

		const enabled = await mutation(restarted, "/api/v1/plugins/enable", { id: dir });
		expect(enabled.status).toBe(200);
		expect((await fetch(`${restarted.url}/api/toggled`)).status).toBe(200);
		expect((await registryDocument(restarted)).plugins).toEqual([{ ref: dir, enabled: true }]);
	});

	it("toggles a web-only plugin without a chord commit", async () => {
		const dir = await tempDir(".web-only-admin-");
		await writeFile(join(dir, "web.js"), "export default { setup() {} };\n");
		const app = await appFor([dir]);
		const before = app.revision;
		const listed = (await (await fetch(`${app.url}/api/plugins`)).json()) as PluginsResponse;
		const webUrl = listed.plugins[0]!.web!.url;
		expect((await fetch(`${app.url}${webUrl}`)).status).toBe(200);

		const disabled = await mutation(app, "/api/v1/plugins/disable", { id: dir });
		expect(JSON.parse(disabled.body)).toMatchObject({ ok: true, reloadBrowser: true });
		expect(app.revision).toBe(before);
		expect((await fetch(`${app.url}${webUrl}`)).status).toBe(404);

		const enabled = await mutation(app, "/api/v1/plugins/enable", { id: dir });
		expect(JSON.parse(enabled.body)).toMatchObject({ ok: true, reloadBrowser: true });
		expect(app.revision).toBe(before);
		expect((await fetch(`${app.url}${webUrl}`)).status).toBe(200);
	});

	it("installs a directory plugin, enables it, and removes it", async () => {
		const dir = await pluginDir(TOGGLED);
		const app = await appFor([]);
		expect((await fetch(`${app.url}/api/toggled`)).status).toBe(404);

		const installed = await mutation(app, "/api/v1/plugins/install", { ref: dir });
		expect(installed.status).toBe(200);
		expect((JSON.parse(installed.body) as { plugin: PluginAdminEntry }).plugin).toMatchObject({
			enabled: true,
			loaded: true,
			builtin: false,
			ephemeral: false,
		});
		expect((await fetch(`${app.url}/api/toggled`)).status).toBe(200);

		const removed = await mutation(app, "/api/v1/plugins/remove", { id: dir });
		expect(removed.status).toBe(200);
		expect((await fetch(`${app.url}/api/toggled`)).status).toBe(404);
		expect((await snapshot(app)).plugins).toEqual([]);
		expect((await registryDocument(app)).plugins).toEqual([]);
	});

	it("records a plugin that fails to enable and keeps the running set", async () => {
		const good = await pluginDir(TOGGLED);
		const bad = await pluginDir(BAD_SETUP);
		const app = await appFor([good]);

		const response = await mutation(app, "/api/v1/plugins/install", { ref: bad });
		expect(response.status).toBe(400);
		expect(JSON.parse(response.body)).toMatchObject({ code: expect.any(String) });
		// The bad entry is visible but disabled; the good plugin still serves.
		expect(await entry(app, bad)).toMatchObject({ enabled: false, loaded: false });
		expect((await fetch(`${app.url}/api/toggled`)).status).toBe(200);
		expect((await registryDocument(app)).plugins).toEqual([{ ref: bad, enabled: false }]);
	});

	it("refuses to disable a locked plugin and to remove a built-in one", async () => {
		const dir = await pluginDir(TOGGLED);
		const locked = await appFor([dir], { official: [{ ref: dir, locked: true }] });
		const lockedEntry = await entry(locked, dir);
		expect(lockedEntry).toMatchObject({ builtin: true, locked: true });

		const refusedDisable = await mutation(locked, "/api/v1/plugins/disable", { id: dir });
		expect(refusedDisable.status).toBe(403);
		expect(JSON.parse(refusedDisable.body)).toMatchObject({ code: "locked" });

		const refusedRemove = await mutation(locked, "/api/v1/plugins/remove", { id: dir });
		expect(refusedRemove.status).toBe(403);
		expect(JSON.parse(refusedRemove.body)).toMatchObject({ code: "builtin" });

		// A built-in entry that is not locked can be disabled, but still not removed.
		const builtin = await appFor([dir], { official: [{ ref: dir }] });
		expect((await mutation(builtin, "/api/v1/plugins/disable", { id: dir })).status).toBe(200);
		expect((await mutation(builtin, "/api/v1/plugins/remove", { id: dir })).status).toBe(403);
	});

	it("rejects duplicate refs and unknown plugins", async () => {
		const dir = await pluginDir(TOGGLED);
		const app = await appFor([dir]);
		// The first install adopts the ephemeral --plugin entry.
		expect((await mutation(app, "/api/v1/plugins/install", { ref: dir })).status).toBe(200);
		const duplicate = await mutation(app, "/api/v1/plugins/install", { ref: dir });
		expect(duplicate.status).toBe(409);
		expect(JSON.parse(duplicate.body)).toMatchObject({ code: "duplicate" });

		const missing = await mutation(app, "/api/v1/plugins/install", { ref: "definitely-not-a-moonan-plugin" });
		expect(missing.status).toBe(400);
		expect(JSON.parse(missing.body)).toMatchObject({ code: "resolve_failed" });

		const unknown = await mutation(app, "/api/v1/plugins/enable", { id: "/nope" });
		expect(unknown.status).toBe(404);
		expect(JSON.parse(unknown.body)).toMatchObject({ code: "unknown_plugin" });

		const empty = await mutation(app, "/api/v1/plugins/install", { ref: "   " });
		expect(empty.status).toBe(400);
		expect(JSON.parse(empty.body)).toMatchObject({ code: "invalid_body" });
	});

	it("adopts an ephemeral --plugin entry instead of duplicating it", async () => {
		const dir = await pluginDir(TOGGLED);
		const app = await appFor([dir]);
		expect((await entry(app, dir))?.ephemeral).toBe(true);
		const adopted = await mutation(app, "/api/v1/plugins/install", { ref: dir });
		expect(adopted.status).toBe(200);
		expect((JSON.parse(adopted.body) as { plugin: PluginAdminEntry }).plugin).toMatchObject({
			enabled: true,
			ephemeral: false,
		});
		expect((await registryDocument(app)).plugins).toEqual([{ ref: dir, enabled: true }]);
	});

	it("limits management to loopback unless explicitly allowed", async () => {
		const denied = await appFor([], { hostname: "0.0.0.0" });
		const deniedGet = await fetch(`${denied.url}/api/v1/plugins`);
		expect(deniedGet.status).toBe(403);
		expect((await deniedGet.json()) as { code?: string }).toMatchObject({ code: "management_disabled" });
		const deniedPost = await mutation(denied, "/api/v1/plugins/enable", { id: "/x" });
		expect(deniedPost.status).toBe(403);

		const allowed = await appFor([], { hostname: "0.0.0.0", allowManagement: true });
		expect((await fetch(`${allowed.url}/api/v1/plugins`)).status).toBe(200);
	});

	it("gates the legacy /api/plugins/reload endpoint like the management API", async () => {
		const dir = await pluginDir(TOGGLED);
		const denied = await appFor([dir], { hostname: "0.0.0.0" });
		// The read-only diagnostic stays available: the plugin manager falls back to it.
		expect((await fetch(`${denied.url}/api/plugins`)).status).toBe(200);
		const refused = await mutation(denied, "/api/plugins/reload", {});
		expect(refused.status).toBe(403);
		expect(JSON.parse(refused.body)).toMatchObject({ code: "management_disabled" });

		const crossOrigin = await appFor([dir]);
		expect((await mutation(crossOrigin, "/api/plugins/reload", {}, { origin: "http://evil.example" })).status).toBe(403);
		const crossSite = await mutation(crossOrigin, "/api/plugins/reload", {}, {
			headers: { "sec-fetch-site": "cross-site" },
		});
		expect(crossSite.status).toBe(403);

		// Management is not disabled on loopback, and an explicit opt-in allows a remote bind.
		expect((await mutation(crossOrigin, "/api/plugins/reload", {})).status).toBe(200);
		const allowed = await appFor([dir], { hostname: "0.0.0.0", allowManagement: true });
		expect((await mutation(allowed, "/api/plugins/reload", {})).status).toBe(200);
	});

	it("reports the server facet flag and the precise loaded state", async () => {
		const dir = await pluginDir(TOGGLED);
		const webDir = await tempDir(".web-only-loaded-");
		await writeFile(join(webDir, "web.js"), "export default { setup() {} };\n");
		const app = await appFor([dir, webDir]);

		expect(await entry(app, dir)).toMatchObject({ server: true, enabled: true, loaded: true });
		// A web-only plugin has no server work: enabled means published, so loaded is true.
		expect(await entry(app, webDir)).toMatchObject({ server: false, enabled: true, loaded: true });

		const disabled = await mutation(app, "/api/v1/plugins/disable", { id: dir });
		expect((JSON.parse(disabled.body) as { plugin: PluginAdminEntry }).plugin).toMatchObject({
			server: true,
			enabled: false,
			loaded: false,
		});
	});

	it("commits an empty reload so revision advances with no server facets", async () => {
		const app = await appFor([]);
		expect(app.plugins).toEqual([]);
		const before = app.revision;
		const response = await mutation(app, "/api/v1/plugins/reload", {});
		expect(response.status).toBe(200);
		const body = JSON.parse(response.body) as { changed: boolean; revision: number };
		// The empty batch touches no chord type, so `changed` is false; `revision` is the
		// "a commit landed" signal.
		expect(body.changed).toBe(false);
		expect(app.revision).toBe(before + 1);
		expect(body.revision).toBe(before + 1);
	});

	it("refuses cross-origin and cross-site mutations", async () => {
		const dir = await pluginDir(TOGGLED);
		const app = await appFor([dir]);
		const crossOrigin = await mutation(app, "/api/v1/plugins/disable", { id: dir }, { origin: "http://evil.example" });
		expect(crossOrigin.status).toBe(403);

		const crossSite = await mutation(
			app,
			"/api/v1/plugins/disable",
			{ id: dir },
			{ headers: { "sec-fetch-site": "cross-site" } },
		);
		expect(crossSite.status).toBe(403);
		// No Origin is a non-browser client (curl, tests): allowed, same as the reload endpoint.
		const curl = await mutation(app, "/api/v1/plugins/disable", { id: dir }, { origin: null });
		expect(curl.status).toBe(200);
	});

	it("degrades startup, reports skipped entries, and lets the UI disable them", async () => {
		const bad = await pluginDir(BAD_SETUP);
		const pluginsFile = await tempPluginsFile();
		await writeFile(
			pluginsFile,
			JSON.stringify({ format: 1, plugins: [{ ref: bad, enabled: true }] }),
		);
		const app = await appFor([], { pluginsFile });
		expect(app.startup?.degraded).toBe(true);
		const body = await snapshot(app);
		expect(body.startup).toMatchObject({ degraded: true, skipped: [bad] });
		expect(body.plugins[0]).toMatchObject({ enabled: true, loaded: false, startupSkipped: true });
		// The registry was not rewritten by the fallback.
		expect((await registryDocument(app)).plugins).toEqual([{ ref: bad, enabled: true }]);

		const disabled = await mutation(app, "/api/v1/plugins/disable", { id: bad });
		expect(disabled.status).toBe(200);
		expect((await registryDocument(app)).plugins).toEqual([{ ref: bad, enabled: false }]);
	});

	it("safe mode ignores the registry and keeps only the locked official plugins", async () => {
		const bad = await pluginDir(BAD_SETUP);
		const manager = await tempDir(".safe-manager-");
		await writeFile(join(manager, "web.js"), "export default { setup() {} };\n");
		const pluginsFile = await tempPluginsFile();
		await writeFile(
			pluginsFile,
			JSON.stringify({ format: 1, plugins: [{ ref: bad, enabled: true }] }),
		);
		const app = await appFor([], {
			pluginsFile,
			safeMode: true,
			official: [
				{ ref: manager, locked: true },
				{ ref: bad },
			],
		});
		expect(app.startup).toBeUndefined();
		expect(app.plugins.map((plugin) => plugin.ref)).toEqual([manager]);
		expect((await snapshot(app)).plugins.map((plugin) => plugin.id)).toEqual([manager]);
	});

	it("surfaces a corrupt registry as a warning without failing startup", async () => {
		const pluginsFile = await tempPluginsFile();
		await writeFile(pluginsFile, "this is not json");
		const app = await appFor([], { pluginsFile });
		const body = await snapshot(app);
		expect(body.warning).toMatch(/无法读取/);
		expect(body.plugins).toEqual([]);
	});
});
