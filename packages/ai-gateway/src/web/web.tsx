import { Component, type ErrorInfo, type ReactNode } from "react";
import { Type, defineFacet, local, method } from "@moonan_ai/sdk";
import { Panels } from "@moonan_ai/sdk/web";
import { AiGatewayPanel } from "./app.js";
import { GATEWAY_CSS } from "./styles.js";

const STYLE_ID = "moonan-ai-gateway-styles";

function installStyles(): void {
	if (typeof document === "undefined") return;
	const existing = document.getElementById(STYLE_ID);
	if (existing) {
		existing.textContent = GATEWAY_CSS;
		return;
	}
	const style = document.createElement("style");
	style.id = STYLE_ID;
	style.textContent = GATEWAY_CSS;
	document.head.appendChild(style);
}

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
	return (
		<GatewayBoundary>
			<AiGatewayPanel host={props.host} />
		</GatewayBoundary>
	);
}

/** Registry contributions must come from a host-lifetime object. */
const Root = local("moonan.ai-gateway.web", {
	version: 1,
	input: Type.Object({}),
	members: { noop: method() },
});

export default defineFacet((api) => {
	installStyles();
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
