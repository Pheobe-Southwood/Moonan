import type { CSSProperties } from "react";
import type { GatewaySnapshot } from "../schema.js";
import { formatTokens, maxContext, scaleHeight, totalModels } from "./format.js";
import { LockIcon } from "./icons.js";

interface FleetModel {
	providerId: string;
	providerName: string;
	modelId: string;
	modelName: string;
	contextWindow: number;
	color: string;
}

export function GatewayHeader({
	snapshot,
	selectedProviderId,
	onSelectProvider,
	colors,
}: {
	snapshot: GatewaySnapshot;
	selectedProviderId: string | null;
	onSelectProvider: (id: string) => void;
	colors: Map<string, string>;
}) {
	const providers = snapshot.providers;
	const models = totalModels(providers);
	const max = maxContext(providers);
	const fleet: FleetModel[] = [];
	for (const provider of providers) {
		for (const model of provider.models) {
			fleet.push({
				providerId: provider.id,
				providerName: provider.name,
				modelId: model.id,
				modelName: model.name,
				contextWindow: model.contextWindow,
				color: colors.get(provider.id) ?? "#b6a4ff",
			});
		}
	}
	fleet.sort((a, b) => b.contextWindow - a.contextWindow || a.modelId.localeCompare(b.modelId));
	const visible = fleet.slice(0, 84);
	const hidden = fleet.length - visible.length;
	const legendProviders = providers.slice(0, 4);
	const selectedProvider = providers.find((provider) => provider.id === selectedProviderId);
	if (selectedProvider && !legendProviders.includes(selectedProvider)) {
		legendProviders.splice(3, 1, selectedProvider);
	}
	const legendHidden = providers.filter((provider) => !legendProviders.includes(provider)).length;

	return (
		<header className="gw-head">
			<div className="gw-head-copy">
				<h1 className="gw-title">模型路由</h1>
				<p className="gw-lede">
					上游提供商、模型参数和密钥都留在这台机器的服务端。浏览器只负责显示，不保存任何业务数据。
				</p>
				<div className="gw-head-figures">
					<Figure value={String(providers.length)} label="提供商" />
					<Figure value={String(models)} label="模型" tone={models > 0 ? "violet" : undefined} />
					<Figure value={formatTokens(max)} label="最长上下文" />
					<Figure value={snapshot.storage.mode ?? (snapshot.storage.exists ? "—" : "待写入")} label="数据文件权限" tone="jade" />
				</div>
			</div>
			<section className="gw-spectrum" aria-label="模型上下文窗口分布">
				<div className="gw-spectrum-head">
					<div className="gw-spectrum-title">上下文窗口，每个柱是一枚模型</div>
					<div className="gw-spectrum-legend">
						{legendProviders.map((provider) => (
							<span
								className="gw-legend"
								key={provider.id}
								style={{ "--c": colors.get(provider.id) ?? "#b6a4ff" } as CSSProperties}
							>
								<i />
								{provider.name}
							</span>
						))}
						{legendHidden > 0 ? <span className="gw-legend">+{legendHidden}</span> : null}
					</div>
				</div>
				<div className="gw-sr">共 {models} 枚模型，最长上下文 {formatTokens(max)}。</div>
				<div className="gw-bars" aria-hidden="true">
					{visible.length === 0 ? (
						<div className="gw-bars-empty">还没有模型。添加一个提供商，把它的模型拉进来。</div>
					) : (
						visible.map((entry, index) => {
							const selected = selectedProviderId === entry.providerId;
							return (
								<button
									key={`${entry.providerId}/${entry.modelId}`}
									type="button"
									className="gw-bar"
									tabIndex={-1}
									aria-label={`${entry.providerName} · ${entry.modelName} · ${formatTokens(entry.contextWindow)} 上下文`}
									title={`${entry.providerName} / ${entry.modelName}\n${formatTokens(entry.contextWindow)} tokens`}
									onClick={() => onSelectProvider(entry.providerId)}
									style={
										{
											"--c": entry.color,
											"--i": index,
											"--o": selectedProviderId === null ? 0.78 : selected ? 1 : 0.22,
											height: `${scaleHeight(entry.contextWindow, max)}%`,
										} as CSSProperties
									}
								/>
							);
						})
					)}
				</div>
				<div className="gw-spectrum-foot">
					<span>4k</span>
					<span>{hidden > 0 ? `另有 ${hidden} 枚未显示` : "按上下文窗口从大到小"}</span>
					<span>1M</span>
				</div>
			</section>
		</header>
	);
}

function Figure({ value, label, tone }: { value: string; label: string; tone?: "jade" | "violet" }) {
	return (
		<div className="gw-figure">
			<div className="gw-figure-value" data-tone={tone}>
				{value}
			</div>
			<div className="gw-figure-label">{label}</div>
		</div>
	);
}

export function StorageNote({ snapshot }: { snapshot: GatewaySnapshot }) {
	return (
		<div className="gw-rail-note">
			<LockIcon size={11} />
			<span>
				{snapshot.storage.exists ? "已写入" : "等待首次写入"}，{snapshot.storage.dataPath}
			</span>
		</div>
	);
}
