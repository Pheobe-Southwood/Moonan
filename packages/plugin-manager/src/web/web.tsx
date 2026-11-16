import { Component, type ErrorInfo, type ReactNode } from "react";
import { defineFacet, local, method, obj } from "@moonan_ai/sdk";
import { Panels, type PanelProps } from "@moonan_ai/sdk/web";
import { PluginsPanel } from "./app.js";
import { PLUGIN_MANAGER_CSS } from "./styles.js";
import { UsersPanel } from "./users.js";

class ManagerBoundary extends Component<{ children: ReactNode; panel: string }, { error: Error | null }> {
	override state = { error: null as Error | null };

	static getDerivedStateFromError(error: Error) {
		return { error };
	}

	override componentDidCatch(error: Error, info: ErrorInfo) {
		console.error(`[plugin-manager] ${this.props.panel} crashed`, error, info.componentStack);
	}

	override render() {
		if (!this.state.error) return this.props.children;
		return (
			<div className="pm-root">
				<div className="pm-note pm-note-error">
					<strong>{this.props.panel}遇到一个错误</strong>
					<div>{this.state.error.message}</div>
					<button type="button" className="pm-btn" onClick={() => location.reload()}>
						刷新页面
					</button>
				</div>
			</div>
		);
	}
}

/**
 * Wraps a panel with the shared stylesheet and an error boundary.
 *
 * The stylesheet is rendered by the panel, not injected in the facet's `setup`: facet setup
 * runs during a reload's prepare, where side effects are not allowed to outlive a candidate
 * that might be rolled back.
 */
function withPanelChrome(
	Inner: (props: PanelProps) => ReactNode,
	label: string,
): (props: PanelProps) => ReactNode {
	return function SafePanel(props: PanelProps) {
		return (
			<>
				<style>{PLUGIN_MANAGER_CSS}</style>
				<ManagerBoundary panel={label}>
					<Inner host={props.host} />
				</ManagerBoundary>
			</>
		);
	};
}

const SafePluginsPanel = withPanelChrome(PluginsPanel, "插件管理面板");
const SafeUsersPanel = withPanelChrome(UsersPanel, "用户管理面板");

/** Registry contributions must come from a host-lifetime object. */
const Root = local("moonan.plugin-manager.web", {
	version: 1,
	input: obj({}, { open: true }),
	members: { noop: method() },
});

export default defineFacet((api) => {
	api.serve(
		Root,
		(_input, _principal, self) => {
			// Both panels are administrator-only: the platform answers 401/403 to everyone else,
			// and the shell hides `adminOnly` tabs before it renders them. Neither panel has a
			// read-only fallback any more.
			self.register(Panels, {
				plugins: {
					id: "plugins",
					title: "插件",
					order: 90,
					adminOnly: true,
					component: SafePluginsPanel,
				},
				users: {
					id: "users",
					title: "用户",
					order: 100,
					adminOnly: true,
					component: SafeUsersPanel,
				},
			});
			return { noop: () => undefined };
		},
		{ lifetime: "host" },
	);
});
