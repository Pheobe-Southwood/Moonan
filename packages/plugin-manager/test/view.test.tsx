import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginAdminEntry, PluginAdminSnapshot } from "@moonan_ai/sdk";
import { PluginsPanelView } from "../src/web/view.js";

afterEach(cleanup);

function entry(overrides: Partial<PluginAdminEntry> = {}): PluginAdminEntry {
	return {
		id: "a",
		ref: "a",
		name: "a",
		version: "1.0.0",
		source: "package",
		builtin: false,
		locked: false,
		ephemeral: false,
		enabled: true,
		loaded: true,
		server: true,
		startupSkipped: false,
		web: null,
		...overrides,
	};
}

function snapshot(plugins: PluginAdminEntry[], overrides: Partial<PluginAdminSnapshot> = {}): PluginAdminSnapshot {
	return {
		api: 2,
		version: "0.1.0",
		revision: 2,
		paths: {
			cwd: "/tmp",
			pluginsFile: "/tmp/plugins.json",
			dataDb: "/tmp/data.db",
			authDb: "/tmp/auth.db",
			pluginsDir: "/tmp/plugins",
		},
		plugins,
		...overrides,
	};
}

function actions() {
	return {
		onToggle: vi.fn(),
		onRemove: vi.fn(),
		onInstall: vi.fn(),
		onReload: vi.fn(),
		onRefresh: vi.fn(),
	};
}

describe("PluginsPanelView", () => {
	it("lists plugins with their badges and disables locked actions", () => {
		const handlers = actions();
		render(
			<PluginsPanelView
				status="ready"
				snapshot={snapshot([
					entry({ id: "a", ref: "a", name: "Alpha", builtin: true }),
					entry({ id: "b", ref: "b", name: "Beta", locked: true, builtin: true }),
				])}
				{...handlers}
			/>,
		);
		expect(screen.getByText("Alpha")).toBeTruthy();
		expect(screen.getByText("Beta")).toBeTruthy();
		expect(screen.getAllByText("内置")).toHaveLength(2);
		expect(screen.getByText("核心")).toBeTruthy();
		// Two 停用 buttons, but the locked row's is disabled.
		const toggles = screen.getAllByRole("button", { name: "停用" });
		expect(toggles[0]?.hasAttribute("disabled")).toBe(false);
		expect(toggles[1]?.hasAttribute("disabled")).toBe(true);
	});

	it("toggles and removes an entry", () => {
		const handlers = actions();
		render(
			<PluginsPanelView
				status="ready"
				snapshot={snapshot([entry({ id: "a", ref: "a", name: "Alpha" })])}
				{...handlers}
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: "停用" }));
		expect(handlers.onToggle).toHaveBeenCalledWith("a", false);
		fireEvent.click(screen.getByRole("button", { name: "移除" }));
		expect(handlers.onRemove).toHaveBeenCalledWith("a");
	});

	it("distinguishes a loaded server plugin, an unloaded one, and a web-only one", () => {
		const handlers = actions();
		render(
			<PluginsPanelView
				status="ready"
				snapshot={snapshot([
					entry({ id: "running", name: "Running", server: true, loaded: true }),
					entry({ id: "waiting", name: "Waiting", server: true, loaded: false }),
					entry({
						id: "web-only",
						name: "WebOnly",
						server: false,
						loaded: true,
						web: { url: "/facets/abc/web.js", hash: "abc" },
					}),
				])}
				{...handlers}
			/>,
		);
		expect(screen.getByText(/状态：运行中/)).toBeTruthy();
		// A server plugin that is enabled but not installed yet reads as 已启用 and warns.
		expect(screen.getByText(/状态：已启用/)).toBeTruthy();
		expect(screen.getAllByText("未加载")).toHaveLength(1);
		// A web-only plugin is published, not "not loaded": it has no server work left.
		expect(screen.getByText(/状态：已发布（浏览器按需加载）/)).toBeTruthy();
		expect(screen.queryByText(/状态：已停用/)).toBeNull();
	});

	it("submits the install form", () => {
		const handlers = actions();
		render(
			<PluginsPanelView status="ready" snapshot={snapshot([entry()])} {...handlers} />,
		);
		fireEvent.change(screen.getByLabelText("插件 ref"), { target: { value: "./my-plugin" } });
		fireEvent.click(screen.getByRole("button", { name: "安装" }));
		expect(handlers.onInstall).toHaveBeenCalledWith("./my-plugin", true);
	});

	it("explains a degraded startup", () => {
		const handlers = actions();
		render(
			<PluginsPanelView
				status="ready"
				snapshot={snapshot([entry({ startupSkipped: true, enabled: true, loaded: false })], {
					startup: { degraded: true, skipped: ["bad"], message: "setup boom" },
				})}
				{...handlers}
			/>,
		);
		expect(screen.getByText(/启动失败/)).toBeTruthy();
		expect(screen.getByText(/setup boom/)).toBeTruthy();
		expect(screen.getByText("启动隔离")).toBeTruthy();
	});

	it("shows the account database path and a readable authorization error", () => {
		const handlers = actions();
		const { container } = render(
			<PluginsPanelView status="ready" snapshot={snapshot([entry()])} {...handlers} />,
		);
		expect(screen.getByText("账户数据库")).toBeTruthy();
		expect(container.textContent).toContain("/tmp/auth.db");

		cleanup();
		render(
			<PluginsPanelView status="error" error="需要管理员权限，请重新登录。" {...handlers} />,
		);
		expect(screen.getByText("需要管理员权限，请重新登录。")).toBeTruthy();
		// No read-only fallback: an authorization failure is just an error, with no list.
		expect(screen.queryByRole("list")).toBeNull();
	});
});
