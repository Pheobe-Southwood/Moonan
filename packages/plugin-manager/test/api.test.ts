import { describe, expect, it, vi } from "vitest";
import { createPluginAdminClient, PluginAdminRequestError } from "../src/web/api.js";

function response(status: number, body: unknown): Response {
	return {
		ok: status >= 200 && status < 300,
		status,
		text: async () => JSON.stringify(body),
	} as unknown as Response;
}

const SNAPSHOT = {
	api: 2,
	version: "0.1.0",
	revision: 3,
	paths: {
		cwd: "/tmp",
		pluginsFile: "/tmp/plugins.json",
		dataDb: "/tmp/data.db",
		authDb: "/tmp/auth.db",
		pluginsDir: "/tmp/plugins",
	},
	plugins: [],
};

describe("plugin admin client", () => {
	it("reads the snapshot", async () => {
		const fetcher = vi.fn(async (_input: string, _init?: RequestInit) => response(200, SNAPSHOT));
		const client = createPluginAdminClient(fetcher, "/api/v1/plugins");
		await expect(client.snapshot()).resolves.toEqual(SNAPSHOT);
		expect(fetcher).toHaveBeenCalledWith("/api/v1/plugins", undefined);
	});

	it("posts enable/disable and install bodies", async () => {
		const fetcher = vi.fn(async (_input: string, _init?: RequestInit) =>
			response(200, { ok: true, changed: true, reloadBrowser: false, revision: 4 }),
		);
		const client = createPluginAdminClient(fetcher, "/api/v1/plugins");
		await client.setEnabled("a", false);
		await client.setEnabled("a", true);
		await client.add("dir", { enable: false });
		await client.remove("a");

		expect(fetcher.mock.calls[0]).toEqual([
			"/api/v1/plugins/disable",
			expect.objectContaining({ method: "POST", body: JSON.stringify({ id: "a" }) }),
		]);
		expect(fetcher.mock.calls[1]?.[0]).toBe("/api/v1/plugins/enable");
		expect(fetcher.mock.calls[2]).toEqual([
			"/api/v1/plugins/install",
			expect.objectContaining({ body: JSON.stringify({ ref: "dir", enable: false }) }),
		]);
		expect(fetcher.mock.calls[3]?.[0]).toBe("/api/v1/plugins/remove");
	});

	it("turns an error body into a typed request error", async () => {
		const fetcher = vi.fn(async () =>
			response(403, { error: "plugin is locked", code: "locked" }),
		);
		const client = createPluginAdminClient(fetcher, "/api/v1/plugins");
		await expect(client.setEnabled("a", false)).rejects.toMatchObject({
			name: "PluginAdminRequestError",
			code: "locked",
			message: "plugin is locked",
		});
	});

	it("keeps chord's code and the committed flag", async () => {
		const fetcher = vi.fn(async () =>
			response(400, {
				error: "activation failed",
				code: "reload_failed",
				chordCode: "invalid",
				reason: "setup",
				committed: true,
			}),
		);
		const client = createPluginAdminClient(fetcher, "/api/v1/plugins");
		await expect(client.setEnabled("a", true)).rejects.toMatchObject({
			code: "reload_failed",
			chordCode: "invalid",
			reason: "setup",
			committed: true,
		});
	});

	it("asks for a new login when the session is gone", async () => {
		const fetcher = vi.fn(async () => response(401, { error: "需要登录", code: "unauthorized" }));
		const client = createPluginAdminClient(fetcher, "/api/v1/plugins");
		await expect(client.snapshot()).rejects.toMatchObject({
			name: "PluginAdminRequestError",
			code: "unauthorized",
			message: "登录已失效，请重新登录。",
		});
	});

	it("asks for an administrator when the role is insufficient", async () => {
		const fetcher = vi.fn(async () => response(403, { error: "需要管理员权限", code: "admin_required" }));
		const client = createPluginAdminClient(fetcher, "/api/v1/plugins");
		await expect(client.setEnabled("a", true)).rejects.toMatchObject({
			name: "PluginAdminRequestError",
			code: "admin_required",
			message: "需要管理员权限，请重新登录。",
		});
	});

	it("reports a transport failure instead of throwing a TypeError", async () => {
		const fetcher = vi.fn(async () => {
			throw new Error("offline");
		});
		const client = createPluginAdminClient(fetcher, "/api/v1/plugins");
		await expect(client.snapshot()).rejects.toBeInstanceOf(PluginAdminRequestError);
	});
});
