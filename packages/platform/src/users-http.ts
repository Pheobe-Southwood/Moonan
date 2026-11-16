import type { IncomingMessage, ServerResponse } from "node:http";
import {
	USER_ADMIN_API,
	userDataOwner,
	type UserAdminMutation,
	type UserAdminSnapshot,
	type UserPrincipal,
} from "@moonan_ai/sdk";
import { AuthError } from "./auth-store.js";
import type { AuthService } from "./auth-http.js";
import { crossSite, readJsonBody, sameOrigin, sendJson } from "./http-util.js";
import type { Logger } from "./logger.js";

export interface UserAdminOptions {
	readonly service: AuthService;
	readonly allowedOrigins: readonly string[];
	readonly logger: Logger;
	/** Purge one account's plugin datasets. Called after the account is gone. */
	removeUserData(owner: string): Promise<void>;
}

export interface UserAdminOutcome {
	readonly invalidate?: { readonly id: string };
}

function sendError(response: ServerResponse, error: unknown, logger: Logger): void {
	if (error instanceof AuthError) {
		sendJson(response, error.status, {
			error: error.message,
			code: error.code,
			...(error.retryAfterSeconds === undefined ? {} : { retryAfter: error.retryAfterSeconds }),
		});
		return;
	}
	logger.error("user administration failed", error);
	sendJson(response, 500, { error: "内部错误", code: "internal" });
}

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
	let body: unknown;
	try {
		body = await readJsonBody(request, 64 * 1024);
	} catch (error) {
		throw new AuthError("invalid_body", error instanceof Error ? error.message : String(error), 400);
	}
	if (typeof body !== "object" || body === null || Array.isArray(body)) {
		throw new AuthError("invalid_body", "请求体必须是 JSON 对象", 400);
	}
	return body as Record<string, unknown>;
}

function stringField(body: Record<string, unknown>, key: string): string {
	const value = body[key];
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new AuthError("invalid_body", `"${key}" 必须是非空字符串`, 400);
	}
	return value;
}

function guardAdmin(
	request: IncomingMessage,
	response: ServerResponse,
	options: UserAdminOptions,
): boolean {
	if (!sameOrigin(request, options.allowedOrigins) || crossSite(request)) {
		sendJson(response, 403, { error: "forbidden", code: "forbidden" });
		return true;
	}
	return false;
}

/**
 * The administrator-only account API.
 *
 * Account deletion is two-phase across two databases by necessity: the account/sessions are
 * removed first (the authoritative access boundary), then the plugin datasets are purged.
 * A purge failure is reported as a warning on an otherwise successful deletion, because the
 * account is already gone and the remaining rows are inaccessible.
 */
export async function handleUsers(
	request: IncomingMessage,
	response: ServerResponse,
	pathname: string,
	method: string,
	principal: UserPrincipal,
	options: UserAdminOptions,
): Promise<UserAdminOutcome | undefined> {
	if (!pathname.startsWith("/api/v1/users")) return undefined;
	if (principal.role !== "admin") {
		sendJson(response, 403, { error: "需要管理员权限", code: "admin_required" });
		return {};
	}

	if (pathname === "/api/v1/users") {
		if (method !== "GET") {
			sendJson(response, 405, { error: "method not allowed" });
			return {};
		}
		if (!sameOrigin(request, options.allowedOrigins)) {
			sendJson(response, 403, { error: "forbidden" });
			return {};
		}
		try {
			const snapshot: UserAdminSnapshot = {
				api: USER_ADMIN_API,
				users: await options.service.listUsersAsAdmin(),
				currentUserId: principal.id,
			};
			sendJson(response, 200, snapshot);
		} catch (error) {
			sendError(response, error, options.logger);
		}
		return {};
	}

	if (method !== "POST") {
		sendJson(response, 405, { error: "method not allowed" });
		return {};
	}
	if (guardAdmin(request, response, options)) return {};

	if (pathname === "/api/v1/users/create") {
		try {
			const body = await readBody(request);
			const user = await options.service.createUserAsAdmin({
				username: body.username,
				password: body.password,
				role: body.role,
			});
			sendJson(response, 200, { ok: true, user } satisfies UserAdminMutation);
		} catch (error) {
			sendError(response, error, options.logger);
		}
		return {};
	}

	if (pathname === "/api/v1/users/password") {
		try {
			const body = await readBody(request);
			const id = stringField(body, "id");
			const user = await options.service.getUserAsAdmin(id);
			if (user === undefined) throw new AuthError("unknown_user", "用户不存在", 404);
			await options.service.changePasswordAsAdmin(id, body.password);
			sendJson(response, 200, { ok: true, user } satisfies UserAdminMutation);
			return { invalidate: { id } };
		} catch (error) {
			sendError(response, error, options.logger);
		}
		return {};
	}

	if (pathname === "/api/v1/users/role") {
		try {
			const body = await readBody(request);
			const id = stringField(body, "id");
			const user = await options.service.setRoleAsAdmin(id, body.role);
			sendJson(response, 200, { ok: true, user } satisfies UserAdminMutation);
			return { invalidate: { id } };
		} catch (error) {
			sendError(response, error, options.logger);
		}
		return {};
	}

	if (pathname === "/api/v1/users/remove") {
		try {
			const body = await readBody(request);
			const id = stringField(body, "id");
			const user = await options.service.deleteUserAsAdmin(id);
			let warning: string | undefined;
			try {
				await options.removeUserData(userDataOwner(user.id));
			} catch (error) {
				options.logger.error(`account ${user.username} was deleted but its data could not be purged`, error);
				warning = "账户已删除，但插件数据清理失败；数据已不可访问，请联系维护者清理。";
			}
			sendJson(response, 200, { ok: true, ...(warning === undefined ? {} : { warning }) } satisfies UserAdminMutation);
			return { invalidate: { id } };
		} catch (error) {
			sendError(response, error, options.logger);
		}
		return {};
	}

	sendJson(response, 404, { error: "not found" });
	return {};
}
