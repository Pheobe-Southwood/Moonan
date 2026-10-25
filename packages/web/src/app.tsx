import type { Host } from "@earendil-works/chord";
import { Manifest, type PluginEntry } from "@moonan_ai/sdk";
import { useReadable, useRefStatus, useRemote, type PanelContribution } from "@moonan_ai/sdk/web";
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

function Shell({ host, version, panels }: { host: Host<unknown>; version: string; panels: PanelContribution[] }) {
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
					<Active host={host} />
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
	const { host, error } = useConnection();
	const manifest = useRemote(host, Manifest, {});
	const manifestStatus = useRefStatus(manifest);
	const revision = useReadable<number>(manifest?.revision, 0);
	const version = useReadable<string>(manifest?.version, "");
	const entries = useReadable<PluginEntry[]>(manifest?.plugins, []);
	const panels = usePanels(host);

	// The web facets to load, as one string: it is the dependency that says "the set
	// changed". A manifest revision change means the server committed new code — a browser
	// is not a reload participant, so this state member is the only signal it gets.
	const webSignature = entries
		.filter((entry) => entry.web)
		.map((entry) => entry.web)
		.join("|");
	const signature = `${webSignature}#${revision}`;

	// What this shell has installed, and under which revision. Kept in a ref so a reload
	// can diff the facet set without making the effect depend on its own result.
	const installed = useRef<{ urls: string[]; revision: number } | null>(null);
	const [installedSignature, setInstalledSignature] = useState("");
	const [failures, setFailures] = useState<string[]>([]);
	const live = manifestStatus === "live";

	// Hydration gates the shell; a reconnect does not. A dropped link puts the reference back
	// to `loading` while its last values stay readable, and unmounting the panels for that
	// would release every reference the drop was supposed to preserve.
	const [everLive, setEverLive] = useState(false);
	useEffect(() => {
		if (live) setEverLive(true);
	}, [live]);

	useEffect(() => {
		if (!host || !live) return;
		const previous = installed.current;
		if (previous && previous.revision === revision && previous.urls.join("|") === webSignature) return;

		const urls = webSignature ? webSignature.split("|") : [];
		installed.current = { urls, revision };
		let cancelled = false;

		void (async () => {
			const failed: string[] = [];
			const removed = previous ? previous.urls.filter((url) => !urls.includes(url)) : [];
			try {
				// One batch, as chord intends: every facet is installed before any host object
				// activates, so a facet may consume a type installed by a later one.
				if (previous === null) await host.load(urls);
				else await host.reload(urls, removed.length > 0 ? { remove: removed } : {});
			} catch (cause) {
				// A batch fails as a whole; isolate so one broken facet does not hide the rest.
				// `reload` installs a facet the batch never reached and re-runs the factory of one
				// it did, so neither case needs chord's "already installed" text to tell apart.
				console.error("[chord] facet batch failed", cause);
				for (const url of urls) {
					try {
						await host.reload([url]);
					} catch (facetError) {
						const message = facetError instanceof Error ? facetError.message : String(facetError);
						console.error("[chord] web facet failed to load", facetError);
						failed.push(`${url}: ${message}`);
					}
				}
			}
			if (cancelled) return;
			setFailures(failed);
			setInstalledSignature(signature);
		})();

		return () => {
			cancelled = true;
		};
	}, [host, live, webSignature, revision, signature]);

	if (error) {
		// The shell that would know the user's language is exactly what failed to negotiate.
		return (
			<section className="empty">
				<h2>界面版本不匹配 · UI version mismatch</h2>
				<p>服务端已经更新，请刷新页面。Reload the page to continue.</p>
			</section>
		);
	}

	if (!host || !(live || everLive)) {
		return <div className="loading">Moonan / 连接中</div>;
	}

	// Only the first install gates the shell; a later revision swaps facets in place.
	if (!installedSignature) {
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
