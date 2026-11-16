import type { Host, Readable, Ref } from "@earendil-works/chord";
import { WebFacetCatalog } from "@moonan_ai/sdk";
import { Panels, type PanelContribution } from "@moonan_ai/sdk/web";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthGate, visiblePanels } from "../src/app.js";
import type { AuthStatus } from "../src/auth.js";

/**
 * The authenticated branch mounts a Chord host and opens a WebSocket. The gate's tests care
 * about the HTTP handoff and the branch it picks, so `ConnectionProvider` is replaced by a
 * stub that renders its children, offers a button to deliver an auth-lost callback, and lets
 * a test swap in a fake host. This file therefore tests the shell's account UX against the
 * gate, not the real link.
 */
const connection = vi.hoisted(() => ({
	current: {
		status: "open" as "connecting" | "open" | "closed" | "error",
		host: null as unknown,
		error: null as string | null,
	},
}));

vi.mock("../src/chord/connection.js", () => ({
	ConnectionProvider: ({ children, onAuthLost }: { children: ReactNode; onAuthLost?: () => void }) => (
		<>
			<button type="button" onClick={onAuthLost}>
				simulate-auth-lost
			</button>
			{children}
		</>
	),
	useConnection: () => connection.current,
}));

interface Call {
	readonly url: string;
	readonly init: RequestInit | undefined;
}

const calls: Call[] = [];
let fetchMock: ReturnType<typeof vi.fn>;

/** A minimal stand-in for the parts of `Response` the account client reads. */
function json(status: number, body: unknown): Response {
	return {
		ok: status >= 200 && status < 300,
		status,
		json: async () => body,
	} as unknown as Response;
}

function statusResponse(overrides: Partial<AuthStatus> = {}): Response {
	return json(200, {
		version: "0.1.0-alpha2",
		setupRequired: false,
		authenticated: false,
		...overrides,
	});
}

type Reply = () => Response | Promise<Response>;

/** Queue the responses this test expects, in request order. */
function respond(...replies: Reply[]): void {
	const queue = [...replies];
	fetchMock.mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
		calls.push({ url: String(input), init });
		const reply = queue.shift();
		if (reply === undefined) throw new Error(`unexpected request: ${String(input)}`);
		return reply();
	});
}

function submittedBody(call: Call | undefined): unknown {
	return JSON.parse(String(call?.init?.body));
}

function readable<T>(value: T): Readable<T> {
	return {
		get value() {
			return value;
		},
		subscribe(listener) {
			listener(value);
			return () => undefined;
		},
		events() {
			return () => undefined;
		},
	};
}

/**
 * The pieces of a browser host the shell reads: one live `WebFacetCatalog` (no facets) and
 * the `Panels` registry. Everything else the shell calls is a no-op.
 */
function fakeHost(panels: PanelContribution[] = []): Host<unknown> {
	const catalog = {
		status: "live",
		onStatus: () => () => undefined,
		release: () => undefined,
		version: readable("0.1.0-alpha2"),
		facets: readable([]),
	} as unknown as Ref<typeof WebFacetCatalog>;
	const table = new Map<string, PanelContribution>(panels.map((panel, index) => [`panel-${index}`, panel]));
	const view = {
		table: () => table,
		get: (key: string) => table.get(key),
		subscribe: (listener: (next: typeof table) => void) => {
			listener(table);
			return () => undefined;
		},
	};
	return {
		hold: () => catalog,
		load: async () => undefined,
		reload: async () => ({}),
		ready: async () => undefined,
		registry: () => view,
	} as unknown as Host<unknown>;
}

function panel(id: string, title: string, adminOnly?: boolean): PanelContribution {
	return {
		id,
		title,
		...(adminOnly === undefined ? {} : { adminOnly }),
		component: () => null,
	};
}

function session(role: "admin" | "user", username = "alice"): Response {
	return statusResponse({ authenticated: true, user: { id: "u1", username, role } });
}

beforeEach(() => {
	calls.length = 0;
	connection.current.host = null;
	fetchMock = vi.fn();
	vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

describe("AuthGate", () => {
	it("asks the platform for the session and shows a loading screen first", async () => {
		let resolve: ((response: Response) => void) | undefined;
		fetchMock.mockImplementation(
			() =>
				new Promise<Response>((ready) => {
					resolve = ready;
				}),
		);
		const view = render(<AuthGate />);

		expect(view.getByText(/正在检查登录状态/)).toBeTruthy();
		await act(async () => {
			resolve?.(statusResponse({ setupRequired: true }));
		});
		expect(view.getByRole("heading", { name: "创建第一个管理员" })).toBeTruthy();
		expect(fetchMock).toHaveBeenCalledWith(
			"/api/auth/status",
			expect.objectContaining({ credentials: "same-origin" }),
		);
	});

	it("renders the first-run setup page while no account exists", async () => {
		respond(() => statusResponse({ setupRequired: true }));
		const view = render(<AuthGate />);
		await waitFor(() => expect(view.getByRole("heading", { name: "创建第一个管理员" })).toBeTruthy());
		expect(view.getByLabelText("管理员账户")).toBeTruthy();
		expect(view.queryByText("登录 Moonan")).toBeNull();
	});

	it("creates the first administrator and mounts the shell", async () => {
		respond(
			() => statusResponse({ setupRequired: true }),
			() => json(200, { user: { id: "u1", username: "admin", role: "admin" } }),
		);
		const view = render(<AuthGate />);
		await waitFor(() => expect(view.getByRole("heading", { name: "创建第一个管理员" })).toBeTruthy());

		fireEvent.change(view.getByLabelText("管理员账户"), { target: { value: "admin" } });
		fireEvent.change(view.getByLabelText("密码"), { target: { value: "correct horse" } });
		fireEvent.change(view.getByLabelText("确认密码"), { target: { value: "correct horse" } });
		fireEvent.click(view.getByRole("button", { name: "创建管理员" }));

		await waitFor(() => expect(view.getByText("Moonan / 连接中")).toBeTruthy());
		expect(calls.map((call) => call.url)).toEqual(["/api/auth/status", "/api/auth/setup"]);
		expect(submittedBody(calls[1])).toEqual({ username: "admin", password: "correct horse" });
		expect(view.queryByRole("heading", { name: "创建第一个管理员" })).toBeNull();
	});

	it("rejects a first-run setup whose two passwords differ, without asking the server", async () => {
		respond(() => statusResponse({ setupRequired: true }));
		const view = render(<AuthGate />);
		await waitFor(() => expect(view.getByRole("heading", { name: "创建第一个管理员" })).toBeTruthy());

		fireEvent.change(view.getByLabelText("管理员账户"), { target: { value: "admin" } });
		fireEvent.change(view.getByLabelText("密码"), { target: { value: "correct horse" } });
		fireEvent.change(view.getByLabelText("确认密码"), { target: { value: "battery staple" } });
		fireEvent.click(view.getByRole("button", { name: "创建管理员" }));

		await waitFor(() => expect(view.getByRole("alert").textContent).toContain("两次输入的密码不一致"));
		expect(calls.map((call) => call.url)).toEqual(["/api/auth/status"]);
	});

	it("falls back to login when another tab created the administrator first", async () => {
		respond(
			() => statusResponse({ setupRequired: true }),
			() => json(409, { error: "管理员已经创建，请直接登录", code: "setup_complete" }),
			() => statusResponse(),
		);
		const view = render(<AuthGate />);
		await waitFor(() => expect(view.getByRole("heading", { name: "创建第一个管理员" })).toBeTruthy());

		fireEvent.change(view.getByLabelText("管理员账户"), { target: { value: "admin" } });
		fireEvent.change(view.getByLabelText("密码"), { target: { value: "correct horse" } });
		fireEvent.change(view.getByLabelText("确认密码"), { target: { value: "correct horse" } });
		fireEvent.click(view.getByRole("button", { name: "创建管理员" }));

		await waitFor(() => expect(view.getByRole("heading", { name: "登录 Moonan" })).toBeTruthy());
		expect(calls.map((call) => call.url)).toEqual([
			"/api/auth/status",
			"/api/auth/setup",
			"/api/auth/status",
		]);
	});

	it("logs in and mounts the shell", async () => {
		respond(
			() => statusResponse(),
			() => json(200, { user: { id: "u2", username: "alice", role: "user" } }),
		);
		const view = render(<AuthGate />);
		await waitFor(() => expect(view.getByRole("heading", { name: "登录 Moonan" })).toBeTruthy());

		fireEvent.change(view.getByLabelText("账户"), { target: { value: "alice" } });
		fireEvent.change(view.getByLabelText("密码"), { target: { value: "secret password" } });
		fireEvent.click(view.getByRole("button", { name: "登录" }));

		await waitFor(() => expect(view.getByText("Moonan / 连接中")).toBeTruthy());
		expect(calls.map((call) => call.url)).toEqual(["/api/auth/status", "/api/auth/login"]);
		expect(submittedBody(calls[1])).toEqual({ username: "alice", password: "secret password" });
	});

	it("shows the server's message for a refused login and keeps the form", async () => {
		respond(
			() => statusResponse(),
			() => json(401, { error: "用户名或密码错误", code: "invalid_credentials" }),
		);
		const view = render(<AuthGate />);
		await waitFor(() => expect(view.getByRole("heading", { name: "登录 Moonan" })).toBeTruthy());

		fireEvent.change(view.getByLabelText("账户"), { target: { value: "alice" } });
		fireEvent.change(view.getByLabelText("密码"), { target: { value: "wrong password" } });
		fireEvent.click(view.getByRole("button", { name: "登录" }));

		await waitFor(() => expect(view.getByRole("alert").textContent).toContain("用户名或密码错误"));
		expect(view.getByRole("heading", { name: "登录 Moonan" })).toBeTruthy();
		expect(view.getByRole("button", { name: "登录" })).toHaveProperty("disabled", false);
	});

	it("mounts the shell directly for an existing session", async () => {
		respond(() => session("admin", "root"));
		const view = render(<AuthGate />);
		await waitFor(() => expect(view.getByText("Moonan / 连接中")).toBeTruthy());
		expect(view.queryByRole("heading", { name: "登录 Moonan" })).toBeNull();
		expect(view.queryByRole("heading", { name: "创建第一个管理员" })).toBeNull();
	});

	it("returns to login when the connection reports the session is gone", async () => {
		respond(() => session("user", "bob"));
		const view = render(<AuthGate />);
		await waitFor(() => expect(view.getByText("Moonan / 连接中")).toBeTruthy());

		fireEvent.click(view.getByRole("button", { name: "simulate-auth-lost" }));
		await waitFor(() => expect(view.getByRole("heading", { name: "登录 Moonan" })).toBeTruthy());
		// The provider already established the session is gone; returning to login needs no refetch.
		expect(calls.map((call) => call.url)).toEqual(["/api/auth/status"]);
	});

	it("offers a retry when the platform cannot be reached", async () => {
		fetchMock.mockRejectedValueOnce(new TypeError("network down")).mockResolvedValueOnce(statusResponse());
		const view = render(<AuthGate />);

		await waitFor(() => expect(view.getByRole("heading", { name: "无法连接 Moonan" })).toBeTruthy());
		expect(view.getByText("无法连接 Moonan 服务，请稍后重试")).toBeTruthy();

		fireEvent.click(view.getByRole("button", { name: /重试/ }));
		await waitFor(() => expect(view.getByRole("heading", { name: "登录 Moonan" })).toBeTruthy());
	});
});

describe("shell account UX", () => {
	it("shows the username and role, and hides administrator-only panels from a user", async () => {
		connection.current.host = fakeHost([
			panel("plugins", "插件", true),
			panel("notes", "记录"),
			panel("users", "用户", true),
		]);
		respond(() => session("user", "alice"));
		const view = render(<AuthGate />);

		await waitFor(() => expect(view.getByText("alice")).toBeTruthy());
		const badge = view.container.querySelector(".role-badge");
		expect(badge?.textContent).toBe("用户");
		expect(badge?.getAttribute("data-role")).toBe("user");
		// The hash is empty, so the route falls back to the first panel this role may see.
		expect(view.getByRole("button", { name: "记录" }).getAttribute("data-active")).toBe("true");
		expect(view.queryByRole("button", { name: "插件" })).toBeNull();
		expect(view.queryByRole("button", { name: "用户" })).toBeNull();
	});

	it("shows the administrator badge and every panel to an administrator", async () => {
		connection.current.host = fakeHost([panel("plugins", "插件", true), panel("notes", "记录")]);
		respond(() => session("admin", "root"));
		const view = render(<AuthGate />);

		await waitFor(() => expect(view.getByText("root")).toBeTruthy());
		const badge = view.container.querySelector(".role-badge");
		expect(badge?.textContent).toBe("管理员");
		expect(badge?.getAttribute("data-role")).toBe("admin");
		expect(view.getByRole("button", { name: "插件" })).toBeTruthy();
		expect(view.getByRole("button", { name: "记录" })).toBeTruthy();
	});

	it("signs out from the topbar and returns to login after the server ends the session", async () => {
		connection.current.host = fakeHost([panel("notes", "记录")]);
		respond(
			() => session("user", "alice"),
			() => json(200, { ok: true }),
		);
		const view = render(<AuthGate />);
		await waitFor(() => expect(view.getByText("alice")).toBeTruthy());

		fireEvent.click(view.getByRole("button", { name: "退出登录" }));

		await waitFor(() => expect(view.getByRole("heading", { name: "登录 Moonan" })).toBeTruthy());
		expect(calls.map((call) => call.url)).toEqual(["/api/auth/status", "/api/auth/logout"]);
		expect(view.queryByText("alice")).toBeNull();
	});

	it("changes its own password from the topbar and returns to login with a notice", async () => {
		connection.current.host = fakeHost([panel("notes", "记录")]);
		respond(
			() => session("user", "alice"),
			() => json(200, { ok: true, reauthenticate: true }),
		);
		const view = render(<AuthGate />);
		await waitFor(() => expect(view.getByText("alice")).toBeTruthy());

		fireEvent.click(view.getByRole("button", { name: "修改密码" }));
		fireEvent.change(view.getByLabelText("当前密码"), { target: { value: "old password" } });
		fireEvent.change(view.getByLabelText("新密码"), { target: { value: "new password" } });
		fireEvent.change(view.getByLabelText("确认新密码"), { target: { value: "new password" } });
		fireEvent.click(view.getByRole("button", { name: "确认修改" }));

		await waitFor(() => expect(view.getByRole("heading", { name: "登录 Moonan" })).toBeTruthy());
		expect(view.getByRole("status").textContent).toContain("密码已修改，请重新登录");
		expect(calls.map((call) => call.url)).toEqual(["/api/auth/status", "/api/auth/password"]);
		expect(submittedBody(calls[1])).toEqual({ currentPassword: "old password", newPassword: "new password" });
	});

	it("keeps the password dialog open and shows the server's message on failure", async () => {
		connection.current.host = fakeHost([panel("notes", "记录")]);
		respond(
			() => session("user", "alice"),
			() => json(401, { error: "当前密码不正确", code: "invalid_credentials" }),
		);
		const view = render(<AuthGate />);
		await waitFor(() => expect(view.getByText("alice")).toBeTruthy());

		fireEvent.click(view.getByRole("button", { name: "修改密码" }));
		fireEvent.change(view.getByLabelText("当前密码"), { target: { value: "wrong password" } });
		fireEvent.change(view.getByLabelText("新密码"), { target: { value: "new password" } });
		fireEvent.change(view.getByLabelText("确认新密码"), { target: { value: "new password" } });
		fireEvent.click(view.getByRole("button", { name: "确认修改" }));

		await waitFor(() => expect(view.getByRole("alert").textContent).toContain("当前密码不正确"));
		expect(view.getByRole("dialog")).toBeTruthy();
	});
});

describe("visiblePanels", () => {
	const panels = [
		panel("shared", "共享"),
		panel("plugins", "插件", true),
		panel("users", "用户", true),
		panel("visible", "可见", false),
	];

	it("hides administrator-only panels from a normal user", () => {
		expect(visiblePanels(panels, "user").map((entry) => entry.id)).toEqual(["shared", "visible"]);
	});

	it("shows every panel to an administrator, preserving registration order", () => {
		expect(visiblePanels(panels, "admin").map((entry) => entry.id)).toEqual([
			"shared",
			"plugins",
			"users",
			"visible",
		]);
	});

	it("keeps a panel with an unset adminOnly flag visible to everyone", () => {
		expect(visiblePanels([panel("a", "A")], "user").map((entry) => entry.id)).toEqual(["a"]);
	});
});
