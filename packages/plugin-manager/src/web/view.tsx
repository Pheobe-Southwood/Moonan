import { useState } from "react";
import type { PluginAdminEntry, PluginAdminSnapshot } from "@moonan_ai/sdk";

export type ViewStatus = "loading" | "ready" | "error" | "disabled";

/** A row from the read-only `/api/plugins` fallback, used when management is disabled. */
export interface ReadOnlyPlugin {
	name: string;
	version: string;
	source: string;
	error?: string;
	web?: { url: string } | null;
}

export interface PluginsPanelViewProps {
	status: ViewStatus;
	snapshot?: PluginAdminSnapshot;
	/** Rows shown instead of the management list when the management API is disabled. */
	readOnlyPlugins?: readonly ReadOnlyPlugin[];
	error?: string;
	notice?: string;
	/** The ref currently being changed; its buttons are disabled. */
	busy?: string;
	onToggle: (id: string, enabled: boolean) => void;
	onRemove: (id: string) => void;
	onInstall: (ref: string, enable: boolean) => void;
	onReload: () => void;
	onRefresh: () => void;
}

function Badge({ kind, children }: { kind: string; children: string }) {
	return <span className={`pm-badge pm-badge-${kind}`}>{children}</span>;
}

function EntryBadges({ entry }: { entry: PluginAdminEntry }) {
	return (
		<span className="pm-badges">
			{entry.builtin ? <Badge kind="builtin">内置</Badge> : null}
			{entry.locked ? <Badge kind="locked">核心</Badge> : null}
			{entry.ephemeral ? <Badge kind="ephemeral">临时</Badge> : null}
			{entry.startupSkipped ? <Badge kind="skipped">启动隔离</Badge> : null}
			{!entry.enabled ? <Badge kind="off">已停用</Badge> : null}
			{entry.enabled && entry.server && !entry.loaded && !entry.startupSkipped ? (
				<Badge kind="warn">未加载</Badge>
			) : null}
			{entry.error ? <Badge kind="error">解析失败</Badge> : null}
		</span>
	);
}

function PluginRow({
	entry,
	busy,
	onToggle,
	onRemove,
}: {
	entry: PluginAdminEntry;
	busy: boolean;
	onToggle: (id: string, enabled: boolean) => void;
	onRemove: (id: string) => void;
}) {
	const label = entry.name || entry.ref;
	return (
		<li className="pm-row" data-enabled={entry.enabled} data-error={entry.error !== undefined}>
			<div className="pm-row-main">
				<div className="pm-row-title">
					<strong>{label}</strong>
					<span className="pm-version">{entry.version}</span>
					<EntryBadges entry={entry} />
				</div>
				<div className="pm-row-ref" title={entry.ref}>
					{entry.ref}
				</div>
				{entry.error ? <div className="pm-row-error">{entry.error}</div> : null}
				<div className="pm-row-meta">
					<span>来源：{entry.source === "package" ? "npm 包" : "目录"}</span>
					{entry.web ? (
						<a href={entry.web.url} target="_blank" rel="noreferrer">
							浏览器切面
						</a>
					) : (
						<span>仅服务端</span>
					)}
					<span>
						状态：
						{!entry.enabled
							? "已停用"
							: !entry.server
								? "已发布（浏览器按需加载）"
								: entry.loaded
									? "运行中"
									: "已启用"}
					</span>
				</div>
			</div>
			<div className="pm-row-actions">
				<button
					type="button"
					className="pm-btn"
					disabled={busy || entry.locked}
					onClick={() => onToggle(entry.id, !entry.enabled)}
				>
					{entry.enabled ? "停用" : "启用"}
				</button>
				<button
					type="button"
					className="pm-btn pm-btn-danger"
					disabled={busy || entry.builtin || entry.locked}
					title={entry.builtin ? "内置插件无法移除（可以停用）" : "只移除加载项，不卸载 npm 包"}
					onClick={() => onRemove(entry.id)}
				>
					移除
				</button>
			</div>
		</li>
	);
}

/**
 * The pure view. It holds no chord references and performs no requests, so it can be tested
 * without a host; `app.tsx` supplies the client and the WebFacetCatalog subscription.
 */
export function PluginsPanelView(props: PluginsPanelViewProps) {
	const [ref, setRef] = useState("");
	const [enable, setEnable] = useState(true);
	const snapshot = props.snapshot;
	const busy = props.busy;

	return (
		<div className="pm-root">
			<header className="pm-header">
				<div>
					<h2>插件管理</h2>
					<p className="pm-sub">
						{snapshot
							? `平台 ${snapshot.version} · revision ${snapshot.revision} · ${snapshot.plugins.length} 个插件`
							: "启用、停用、添加或移除插件"}
					</p>
				</div>
				<div className="pm-header-actions">
					<button type="button" className="pm-btn" onClick={props.onRefresh} disabled={busy !== undefined}>
						刷新
					</button>
					<button
						type="button"
						className="pm-btn"
						onClick={props.onReload}
						disabled={busy !== undefined || props.status !== "ready"}
						title="重新解析并重载全部服务端切面"
					>
						重新加载
					</button>
				</div>
			</header>

			{props.status === "loading" ? <div className="pm-note">读取插件列表…</div> : null}
			{props.notice ? <div className="pm-note pm-note-ok">{props.notice}</div> : null}
			{props.error ? <div className="pm-note pm-note-error">{props.error}</div> : null}

			{props.status === "disabled" ? (
				<>
					<div className="pm-note pm-note-warn">
						插件管理接口未启用：默认只允许本机（回环地址）。如果确实需要远程管理，用
						<code>--allow-management</code> 启动 Moonan。下面是只读列表。
					</div>
					<ul className="pm-list">
						{(props.readOnlyPlugins ?? []).map((plugin) => (
							<li className="pm-row" key={`${plugin.name}-${plugin.version}`}>
								<div className="pm-row-main">
									<div className="pm-row-title">
										<strong>{plugin.name}</strong>
										<span className="pm-version">{plugin.version}</span>
										<Badge kind="readonly">只读</Badge>
									</div>
									<div className="pm-row-meta">
										<span>来源：{plugin.source === "package" ? "npm 包" : "目录"}</span>
										{plugin.web ? <a href={plugin.web.url}>浏览器切面</a> : null}
									</div>
									{plugin.error ? <div className="pm-row-error">{plugin.error}</div> : null}
								</div>
							</li>
						))}
					</ul>
				</>
			) : null}

			{snapshot?.startup?.degraded ? (
				<div className="pm-note pm-note-warn">
					上次启动失败，已临时停用以下插件（配置未改动）：{snapshot.startup.skipped.join(", ")}。逐个启用即可定位问题插件。
					{snapshot.startup.message ? <div className="pm-detail">{snapshot.startup.message}</div> : null}
				</div>
			) : null}
			{snapshot?.warning ? <div className="pm-note pm-note-warn">{snapshot.warning}</div> : null}

			{snapshot ? (
				<>
					<form
						className="pm-install"
						onSubmit={(event) => {
							event.preventDefault();
							const value = ref.trim();
							if (value.length === 0) return;
							props.onInstall(value, enable);
							setRef("");
						}}
					>
						<input
							type="text"
							value={ref}
							placeholder="@scope/plugin 或 /绝对路径"
							aria-label="插件 ref"
							onChange={(event) => setRef(event.target.value)}
						/>
						<label className="pm-check">
							<input type="checkbox" checked={enable} onChange={(event) => setEnable(event.target.checked)} />
							添加后立即启用
						</label>
						<button type="submit" className="pm-btn pm-btn-primary" disabled={busy !== undefined || ref.trim().length === 0}>
							安装
						</button>
					</form>
					<p className="pm-hint">
						包必须已经安装在平台所在的安装树（或当前工作目录）里；平台不会联网下载。添加后会在
						<code>plugins.json</code> 里登记，启用/停用立即生效。
					</p>

					<ul className="pm-list">
						{snapshot.plugins.length === 0 ? (
							<li className="pm-empty">还没有插件。用上面的输入框或 <code>moonan plugins add</code> 添加。</li>
						) : (
							snapshot.plugins.map((entry) => (
								<PluginRow
									key={entry.id}
									entry={entry}
									busy={busy === entry.id}
									onToggle={props.onToggle}
									onRemove={props.onRemove}
								/>
							))
						)}
					</ul>

					<details className="pm-paths">
						<summary>路径与配置</summary>
						<dl>
							<dt>插件注册表</dt>
							<dd>{snapshot.paths.pluginsFile}</dd>
							<dt>统一数据</dt>
							<dd>{snapshot.paths.dataFile}</dd>
							<dt>扫描目录</dt>
							<dd>{snapshot.paths.pluginsDir}</dd>
							<dt>解析基准</dt>
							<dd>{snapshot.paths.cwd}</dd>
						</dl>
					</details>
				</>
			) : null}
		</div>
	);
}
