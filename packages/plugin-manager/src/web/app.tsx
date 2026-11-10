import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { WebFacetCatalog, type FacetSetEntry, type PluginAdminSnapshot } from "@moonan_ai/sdk";
import { useReadable, useRemote, type PanelProps } from "@moonan_ai/sdk/web";
import { createPluginAdminClient, PluginAdminRequestError } from "./api.js";
import { PluginsPanelView, type ReadOnlyPlugin, type ViewStatus } from "./view.js";

function messageOf(error: unknown): string {
	if (error instanceof PluginAdminRequestError) {
		const parts = [error.message];
		const code = error.chordCode && error.chordCode !== error.code ? `${error.code ?? "?"}/${error.chordCode}` : error.code;
		if (code !== undefined) parts.push(`(${code}${error.reason ? `: ${error.reason}` : ""})`);
		if (error.committed) parts.push("— chord 提交已生效，但宿主对象激活失败");
		return parts.join(" ");
	}
	return error instanceof Error ? error.message : String(error);
}

/**
 * The 插件 tab. It reads `/api/v1/plugins` and asks the platform for each change; the
 * WebFacetCatalog revision is the signal that a commit landed, so the list also refreshes
 * when another tab (or the CLI) toggles something.
 */
export function PluginsPanel({ host }: PanelProps) {
	const client = useMemo(() => createPluginAdminClient(), []);
	const catalog = useRemote(host, WebFacetCatalog, {});
	const revision = useReadable<number>(catalog?.revision, -1);
	// A web-only toggle does not commit chord (no code version bump); the facet set is the
	// signal that another tab changed the plugin list.
	const facets = useReadable<FacetSetEntry[]>(catalog?.facets, []);

	const [status, setStatus] = useState<ViewStatus>("loading");
	const [snapshot, setSnapshot] = useState<PluginAdminSnapshot | undefined>();
	const [readOnlyPlugins, setReadOnlyPlugins] = useState<readonly ReadOnlyPlugin[] | undefined>();
	const [error, setError] = useState<string | undefined>();
	const [notice, setNotice] = useState<string | undefined>();
	const [busy, setBusy] = useState<string | undefined>();
	const mounted = useRef(true);

	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);

	const load = useCallback(async () => {
		try {
			const next = await client.snapshot();
			if (!mounted.current) return;
			setSnapshot(next);
			setReadOnlyPlugins(undefined);
			setStatus("ready");
			setError(undefined);
		} catch (failure) {
			if (!mounted.current) return;
			if (failure instanceof PluginAdminRequestError && failure.code === "management_disabled") {
				setStatus("disabled");
				setError(undefined);
				try {
					const response = await fetch("/api/plugins");
					const body = (await response.json()) as { plugins?: ReadOnlyPlugin[] };
					if (mounted.current) setReadOnlyPlugins(body.plugins ?? []);
				} catch {
					// The banner explains how to enable management; the list stays empty.
				}
				return;
			}
			setStatus("error");
			setError(messageOf(failure));
		}
	}, [client]);

	useEffect(() => {
		void load();
	}, [load]);

	// A chord commit or a web-only facet change landed (any tab): refresh.
	useEffect(() => {
		if (revision >= 0) void load();
	}, [revision, facets, load]);

	const run = useCallback(
		async (key: string, action: () => Promise<unknown>, success: string) => {
			setBusy(key);
			setError(undefined);
			setNotice(undefined);
			try {
				await action();
				setNotice(success);
				await load();
			} catch (failure) {
				setError(messageOf(failure));
			} finally {
				if (mounted.current) setBusy(undefined);
			}
		},
		[load],
	);

	const toggle = (id: string, enabled: boolean): void => {
		void run(id, () => client.setEnabled(id, enabled), enabled ? "已启用" : "已停用");
	};

	const remove = (id: string): void => {
		if (!window.confirm(`移除插件 ${id}？\n\n只从加载列表移除，不会卸载 npm 包或删除目录。`)) return;
		void run(id, () => client.remove(id), "已移除");
	};

	const install = (ref: string, enable: boolean): void => {
		void run(`install:${ref}`, () => client.add(ref, { enable }), "已添加");
	};

	const reload = (): void => {
		void run("__reload__", () => client.reload(), "已重新加载");
	};

	return (
		<PluginsPanelView
			status={status}
			{...(snapshot ? { snapshot } : {})}
			{...(readOnlyPlugins ? { readOnlyPlugins } : {})}
			{...(error ? { error } : {})}
			{...(notice ? { notice } : {})}
			{...(busy ? { busy } : {})}
			onToggle={toggle}
			onRemove={remove}
			onInstall={install}
			onReload={reload}
			onRefresh={() => void load()}
		/>
	);
}
