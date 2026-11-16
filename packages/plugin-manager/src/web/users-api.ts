import type {
	MoonanRole,
	UserAdminError,
	UserAdminMutation,
	UserAdminSnapshot,
} from "@moonan_ai/sdk";

/**
 * A failed account-management request. `code` is the platform's operation code:
 * `last_admin`, `username_taken`, `unknown_user`, `unauthorized`, `admin_required`, …
 *
 * The server's `error` message is already written for humans (it names the offending
 * username or the rule that refused the change); this class only adds the code the panel
 * needs to decide whether a failure is about authorization.
 */
export class UserAdminRequestError extends Error {
	constructor(
		message: string,
		readonly code?: string,
	) {
		super(message);
		this.name = "UserAdminRequestError";
	}
}

/** The account management API, as `users.tsx` needs it. */
export interface UserAdminClient {
	snapshot(): Promise<UserAdminSnapshot>;
	create(input: { username: string; password: string; role: MoonanRole }): Promise<UserAdminMutation>;
	setPassword(id: string, password: string): Promise<UserAdminMutation>;
	setRole(id: string, role: MoonanRole): Promise<UserAdminMutation>;
	remove(id: string): Promise<UserAdminMutation>;
}

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Replace the terse protocol message of an authorization failure with something actionable. */
function authMessage(status: number, code: string | undefined): string | undefined {
	if (status === 401 || code === "unauthorized") return "登录已失效，请重新登录。";
	if (status === 403 && code === "admin_required") return "需要管理员权限，请重新登录。";
	return undefined;
}

export function createUserAdminClient(
	fetcher: Fetcher = (input, init) => fetch(input, init),
	base = "/api/v1/users",
): UserAdminClient {
	const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
		let response: Response;
		try {
			response = await fetcher(`${base}${path}`, init);
		} catch (error) {
			throw new UserAdminRequestError(`无法连接平台：${errorMessage(error)}`);
		}
		const text = await response.text();
		let body: unknown;
		if (text.length > 0) {
			try {
				body = JSON.parse(text);
			} catch {
				body = undefined;
			}
		}
		if (!response.ok) {
			const failure = (body ?? {}) as Partial<UserAdminError>;
			const code = typeof failure.code === "string" ? failure.code : undefined;
			const message =
				authMessage(response.status, code) ??
				(typeof failure.error === "string" ? failure.error : `HTTP ${response.status}`);
			throw new UserAdminRequestError(message, code);
		}
		return body as T;
	};

	const post = <T>(path: string, body: unknown): Promise<T> =>
		request<T>(path, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});

	return {
		snapshot: () => request<UserAdminSnapshot>(""),
		create: (input) => post<UserAdminMutation>("/create", { ...input }),
		setPassword: (id, password) => post<UserAdminMutation>("/password", { id, password }),
		setRole: (id, role) => post<UserAdminMutation>("/role", { id, role }),
		remove: (id) => post<UserAdminMutation>("/remove", { id }),
	};
}
