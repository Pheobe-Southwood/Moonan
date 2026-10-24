import { AppContract, type PluginInfo } from "@moonan_ai/contracts";
import {
	ConnDot,
	LocaleProvider,
	useReadable,
	useRemote,
	useT,
	type Locale,
	type PanelContribution,
} from "@moonan_ai/web-api";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useConnection } from "./chord/connection.js";
import { usePanels } from "./chord/panels.js";

/**
 * The shell knows no panel: every tab is registered by a plugin's web facet into the
 * browser host's `Panels` registry, then loaded at runtime. Adding a panel means
 * shipping a plugin, not editing this file.
 */
function currentRoute(panels: PanelContribution[]): string {
	const hash = location.hash.replace(/^#\/?/, "");
	return panels.some((panel) => panel.id === hash) ? hash : (panels[0]?.id ?? "");
}

interface ShellProps {
	host: unknown;
	app: any;
	locale: Locale;
	user: string;
	version: string;
	panels: PanelContribution[];
	children?: ReactNode;
}

function Shell({ host, app, locale, user, version, panels }: ShellProps) {
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

	const Active = active?.component;

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
							{panel.title[locale] ?? panel.id}
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
				{Active ? (
					<Active host={host} user={user} locale={locale} />
				) : (
					<div className="loading">{t("panel.empty")}</div>
				)}
			</main>
		</div>
	);
}

function Bootstrapped() {
	const { host, generation, error } = useConnection();
	const app = useRemote(host, AppContract, {});
	const locale = useReadable<Locale>(app?.locale, "zh");
	const user = useReadable<string>(app?.user, "你");
	const version = useReadable<string>(app?.version, "");
	const plugins = useReadable<PluginInfo[]>(app?.plugins, []);
	const panels = usePanels(host);

	// Load every plugin's web facet once per host. A broken module is reported and
	// skipped: one bad plugin must not take the shell down with it.
	const webSignature = plugins
		.filter((plugin) => plugin.web)
		.map((plugin) => plugin.web)
		.join("|");
	const loadedFor = useRef("");
	const [loadedKey, setLoadedKey] = useState("");
	const [loadError, setLoadError] = useState<string | null>(null);

	useEffect(() => {
		if (!host) return;
		const key = `${generation}:${webSignature}`;
		if (loadedFor.current === key) return;
		loadedFor.current = key;
		let cancelled = false;
		void (async () => {
			for (const url of webSignature ? webSignature.split("|") : []) {
				try {
					await host.load([url]);
				} catch (cause) {
					const message = `${url}: ${cause instanceof Error ? cause.message : String(cause)}`;
					console.error("[chord] web facet failed to load", cause);
					if (!cancelled) setLoadError(message);
				}
			}
			if (!cancelled) setLoadedKey(key);
		})();
		return () => {
			cancelled = true;
		};
	}, [host, generation, webSignature]);

	if (error) {
		// The locale is unknown this early, and the shell that would know it is
		// exactly what failed to negotiate, so these two strings stay literal.
		return (
			<section className="panel">
				<h2>界面版本不匹配 · UI version mismatch</h2>
				<p className="muted">服务端已经更新，请刷新页面。Reload the page to continue.</p>
			</section>
		);
	}

	if (!host || !app) {
		return <div className="loading">Moonan / 连接中</div>;
	}

	const ready = loadedKey === `${generation}:${webSignature}`;
	const resolvedLocale: Locale = locale === "en" ? "en" : "zh";

	return (
		<LocaleProvider locale={resolvedLocale}>
			{loadError ? <div className="banner">{loadError}</div> : null}
			{ready ? (
				<Shell
					host={host}
					app={app}
					locale={resolvedLocale}
					user={user}
					version={version}
					panels={panels}
				/>
			) : (
				<div className="loading">Moonan …</div>
			)}
		</LocaleProvider>
	);
}

export function App() {
	return <Bootstrapped />;
}
