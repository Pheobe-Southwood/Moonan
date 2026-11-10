import { Component, type ErrorInfo, type ReactNode } from "react";
import { defineFacet, local, method, obj } from "@moonan_ai/sdk";
import { Panels, type PanelProps } from "@moonan_ai/sdk/web";
import { PluginsPanel } from "./app.js";
import { PLUGIN_MANAGER_CSS } from "./styles.js";

class ManagerBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
	override state = { error: null as Error | null };

	static getDerivedStateFromError(error: Error) {
		return { error };
	}

	override componentDidCatch(error: Error, info: ErrorInfo) {
		console.error("[plugin-manager] panel crashed", error, info.componentStack);
	}

	override render() {
		if (!this.state.error) return this.props.children;
		return (
			<div className="pm-root">
				<div className="pm-note pm-note-error">
					<strong>插件管理面板遇到一个错误</strong>
					<div>{this.state.error.message}</div>
					<button type="button" className="pm-btn" onClick={() => location.reload()}>
						刷新页面
					</button>
				</div>
			</div>
		);
	}
}

function SafePanel(props: PanelProps) {
	// The stylesheet is rendered by the panel, not injected in the facet's `setup`: facet
	// setup runs during a reload's prepare, where side effects are not allowed to outlive a
	// candidate that might be rolled back.
	return (
		<>
			<style>{PLUGIN_MANAGER_CSS}</style>
			<ManagerBoundary>
				<PluginsPanel host={props.host} />
			</ManagerBoundary>
		</>
	);
}

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
			self.register(Panels, {
				plugins: {
					id: "plugins",
					title: "插件",
					order: 90,
					component: SafePanel,
				},
			});
			return { noop: () => undefined };
		},
		{ lifetime: "host" },
	);
});
