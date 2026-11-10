import { Component, type ErrorInfo, type ReactNode } from "react";
import { defineFacet, local, method, obj } from "@moonan_ai/sdk";
import { Panels } from "@moonan_ai/sdk/web";
import { AiGatewayPanel } from "./app.js";
import { GATEWAY_CSS } from "./styles.js";

// The server facet and this browser facet share one contract source. Exporting the
// contract tokens lets `scripts/check-contracts.mjs` prove, after each build, that the two
// artifacts carry the same fingerprints instead of trusting that both bundles were rebuilt.
export { AiGateway, GatewayState } from "../contract.js";

class GatewayBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
	override state = { error: null as Error | null };

	static getDerivedStateFromError(error: Error) {
		return { error };
	}

	override componentDidCatch(error: Error, info: ErrorInfo) {
		console.error("[ai-gateway] panel crashed", error, info.componentStack);
	}

	override render() {
		if (!this.state.error) return this.props.children;
		return (
			<div className="gw-root">
				<div className="gw-gone">
					<strong>模型面板遇到一个错误</strong>
					<p>{this.state.error.message}</p>
					<button type="button" className="gw-btn" onClick={() => location.reload()}>
						刷新页面
					</button>
				</div>
			</div>
		);
	}
}

function SafePanel(props: { host: Parameters<typeof AiGatewayPanel>[0]["host"] }) {
	// The stylesheet is rendered by the panel, not injected in the facet's `setup`: facet
	// setup runs during a reload's prepare, where side effects are not allowed to outlive a
	// candidate that might be rolled back.
	return (
		<>
			<style>{GATEWAY_CSS}</style>
			<GatewayBoundary>
				<AiGatewayPanel host={props.host} />
			</GatewayBoundary>
		</>
	);
}

/** Registry contributions must come from a host-lifetime object. */
const Root = local("moonan.ai-gateway.web", {
	version: 1,
	input: obj({}, { open: true }),
	members: { noop: method() },
});

export default defineFacet((api) => {
	api.serve(
		Root,
		(_input, _principal, self) => {
			self.register(Panels, {
				"ai-gateway": {
					id: "ai-gateway",
					title: "模型",
					order: 20,
					component: SafePanel,
				},
			});
			return { noop: () => undefined };
		},
		{ lifetime: "host" },
	);
});
