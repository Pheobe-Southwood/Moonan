import { Manifest, type PluginEntry } from "@moonan_ai/sdk";
import { useReadable, useRemote, type PanelContribution } from "@moonan_ai/sdk/web";
import { useEffect, useRef, useState } from "react";
import { useConnection } from "./chord/connection.js";
import { usePanels } from "./chord/panels.js";

/**
 * The shell knows no panel and holds no application state.
 *
 * Every tab is registered by a plugin's browser facet into this host's `Panels`
 * registry, and the list of facets to load comes from the substrate's `Manifest`. Adding
 * a feature means shipping a plugin, never editing this file.
 */
function currentRoute(panels: PanelContribution[]): string {
	const hash = location.hash.replace(/^#\/?/, "");
	return panels.some((panel) => panel.id === hash) ? hash : (panels[0]?.id ?? "");
}

function Shell({ host, version, panels }: { host: unknown; version: string; panels: PanelContribution[] }) {
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
					<small>{version}</small>
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
							{panel.title}
						</button>
					))}
				</nav>
				<div className="topmeta">
					<span className="conn" data-state={status}>
						<i />
						{status}
					</span>
				</div>
			</header>
			<main className="main">
				{Active ? (
					<Active host={host as never} />
				) : (
					<div className="empty">
						<h2>没有插件</h2>
						<p>基座已在运行，但没有任何插件注册面板。</p>
						<code>moonan --plugin &lt;包名或目录&gt;</code>
					</div>
				)}
			</main>
		</div>
	);
}

function Bootstrapped() {
	const { host, generation, error } = useConnection();
	const manifest = useRemote(host, Manifest, {});
	const version = useReadable<string>(manifest?.version, "");
	const entries = useReadable<PluginEntry[]>(manifest?.plugins, []);
	const panels = usePanels(host);

	// The web facets to load, as one string: it is the dependency that says "the set
	// changed", so a reload of the shell does not re-import every plugin for nothing.
	const webSignature = entries
		.filter((entry) => entry.web)
		.map((entry) => entry.web)
		.join("|");

	const loadedFor = useRef("");
	const [loadedKey, setLoadedKey] = useState("");
	const [failures, setFailures] = useState<string[]>([]);

	useEffect(() => {
		if (!host) return;
		const key = `${generation}:${webSignature}`;
		if (loadedFor.current === key) return;
		loadedFor.current = key;
		let cancelled = false;
		void (async () => {
			const failed: string[] = [];
			for (const url of webSignature ? webSignature.split("|") : []) {
				try {
					await host.load([url]);
				} catch (cause) {
					// One broken plugin must not take the shell — or the other panels — down.
					const message = `${url}: ${cause instanceof Error ? cause.message : String(cause)}`;
					console.error("[chord] web facet failed to load", cause);
					failed.push(message);
				}
			}
			if (cancelled) return;
			setFailures(failed);
			setLoadedKey(key);
		})();
		return () => {
			cancelled = true;
		};
	}, [host, generation, webSignature]);

	if (error) {
		// The shell that would know the user's language is exactly what failed to negotiate.
		return (
			<section className="empty">
				<h2>界面版本不匹配 · UI version mismatch</h2>
				<p>服务端已经更新，请刷新页面。Reload the page to continue.</p>
			</section>
		);
	}

	if (!host || !manifest) {
		return <div className="loading">Moonan / 连接中</div>;
	}

	if (loadedKey !== `${generation}:${webSignature}`) {
		return <div className="loading">Moonan …</div>;
	}

	const reported = entries.filter((entry) => entry.error);

	return (
		<>
			{failures.length > 0 || reported.length > 0 ? (
				<div className="banner">
					{[...reported.map((entry) => `${entry.id}: ${entry.error}`), ...failures].map((line) => (
						<div key={line}>{line}</div>
					))}
				</div>
			) : null}
			<Shell host={host} version={version} panels={panels} />
		</>
	);
}

export function App() {
	return <Bootstrapped />;
}
