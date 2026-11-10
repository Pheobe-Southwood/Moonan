import type { PluginAdminError, PluginAdminMutation, PluginAdminSnapshot } from "@moonan_ai/sdk";

/**
 * A failed management request. `code` is the platform's operation code (`locked`,
 * `duplicate`, `reload_failed`, `management_disabled`, …); `chordCode`/`reason` carry chord's
 * own error when the failure came from a facet reload.
 */
export class PluginAdminRequestError extends Error {
	constructor(
		message: string,
		readonly code?: string,
		readonly reason?: string,
		readonly chordCode?: string,
		readonly committed?: boolean,
	) {
		super(message);
		this.name = "PluginAdminRequestError";
	}
}

export interface PluginAdminClient {
	snapshot(): Promise<PluginAdminSnapshot>;
	setEnabled(id: string, enabled: boolean): Promise<PluginAdminMutation>;
	add(ref: string, options?: { enable?: boolean }): Promise<PluginAdminMutation>;
	remove(id: string): Promise<PluginAdminMutation>;
	reload(): Promise<void>;
}

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function createPluginAdminClient(
	fetcher: Fetcher = (input, init) => fetch(input, init),
	base = "/api/v1/plugins",
): PluginAdminClient {
	const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
		let response: Response;
		try {
			response = await fetcher(`${base}${path}`, init);
		} catch (error) {
			throw new PluginAdminRequestError(`无法连接平台：${errorMessage(error)}`);
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
			const failure = (body ?? {}) as Partial<PluginAdminError>;
			throw new PluginAdminRequestError(
				typeof failure.error === "string" ? failure.error : `HTTP ${response.status}`,
				typeof failure.code === "string" ? failure.code : undefined,
				typeof failure.reason === "string" ? failure.reason : undefined,
				typeof failure.chordCode === "string" ? failure.chordCode : undefined,
				failure.committed === true,
			);
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
		snapshot: () => request<PluginAdminSnapshot>(""),
		setEnabled: (id, enabled) => post<PluginAdminMutation>(enabled ? "/enable" : "/disable", { id }),
		add: (ref, options) => post<PluginAdminMutation>("/install", { ref, enable: options?.enable ?? true }),
		remove: (id) => post<PluginAdminMutation>("/remove", { id }),
		reload: async () => {
			await post<PluginAdminMutation>("/reload", {});
		},
	};
}
