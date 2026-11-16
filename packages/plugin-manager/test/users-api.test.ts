import { describe, expect, it, vi } from "vitest";
import { createUserAdminClient, UserAdminRequestError } from "../src/web/users-api.js";

function response(status: number, body: unknown): Response {
	return {
		ok: status >= 200 && status < 300,
		status,
		text: async () => JSON.stringify(body),
	} as unknown as Response;
}

const USER = {
	id: "u1",
	username: "alice",
	role: "admin",
	createdAt: "2026-01-01T00:00:00.000Z",
	updatedAt: "2026-01-01T00:00:00.000Z",
} as const;

const SNAPSHOT = { api: 1, users: [USER], currentUserId: "u1" };

describe("user admin client", () => {
	it("reads the account snapshot", async () => {
		const fetcher = vi.fn(async (_input: string, _init?: RequestInit) => response(200, SNAPSHOT));
		const client = createUserAdminClient(fetcher, "/api/v1/users");
		await expect(client.snapshot()).resolves.toEqual(SNAPSHOT);
		expect(fetcher).toHaveBeenCalledWith("/api/v1/users", undefined);
	});

	it("posts create, password, role and remove bodies", async () => {
		const fetcher = vi.fn(async (_input: string, _init?: RequestInit) =>
			response(200, { ok: true, user: USER }),
		);
		const client = createUserAdminClient(fetcher, "/api/v1/users");
		await client.create({ username: "bob", password: "s3cret-pass", role: "user" });
		await client.setPassword("u1", "another-pass");
		await client.setRole("u1", "user");
		await client.remove("u1");

		expect(fetcher.mock.calls[0]).toEqual([
			"/api/v1/users/create",
			expect.objectContaining({
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ username: "bob", password: "s3cret-pass", role: "user" }),
			}),
		]);
		expect(fetcher.mock.calls[1]).toEqual([
			"/api/v1/users/password",
			expect.objectContaining({ body: JSON.stringify({ id: "u1", password: "another-pass" }) }),
		]);
		expect(fetcher.mock.calls[2]).toEqual([
			"/api/v1/users/role",
			expect.objectContaining({ body: JSON.stringify({ id: "u1", role: "user" }) }),
		]);
		expect(fetcher.mock.calls[3]).toEqual([
			"/api/v1/users/remove",
			expect.objectContaining({ body: JSON.stringify({ id: "u1" }) }),
		]);
	});

	it("turns an error body into a typed request error and keeps its code", async () => {
		const fetcher = vi.fn(async () =>
			response(409, { error: "不能降级最后一个管理员", code: "last_admin" }),
		);
		const client = createUserAdminClient(fetcher, "/api/v1/users");
		await expect(client.setRole("u1", "user")).rejects.toMatchObject({
			name: "UserAdminRequestError",
			code: "last_admin",
			message: "不能降级最后一个管理员",
		});
	});

	it("surfaces a taken username verbatim", async () => {
		const fetcher = vi.fn(async () =>
			response(409, { error: '用户名 "alice" 已被占用', code: "username_taken" }),
		);
		const client = createUserAdminClient(fetcher, "/api/v1/users");
		await expect(client.create({ username: "alice", password: "s3cret-pass", role: "user" })).rejects.toMatchObject({
			code: "username_taken",
			message: '用户名 "alice" 已被占用',
		});
	});

	it("asks for a new login when the session is gone", async () => {
		const fetcher = vi.fn(async () => response(401, { error: "需要登录", code: "unauthorized" }));
		const client = createUserAdminClient(fetcher, "/api/v1/users");
		await expect(client.snapshot()).rejects.toMatchObject({
			code: "unauthorized",
			message: "登录已失效，请重新登录。",
		});
	});

	it("asks for an administrator when the role is insufficient", async () => {
		const fetcher = vi.fn(async () => response(403, { error: "需要管理员权限", code: "admin_required" }));
		const client = createUserAdminClient(fetcher, "/api/v1/users");
		await expect(client.snapshot()).rejects.toMatchObject({
			code: "admin_required",
			message: "需要管理员权限，请重新登录。",
		});
	});

	it("reports a transport failure instead of throwing a TypeError", async () => {
		const fetcher = vi.fn(async () => {
			throw new Error("offline");
		});
		const client = createUserAdminClient(fetcher, "/api/v1/users");
		await expect(client.snapshot()).rejects.toBeInstanceOf(UserAdminRequestError);
	});
});
