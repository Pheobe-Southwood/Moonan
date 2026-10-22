import { AppContract } from "@moonan/contracts";
import { useEffect, useState, type ReactNode } from "react";
import { useConnection } from "./chord/connection.js";
import { useReadable, useRemote } from "./chord/hooks.js";
import { LocaleProvider, useT, type Locale } from "./i18n.js";
import { ChatTab } from "./plugins/chat/ui.js";
import { LogsTab } from "./plugins/logs/ui.js";
import { AgentsTab } from "./plugins/agents/ui.js";
import { ProvidersTab } from "./plugins/providers/ui.js";
import { McpTab } from "./plugins/mcp/ui.js";
import { ConnDot } from "./ui.js";

export interface TabProps {
	app: any;
	locale: Locale;
	user: string;
}

interface TabDefinition {
	id: string;
	label: string;
	Component: (props: TabProps) => ReactNode;
}

const TABS: TabDefinition[] = [
	{ id: "chat", label: "nav.chat", Component: ChatTab },
	{ id: "logs", label: "nav.logs", Component: LogsTab },
	{ id: "agents", label: "nav.agents", Component: AgentsTab },
	{ id: "providers", label: "nav.providers", Component: ProvidersTab },
	{ id: "mcp", label: "nav.mcp", Component: McpTab },
];

function currentRoute(): string {
	const hash = location.hash.replace(/^#\/?/, "");
	return TABS.some((tab) => tab.id === hash) ? hash : "chat";
}

function Shell({ app, locale, user, version }: TabProps & { version: string }) {
	const t = useT();
	const { status } = useConnection();
	const [route, setRoute] = useState(currentRoute);

	useEffect(() => {
		const onHash = () => setRoute(currentRoute());
		window.addEventListener("hashchange", onHash);
		return () => window.removeEventListener("hashchange", onHash);
	}, []);

	const active = TABS.find((tab) => tab.id === route) ?? (TABS[0] as TabDefinition);
	const Component = active.Component;

	return (
		<div className="shell">
			<header className="topbar">
				<div className="brand">
					Moonan
					<small>{version || t("brand.tagline")}</small>
				</div>
				<nav className="tabs" aria-label="Primary">
					{TABS.map((tab) => (
						<button
							key={tab.id}
							type="button"
							className="tab"
							data-active={tab.id === active.id}
							onClick={() => {
								location.hash = `#/${tab.id}`;
								setRoute(tab.id);
							}}
						>
							{t(tab.label)}
						</button>
					))}
				</nav>
				<div className="topmeta">
					<span className="conn">
						<ConnDot state={status} />
						{t(`conn.${status}`)}
					</span>
					<button
						type="button"
						className="link"
						onClick={() => {
							void app.update({ locale: locale === "zh" ? "en" : "zh" });
						}}
					>
						{locale === "zh" ? "EN" : "中文"}
					</button>
				</div>
			</header>
			<main className={active.id === "chat" ? "main main--flush" : "main"}>
				<Component app={app} locale={locale} user={user} />
			</main>
		</div>
	);
}

function Bootstrapped() {
	const { host } = useConnection();
	const app = useRemote(AppContract, {});
	const locale = useReadable<Locale>(app?.locale, "zh");
	const user = useReadable<string>(app?.user, "你");
	const version = useReadable<string>(app?.version, "");

	if (!host || !app) {
		return <div className="loading">Moonan / 连接中</div>;
	}

	return (
		<LocaleProvider locale={locale === "en" ? "en" : "zh"}>
			<Shell app={app} locale={locale === "en" ? "en" : "zh"} user={user} version={version} />
		</LocaleProvider>
	);
}

export function App() {
	return <Bootstrapped />;
}
