import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UserAdminSnapshot, UserAdminUser } from "@moonan_ai/sdk";
import type { PanelProps } from "@moonan_ai/sdk/web";
import { UserAdminRequestError, type UserAdminClient } from "../src/web/users-api.js";
import { UsersPanel } from "../src/web/users.js";

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	// happy-dom does not implement the browser dialogs; each test that needs one installs it.
	Reflect.deleteProperty(window, "confirm");
	Reflect.deleteProperty(window, "prompt");
});

/** The panel does not use its host; only the injected client matters here. */
const HOST = null as unknown as PanelProps["host"];

/** happy-dom has no `confirm`/`prompt`; place them on the window for the panel to call. */
function stubWindow(name: "confirm" | "prompt", value: unknown): void {
	Object.defineProperty(window, name, { configurable: true, writable: true, value });
}

function user(overrides: Partial<UserAdminUser> = {}): UserAdminUser {
	return {
		id: "u1",
		username: "alice",
		role: "admin",
		createdAt: "2026-01-02T03:04:05.000Z",
		updatedAt: "2026-01-02T03:04:05.000Z",
		...overrides,
	};
}

const ALICE = user();
const BOB = user({ id: "u2", username: "bob", role: "user" });

const LIST: UserAdminSnapshot = { api: 1, users: [ALICE, BOB], currentUserId: "u1" };

const PURGE_WARNING = "账户已删除，但插件数据清理失败；数据已不可访问，请联系维护者清理。";

function makeClient(overrides: Partial<UserAdminClient> = {}): UserAdminClient {
	return {
		snapshot: vi.fn(async () => LIST),
		create: vi.fn(async (input) => ({
			ok: true as const,
			user: user({ username: input.username, role: input.role }),
		})),
		setPassword: vi.fn(async (id, _password) => ({ ok: true as const, user: user({ id }) })),
		setRole: vi.fn(async (id, role) => ({ ok: true as const, user: user({ id, role }) })),
		remove: vi.fn(async () => ({ ok: true as const, warning: PURGE_WARNING })),
		...overrides,
	};
}

function rowOf(username: string): HTMLElement {
	const name = screen.getByText(username);
	const row = name.closest("li");
	if (!(row instanceof HTMLElement)) throw new Error(`row for ${username} not found`);
	return row;
}

describe("UsersPanel", () => {
	it("loads the accounts and creates a new one", async () => {
		const client = makeClient();
		render(<UsersPanel host={HOST} client={client} />);

		expect(await screen.findByText("alice")).toBeTruthy();
		fireEvent.change(screen.getByLabelText("用户名"), { target: { value: "carol" } });
		fireEvent.change(screen.getByLabelText("密码"), { target: { value: "carol-pass" } });
		fireEvent.click(screen.getByRole("button", { name: "创建账户" }));

		await waitFor(() =>
			expect(client.create).toHaveBeenCalledWith({
				username: "carol",
				password: "carol-pass",
				role: "user",
			}),
		);
		expect(await screen.findByText("已创建账户 carol（用户）。")).toBeTruthy();
		// The list is re-read after a mutation.
		expect(client.snapshot).toHaveBeenCalledTimes(2);
	});

	it("deletes only after confirmation and surfaces the purge warning", async () => {
		const client = makeClient();
		const confirm = vi.fn((_message?: string): boolean => true);
		stubWindow("confirm", confirm);
		render(<UsersPanel host={HOST} client={client} />);
		expect(await screen.findByText("bob")).toBeTruthy();

		fireEvent.click(within(rowOf("bob")).getByRole("button", { name: "删除" }));
		expect(confirm).toHaveBeenCalled();
		await waitFor(() => expect(client.remove).toHaveBeenCalledWith("u2"));
		expect(await screen.findByText(PURGE_WARNING)).toBeTruthy();
	});

	it("keeps the account when the delete confirmation is declined", async () => {
		const client = makeClient();
		const confirm = vi.fn((_message?: string): boolean => false);
		stubWindow("confirm", confirm);
		render(<UsersPanel host={HOST} client={client} />);
		expect(await screen.findByText("bob")).toBeTruthy();

		fireEvent.click(within(rowOf("bob")).getByRole("button", { name: "删除" }));
		expect(confirm).toHaveBeenCalled();
		expect(client.remove).not.toHaveBeenCalled();
	});

	it("resets a password through the prompt without putting it in the page", async () => {
		const client = makeClient();
		const prompt = vi.fn((_message?: string): string | null => "brand-new-pass");
		stubWindow("prompt", prompt);
		render(<UsersPanel host={HOST} client={client} />);
		expect(await screen.findByText("bob")).toBeTruthy();

		fireEvent.click(within(rowOf("bob")).getByRole("button", { name: "重置密码" }));
		expect(prompt).toHaveBeenCalledWith(expect.stringContaining("bob"));
		await waitFor(() => expect(client.setPassword).toHaveBeenCalledWith("u2", "brand-new-pass"));
		expect(await screen.findByText("已重置 bob 的密码，该账户需要重新登录。")).toBeTruthy();
		expect(screen.queryByText("brand-new-pass")).toBeNull();
	});

	it("ignores a cancelled password prompt and rejects a too-short password", async () => {
		const client = makeClient();
		const prompt = vi.fn((_message?: string): string | null => null);
		stubWindow("prompt", prompt);
		render(<UsersPanel host={HOST} client={client} />);
		expect(await screen.findByText("bob")).toBeTruthy();

		fireEvent.click(within(rowOf("bob")).getByRole("button", { name: "重置密码" }));
		expect(client.setPassword).not.toHaveBeenCalled();

		prompt.mockReturnValue("short");
		fireEvent.click(within(rowOf("bob")).getByRole("button", { name: "重置密码" }));
		expect(await screen.findByText("密码长度需为 8–200 个字符。")).toBeTruthy();
		expect(client.setPassword).not.toHaveBeenCalled();
	});

	it("surfaces the last-administrator refusal from the server", async () => {
		const client = makeClient();
		vi.mocked(client.setRole).mockRejectedValue(
			new UserAdminRequestError("不能降级最后一个管理员", "last_admin"),
		);
		render(<UsersPanel host={HOST} client={client} />);
		expect(await screen.findByText("bob")).toBeTruthy();

		fireEvent.click(within(rowOf("bob")).getByRole("button", { name: "设为管理员" }));
		expect(await screen.findByText("不能降级最后一个管理员")).toBeTruthy();
	});

	it("shows a friendly authorization error instead of a list", async () => {
		const client = makeClient({
			snapshot: vi.fn(async () => {
				throw new UserAdminRequestError("需要管理员权限，请重新登录。", "admin_required");
			}),
		});
		render(<UsersPanel host={HOST} client={client} />);

		expect(await screen.findByText("需要管理员权限，请重新登录。")).toBeTruthy();
		expect(screen.queryByRole("list")).toBeNull();
		expect(screen.queryByLabelText("用户名")).toBeNull();
	});
});
