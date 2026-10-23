import { AppContract, type PanelInfo } from "@moonan_ai/contracts";
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

/**
 * Panels come from the server's `panels` registry; the components stay here because
 * Chord never ships code to the browser. An unknown id renders a placeholder instead
 * of breaking the shell.
 */
const COMPONENTS: Record<string, (props: TabProps) => ReactNode> = {
	chat: ChatTab,
	logs: LogsTab,
	agents: AgentsTab,
	providers: ProvidersTab,
	mcp: McpTab,
};

function UnknownPanel({ id }: { id: string }) {
	const t = useT();
	return (
		<section className="panel">
			<h2>{t("panel.unknown.title")}</h2>
			<p className="muted">
				{t("panel.unknown.body")} <code>{id}</code>
			</p>
		</section>
	);
}

function currentRoute(panels: PanelInfo[]): string {
	const hash = location.hash.replace(/^#\/?/, "");
	return panels.some((panel) => panel.id === hash) ? hash : (panels[0]?.id ?? "");
}

function Shell({ app, locale, user, version, panels }: TabProps & { version: string; panels: PanelInfo[] }) {
	const t = useT();
	const { status } = useConnection();
	const [route, setRoute] = useState(() => currentRoute(panels));
	const active = panels.find((panel) => panel.id === route) ?? panels[0];
	const activeId = active?.id ?? "";

	useEffect(() => {
		const onHash = () => setRoute(currentRoute(panels));
		window.addEventListener("hashchange", onHash);
		return () => window.removeEventListener("hashchange", onHash);
	}, [panels]);

	useEffect(() => {
		if (!active && panels.length > 0) setRoute(panels[0]?.id ?? "");
	}, [active, panels]);

	const Component = COMPONENTS[activeId];

	return (
		<div className="shell">
			<header className="topbar">
				<div className="brand">
					Moonan
					<small>{version || t("brand.tagline")}</small>
				</div>
				<nav className="tabs" aria-label="Primary">
					{panels.map((panel) => (
						<button
							key={panel.id}
							type="button"
							className="tab"
							data-active={panel.id === activeId}
							onClick={() => {
								location.hash = `#/${panel.id}`;
								setRoute(panel.id);
							}}
						>
							{t(panel.titleKey)}
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
			<main className={activeId === "chat" ? "main main--flush" : "main"}>
				{Component ? (
					<Component app={app} locale={locale} user={user} />
				) : active ? (
					<UnknownPanel id={active.id} />
				) : (
					<div className="loading">{t("panel.unknown.title")}</div>
				)}
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
	const panels = useReadable<PanelInfo[]>(app?.panels, []);

	if (!host || !app) {
		return <div className="loading">Moonan / 连接中</div>;
	}

	return (
		<LocaleProvider locale={locale === "en" ? "en" : "zh"}>
			<Shell
				app={app}
				locale={locale === "en" ? "en" : "zh"}
				user={user}
				version={version}
				panels={panels}
			/>
		</LocaleProvider>
	);
}

export function App() {
	return <Bootstrapped />;
}
