import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UserAdminSnapshot, UserAdminUser } from "@moonan_ai/sdk";
import { formatTimestamp, roleLabel, UsersPanelView } from "../src/web/users-view.js";

afterEach(cleanup);

const CREATED_AT = "2026-01-02T03:04:05.000Z";

function user(overrides: Partial<UserAdminUser> = {}): UserAdminUser {
	return {
		id: "u1",
		username: "alice",
		role: "admin",
		createdAt: CREATED_AT,
		updatedAt: CREATED_AT,
		...overrides,
	};
}

function snapshot(users: UserAdminUser[], currentUserId = "u1"): UserAdminSnapshot {
	return { api: 1, users, currentUserId };
}

function actions() {
	return {
		onCreate: vi.fn(),
		onResetPassword: vi.fn(),
		onSetRole: vi.fn(),
		onRemove: vi.fn(),
		onRefresh: vi.fn(),
	};
}

describe("UsersPanelView", () => {
	it("lists accounts, marks the current user, and never renders a credential", () => {
		const handlers = actions();
		const { container } = render(
			<UsersPanelView
				status="ready"
				snapshot={snapshot([user(), user({ id: "u2", username: "bob", role: "user" })])}
				{...handlers}
			/>,
		);

		expect(screen.getByRole("heading", { name: "用户管理" })).toBeTruthy();
		expect(screen.getByText("2 个账户 · 仅管理员可见")).toBeTruthy();

		const rows = container.querySelectorAll(".pm-user-row");
		expect(rows).toHaveLength(2);
		expect(within(rows[0] as HTMLElement).getByText("alice")).toBeTruthy();
		expect(within(rows[0] as HTMLElement).getByText("管理员")).toBeTruthy();
		expect(within(rows[0] as HTMLElement).getByText("我")).toBeTruthy();
		expect(within(rows[0] as HTMLElement).getByText(/创建于 2026-01-02 03:04/)).toBeTruthy();
		expect(within(rows[1] as HTMLElement).getByText("bob")).toBeTruthy();
		expect(within(rows[1] as HTMLElement).getByText("用户")).toBeTruthy();
		expect(within(rows[1] as HTMLElement).queryByText("我")).toBeNull();

		// A password only ever exists inside a password input, never as rendered text.
		const password = screen.getByLabelText("密码");
		expect(password.tagName).toBe("INPUT");
		expect(password.getAttribute("type")).toBe("password");
		expect(container.textContent).not.toMatch(/password/i);
	});

	it("creates an account with the chosen role and clears the form", () => {
		const handlers = actions();
		render(<UsersPanelView status="ready" snapshot={snapshot([user()])} {...handlers} />);

		expect(screen.getByRole("button", { name: "创建账户" }).hasAttribute("disabled")).toBe(true);
		fireEvent.change(screen.getByLabelText("用户名"), { target: { value: "  bob  " } });
		fireEvent.change(screen.getByLabelText("密码"), { target: { value: "s3cret-pass" } });
		fireEvent.change(screen.getByLabelText("角色"), { target: { value: "admin" } });
		fireEvent.click(screen.getByRole("button", { name: "创建账户" }));

		expect(handlers.onCreate).toHaveBeenCalledWith({
			username: "bob",
			password: "s3cret-pass",
			role: "admin",
		});
		expect((screen.getByLabelText("用户名") as HTMLInputElement).value).toBe("");
		expect((screen.getByLabelText("密码") as HTMLInputElement).value).toBe("");
		expect((screen.getByLabelText("角色") as HTMLSelectElement).value).toBe("user");
	});

	it("resets a password, toggles a role, and removes an account", () => {
		const handlers = actions();
		const alice = user();
		const bob = user({ id: "u2", username: "bob", role: "user" });
		const { container } = render(
			<UsersPanelView status="ready" snapshot={snapshot([alice, bob])} {...handlers} />,
		);
		const rows = container.querySelectorAll(".pm-user-row");
		const aliceRow = rows[0] as HTMLElement;
		const bobRow = rows[1] as HTMLElement;

		fireEvent.click(within(aliceRow).getByRole("button", { name: "重置密码" }));
		expect(handlers.onResetPassword).toHaveBeenCalledWith(alice);

		fireEvent.click(within(aliceRow).getByRole("button", { name: "设为用户" }));
		expect(handlers.onSetRole).toHaveBeenCalledWith(alice, "user");

		fireEvent.click(within(bobRow).getByRole("button", { name: "设为管理员" }));
		expect(handlers.onSetRole).toHaveBeenLastCalledWith(bob, "admin");

		fireEvent.click(within(bobRow).getByRole("button", { name: "删除" }));
		expect(handlers.onRemove).toHaveBeenCalledWith(bob);
		expect(handlers.onRefresh).not.toHaveBeenCalled();
	});

	it("shows notices, the deletion warning, errors, and locks controls while busy", () => {
		const handlers = actions();
		render(
			<UsersPanelView
				status="ready"
				snapshot={snapshot([user(), user({ id: "u2", username: "bob", role: "user" })])}
				notice="已创建账户 bob（用户）。"
				warning="账户已删除，但插件数据清理失败；数据已不可访问，请联系维护者清理。"
				error="不能降级最后一个管理员"
				busy="remove:u2"
				{...handlers}
			/>,
		);
		expect(screen.getByText("已创建账户 bob（用户）。")).toBeTruthy();
		expect(screen.getByText(/插件数据清理失败/)).toBeTruthy();
		expect(screen.getByText("不能降级最后一个管理员")).toBeTruthy();
		for (const button of screen.getAllByRole("button")) {
			expect(button.hasAttribute("disabled")).toBe(true);
		}
	});

	it("renders a loading note without the form, and an authorization error without a list", () => {
		render(<UsersPanelView status="loading" {...actions()} />);
		expect(screen.getByText("读取账户列表…")).toBeTruthy();
		expect(screen.queryByRole("button", { name: "创建账户" })).toBeNull();

		cleanup();
		render(<UsersPanelView status="error" error="需要管理员权限，请重新登录。" {...actions()} />);
		expect(screen.getByText("需要管理员权限，请重新登录。")).toBeTruthy();
		expect(screen.queryByRole("list")).toBeNull();
	});

	it("labels roles and timestamps for humans without locale dependence", () => {
		expect(roleLabel("admin")).toBe("管理员");
		expect(roleLabel("user")).toBe("用户");
		expect(formatTimestamp(CREATED_AT)).toBe("2026-01-02 03:04");
		expect(formatTimestamp("not-a-timestamp")).toBe("not-a-timestamp");
	});
});
