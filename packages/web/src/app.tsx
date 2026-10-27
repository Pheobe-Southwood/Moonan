import { isChordError, type Host } from "@earendil-works/chord";
import { Manifest, type FacetSetEntry } from "@moonan_ai/sdk";
import { useReadable, useRefStatus, useRemote, type PanelContribution } from "@moonan_ai/sdk/web";
import { useEffect, useState } from "react";
import { useConnection } from "./chord/connection.js";
import { useFacetBatches } from "./chord/facets.js";
import { usePanels } from "./chord/panels.js";
import { reloadOnce } from "./chord/reload.js";

/**
 * The shell knows no panel and holds no application state.
 *
 * Every tab is registered by a plugin's browser facet into this host's `Panels`
 * registry, and the list of facets to load comes from the platform's `Manifest`. Adding
 * a feature means shipping a plugin, never editing this file.
 */
function currentRoute(panels: PanelContribution[]): string {
	const hash = location.hash.replace(/^#\/?/, "");
	return panels.some((panel) => panel.id === hash) ? hash : (panels[0]?.id ?? "");
}

function Recovery({ title, detail }: { title: string; detail?: string }) {
	return (
		<section className="empty">
			<h2>{title}</h2>
			{detail ? <p>{detail}</p> : null}
			<p>
				<button type="button" onClick={() => location.reload()}>
					刷新页面 · Reload
				</button>
			</p>
		</section>
	);
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
						<p>平台已在运行，但没有任何插件注册面板。</p>
						<code>moonan --plugin &lt;包名或目录&gt;</code>
					</div>
				)}
			</main>
		</div>
	);
}

function Bootstrapped() {
	const { host, error } = useConnection();
	const [manifestFatal, setManifestFatal] = useState<unknown>(null);
	const manifest = useRemote(host, Manifest, {}, { onFatal: setManifestFatal });
	const manifestStatus = useRefStatus(manifest);
	const version = useReadable<string>(manifest?.version, "");
	const facets = useReadable<FacetSetEntry[]>(manifest?.facets, []);
	const panels = usePanels(host);

	const live = manifestStatus === "live";
	// Chord owns the facet transaction; the hook owns only the shell's ledger of what is
	// installed (see facets.ts for the commit-vs-ready rules).
	const { signature: installedSignature, failures, batchFailure } = useFacetBatches(host, live, facets);

	// Hydration gates the shell; a reconnect does not. A dropped link puts the reference back
	// to `loading` while its last values stay readable, and unmounting the panels for that
	// would release every reference the drop was supposed to preserve.
	const [everLive, setEverLive] = useState(false);
	useEffect(() => {
		if (live) setEverLive(true);
	}, [live]);

	// A Manifest that cannot bind will never become useful: the page needs the build that
	// knows the provider contract. `useRemote` reports only after its bounded retries, and
	// contract errors do not retry at all.
	useEffect(() => {
		if (!manifestFatal) return;
		if (
			isChordError(manifestFatal, "contract_mismatch") ||
			isChordError(manifestFatal, "upgrade_required")
		) {
			reloadOnce("manifest contract mismatch");
		}
	}, [manifestFatal]);

	if (error) {
		// The shell that would know the user's language is exactly what failed to negotiate.
		return <Recovery title="界面版本不匹配 · UI version mismatch" detail="服务端已经更新，请刷新页面。 Reload the page to continue." />;
	}

	if (manifestFatal) {
		return (
			<Recovery
				title="界面需要刷新 · Reload required"
				detail={manifestFatal instanceof Error ? manifestFatal.message : String(manifestFatal)}
			/>
		);
	}

	if (batchFailure) {
		return <Recovery title="浏览器切面加载失败 · Facet batch failed" detail={batchFailure} />;
	}

	if (!host || !(live || everLive)) {
		return <div className="loading">Moonan / 连接中</div>;
	}

	// Only the first install gates the shell; a later revision swaps facets in place.
	if (!installedSignature) {
		return <div className="loading">Moonan …</div>;
	}

	const reported = facets.filter((facet) => facet.error);

	return (
		<>
			{failures.length > 0 || reported.length > 0 ? (
				<div className="banner">
					{[...reported.map((facet) => `${facet.name}: ${facet.error}`), ...failures].map((line) => (
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
