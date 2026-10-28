import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import type { Ref } from "@moonan_ai/sdk";
import type { PanelProps } from "@moonan_ai/sdk/web";
import { useReadable, useRefStatus, useRemote } from "@moonan_ai/sdk/web";
import { AiGateway } from "../contract.js";
import type { GatewaySnapshot, ModelConfig, ProviderView } from "../schema.js";
import { Button, EmptyMark, Modal, Notice, Toggle, Toast } from "./controls.js";
import {
	AddProviderModal,
	DiscoveryDrawer,
	ProviderAdvanced,
	ProviderConnection,
	type PushToast,
	type ToastTone,
} from "./provider-panels.js";
import { ModelEditor } from "./model-editor.js";
import { GatewayHeader, StorageNote } from "./spectrum.js";
import {
	authLabel,
	formatCostPair,
	formatTokens,
	providerColors,
	reasoningCount,
	relativeTime,
	visionCount,
} from "./format.js";
import {
	AlertIcon,
	PencilIcon,
	PlusIcon,
	RefreshIcon,
	SearchIcon,
	SettingsIcon,
	TrashIcon,
} from "./icons.js";

type Tab = "models" | "connection" | "advanced";

interface ConfirmState {
	kind: "provider" | "model";
	providerId: string;
	modelId?: string;
	title: string;
	detail: string;
}

interface ToastState {
	message: { title: string; detail?: string };
	tone: ToastTone;
}

export function AiGatewayPanel({ host }: PanelProps) {
	const gateway = useRemote(host, AiGateway, {});
	const status = useRefStatus(gateway);
	const snapshot = useReadable<GatewaySnapshot | null>(gateway?.snapshot, null);

	const [selectedProviderId, setSelectedProviderId] = useState<string | null>(null);
	const [tab, setTab] = useState<Tab>("models");
	const [providerQuery, setProviderQuery] = useState("");
	const [modelQuery, setModelQuery] = useState("");
	const [addOpen, setAddOpen] = useState(false);
	const [discoveryOpen, setDiscoveryOpen] = useState(false);
	const [editor, setEditor] = useState<{ model: ModelConfig | null } | null>(null);
	const [confirm, setConfirm] = useState<ConfirmState | null>(null);
	const [confirmPending, setConfirmPending] = useState(false);
	const [toast, setToast] = useState<ToastState | null>(null);
	const [enabledPending, setEnabledPending] = useState(false);

	const pushToast = useCallback<PushToast>((tone, title, detail) => {
		setToast({ tone, message: { title, ...(detail ? { detail } : {}) } });
	}, []);
	const closeToast = useCallback(() => setToast(null), []);

	useEffect(() => {
		if (!snapshot) return;
		if (selectedProviderId && snapshot.providers.some((provider) => provider.id === selectedProviderId)) return;
		setSelectedProviderId(snapshot.providers[0]?.id ?? null);
	}, [snapshot, selectedProviderId]);

	const providers = snapshot?.providers ?? [];
	const colors = useMemo(() => providerColors(providers), [providers]);
	const selectedProvider = providers.find((provider) => provider.id === selectedProviderId) ?? providers[0] ?? null;
	const filteredProviders = useMemo(() => {
		const needle = providerQuery.trim().toLowerCase();
		if (!needle) return providers;
		return providers.filter(
			(provider) =>
				provider.name.toLowerCase().includes(needle) ||
				provider.id.toLowerCase().includes(needle) ||
				provider.api.toLowerCase().includes(needle),
		);
	}, [providerQuery, providers]);
	const filteredModels = useMemo(() => {
		if (!selectedProvider) return [];
		const needle = modelQuery.trim().toLowerCase();
		if (!needle) return selectedProvider.models;
		return selectedProvider.models.filter(
			(model) =>
				model.id.toLowerCase().includes(needle) ||
				model.name.toLowerCase().includes(needle) ||
				(model.api ?? selectedProvider.api).toLowerCase().includes(needle),
		);
	}, [modelQuery, selectedProvider]);

	const selectProvider = (id: string) => {
		setSelectedProviderId(id);
		setModelQuery("");
	};

	const toggleEnabled = async (provider: ProviderView) => {
		setEnabledPending(true);
		try {
			await gateway?.setProviderEnabled({ id: provider.id, enabled: !provider.enabled });
			pushToast("success", provider.enabled ? "提供商已停用" : "提供商已启用", provider.name);
		} catch (cause) {
			pushToast("error", "切换失败", cause instanceof Error ? cause.message : String(cause));
		} finally {
			setEnabledPending(false);
		}
	};

	const runConfirm = async () => {
		if (!confirm || !gateway) return;
		setConfirmPending(true);
		try {
			if (confirm.kind === "provider") {
				await gateway.deleteProvider({ id: confirm.providerId });
				pushToast("success", "提供商已删除", confirm.title);
				setSelectedProviderId(null);
			} else if (confirm.modelId) {
				await gateway.deleteModel({ providerId: confirm.providerId, modelId: confirm.modelId });
				pushToast("success", "模型已删除", confirm.title);
			}
			setConfirm(null);
		} catch (cause) {
			pushToast("error", "删除失败", cause instanceof Error ? cause.message : String(cause));
		} finally {
			setConfirmPending(false);
		}
	};

	if (!snapshot && status !== "gone") {
		return (
			<div className="gw-root">
				<div className="gw-skeleton" aria-busy="true" aria-label="正在读取网关配置">
					<div className="gw-skeleton-line" style={{ width: "24%" }} />
					<div className="gw-skeleton-line" style={{ width: "56%", height: 36 }} />
					<div className="gw-skeleton-line" style={{ width: "38%" }} />
					<div style={{ height: 28 }} />
					<div className="gw-skeleton-line" style={{ width: "72%" }} />
					<div className="gw-skeleton-line" style={{ width: "64%" }} />
				</div>
			</div>
		);
	}

	if (!snapshot) {
		return (
			<div className="gw-root">
				<div className="gw-gone">
					<strong>网关对象不可用</strong>
					<p>服务端切面已卸载，或浏览器与宿主的契约不再匹配。</p>
					<Button onClick={() => location.reload()}>刷新页面</Button>
				</div>
			</div>
		);
	}

	return (
		<div className="gw-root">
			<GatewayHeader
				snapshot={snapshot}
				selectedProviderId={selectedProvider?.id ?? null}
				onSelectProvider={selectProvider}
				colors={colors}
			/>
			<div className="gw-body">
				<aside className="gw-rail" aria-label="提供商">
					<div className="gw-rail-head">
						<div className="gw-rail-title">提供商</div>
						<div className="gw-rail-count">{providers.length}</div>
					</div>
					<div className="gw-search">
						<SearchIcon size={13} />
						<input
							className="gw-input"
							value={providerQuery}
							onChange={(event) => setProviderQuery(event.target.value)}
							placeholder="筛选提供商"
							aria-label="筛选提供商"
						/>
					</div>
					<div className="gw-provider-list">
						{filteredProviders.map((provider) => (
							<button
								key={provider.id}
								type="button"
								className="gw-provider"
								aria-current={provider.id === selectedProvider?.id ? "true" : undefined}
								data-disabled={!provider.enabled ? "true" : undefined}
								onClick={() => selectProvider(provider.id)}
							>
								<span
									className="gw-dot"
									data-muted={!provider.enabled ? "true" : undefined}
									style={{ "--c": colors.get(provider.id) ?? "#b6a4ff" } as CSSProperties}
								/>
								<span className="gw-provider-main">
									<span className="gw-provider-name">{provider.name}</span>
									<span className="gw-provider-meta">
										<span>{provider.api}</span>
										{!provider.hasKey && provider.authKind === "api-key" ? (
											<span className="gw-provider-alert">缺少密钥</span>
										) : null}
									</span>
								</span>
								<span className="gw-provider-count">{provider.models.length}</span>
							</button>
						))}
					</div>
					{providers.length === 0 ? (
						<div className="gw-rail-empty">
							还没有提供商。
							<br />
							从 pi-ai 内置目录挑一个，或连接自定义端点。
						</div>
					) : filteredProviders.length === 0 ? (
						<div className="gw-rail-empty">没有匹配的提供商。</div>
					) : null}
					<button type="button" className="gw-rail-add" onClick={() => setAddOpen(true)}>
						<PlusIcon size={12} /> 添加提供商
					</button>
					<StorageNote snapshot={snapshot} />
				</aside>

				<main className="gw-main">
					<div className="gw-main-inner">
						{selectedProvider ? (
							<ProviderDetail
								provider={selectedProvider}
								snapshot={snapshot}
								gateway={gateway!}
								tab={tab}
								onTab={setTab}
								modelQuery={modelQuery}
								onModelQuery={setModelQuery}
								models={filteredModels}
								onAddModel={() => setEditor({ model: null })}
								onEditModel={(model) => setEditor({ model })}
								onDeleteModel={(model) =>
									setConfirm({
										kind: "model",
										providerId: selectedProvider.id,
										modelId: model.id,
										title: model.name || model.id,
										detail: `从 ${selectedProvider.name} 删除模型 "${model.id}"？配置文件会立即更新。`,
									})
								}
								onDiscover={() => setDiscoveryOpen(true)}
								color={colors.get(selectedProvider.id) ?? "#b6a4ff"}
								onDeleteProvider={() =>
									setConfirm({
										kind: "provider",
										providerId: selectedProvider.id,
										title: selectedProvider.name,
										detail: `删除 ${selectedProvider.name} 及其 ${selectedProvider.models.length} 个模型？这会从服务端配置文件里移除它，无法撤销。`,
									})
								}
								enabledPending={enabledPending}
								onToggleEnabled={() => void toggleEnabled(selectedProvider)}
								onToast={pushToast}
							/>
						) : (
							<div className="gw-empty">
								<EmptyMark />
								<h3>先接一路上游</h3>
								<p>
									添加一个 pi-ai 内置提供商，或填写自定义 OpenAI 兼容端点。所有配置会写进插件的服务端文件，浏览器不保存任何业务数据。
								</p>
								<div className="gw-actions">
									<Button variant="signal" onClick={() => setAddOpen(true)}>
										<PlusIcon size={13} /> 添加提供商
									</Button>
								</div>
							</div>
						)}
					</div>
				</main>
			</div>

			<AddProviderModal
				open={addOpen}
				onClose={() => setAddOpen(false)}
				snapshot={snapshot}
				gateway={gateway!}
				onAdded={(provider) => {
					setSelectedProviderId(provider.id);
					setTab("models");
				}}
				onToast={pushToast}
			/>
			<DiscoveryDrawer
				open={discoveryOpen}
				provider={selectedProvider}
				gateway={gateway!}
				onClose={() => setDiscoveryOpen(false)}
				onImported={() => setTab("models")}
				onToast={pushToast}
			/>
			{selectedProvider && editor ? (
				<ModelEditor
					key={`${selectedProvider.id}:${editor.model?.id ?? "new"}`}
					open
					provider={selectedProvider}
					model={editor.model}
					snapshot={snapshot}
					gateway={gateway!}
					onClose={() => setEditor(null)}
					onSaved={() => setTab("models")}
					onToast={pushToast}
				/>
			) : null}

			<Modal
				open={confirm !== null}
				onClose={() => setConfirm(null)}
				title="确认删除"
				subtitle={confirm?.title}
				width={480}
				footer={
					<>
						<span className="gw-sheet-foot-note">立即写入服务端配置</span>
						<div className="gw-inline">
							<Button variant="ghost" onClick={() => setConfirm(null)} disabled={confirmPending}>
								取消
							</Button>
							<Button variant="danger" onClick={() => void runConfirm()} disabled={confirmPending}>
								{confirmPending ? "删除中…" : "删除"}
							</Button>
						</div>
					</>
				}
			>
				<Notice tone="error">{confirm?.detail}</Notice>
			</Modal>

			{toast ? (
				<Toast
					message={toast.message}
					tone={toast.tone}
					onClose={closeToast}
				/>
			) : null}
		</div>
	);
}

function ProviderDetail({
	provider,
	snapshot,
	gateway,
	tab,
	onTab,
	modelQuery,
	onModelQuery,
	models,
	onAddModel,
	onEditModel,
	onDeleteModel,
	onDiscover,
	onDeleteProvider,
	enabledPending,
	onToggleEnabled,
	onToast,
	color,
}: {
	provider: ProviderView;
	snapshot: GatewaySnapshot;
	gateway: Ref<typeof AiGateway>;
	color: string;
	tab: Tab;
	onTab: (tab: Tab) => void;
	modelQuery: string;
	onModelQuery: (value: string) => void;
	models: ModelConfig[];
	onAddModel: () => void;
	onEditModel: (model: ModelConfig) => void;
	onDeleteModel: (model: ModelConfig) => void;
	onDiscover: () => void;
	onDeleteProvider: () => void;
	enabledPending: boolean;
	onToggleEnabled: () => void;
	onToast: PushToast;
}) {
	const contextMax = Math.max(...provider.models.map((model) => model.contextWindow), 1);
	return (
		<>
			<div className="gw-accent" style={{ "--c": color } as CSSProperties} />
			<div className="gw-masthead">
				<div className="gw-masthead-copy">
					<h2 className="gw-masthead-name">{provider.name}</h2>
					<div className="gw-badges">
						<span className="gw-badge" data-tone={provider.enabled ? "jade" : "amber"}>
							<i /> {provider.enabled ? "已启用" : "已停用"}
						</span>
						<span className="gw-badge">{provider.source === "builtin" ? "内置" : "自定义"}</span>
						<span className="gw-badge">{authLabel(provider.authKind)}</span>
						{provider.hasKey ? (
							<span className="gw-badge" data-tone="violet">
								<i /> 密钥 {provider.keyHint}
							</span>
						) : (
							<span className="gw-badge" data-tone="amber">
								<i /> 未保存密钥
							</span>
						)}
					</div>
					<div className="gw-meta-grid">
						<span className="gw-meta">
							<span className="gw-meta-label">API</span>
							<code>{provider.api}</code>
						</span>
						<span className="gw-meta">
							<span className="gw-meta-label">Base URL</span>
							<code>{provider.baseUrl || "未设置"}</code>
						</span>
						<span className="gw-meta">
							<span className="gw-meta-label">最近保存</span>
							<code>{relativeTime(provider.updatedAt)}</code>
						</span>
					</div>
				</div>
				<div className="gw-actions">
					<Button variant="signal" onClick={onDiscover}>
						<RefreshIcon size={12} /> 拉取模型
					</Button>
					<Button variant="ghost" onClick={() => onTab("connection")}>
						<SettingsIcon size={12} /> 连接设置
					</Button>
					<button
						type="button"
						className="gw-icon-btn"
						data-tone="danger"
						aria-label="删除提供商"
						title="删除提供商"
						onClick={onDeleteProvider}
					>
						<TrashIcon />
					</button>
				</div>
			</div>

			<div className="gw-figures">
				<div className="gw-figure-cell">
					<div className="gw-figure-value">{provider.models.length}</div>
					<div className="gw-figure-label">已登记模型</div>
				</div>
				<div className="gw-figure-cell">
					<div className="gw-figure-value">{formatTokens(contextMax)}</div>
					<div className="gw-figure-label">最长上下文</div>
				</div>
				<div className="gw-figure-cell">
					<div className="gw-figure-value">{reasoningCount([provider])}</div>
					<div className="gw-figure-label">推理模型</div>
				</div>
				<div className="gw-figure-cell">
					<div className="gw-figure-value">{visionCount([provider])}</div>
					<div className="gw-figure-label">视觉输入</div>
				</div>
			</div>

			{!provider.enabled ? (
				<div className="gw-banner" style={{ marginTop: 16 }}>
					<AlertIcon size={13} /> 提供商已停用：模型仍然保留；取消停用后会恢复为可用提供商。
					<Button variant="ghost" small onClick={onToggleEnabled} disabled={enabledPending} style={{ marginLeft: "auto" }}>
						启用
					</Button>
				</div>
			) : null}

			<div className="gw-tabs" role="tablist" aria-label="提供商配置">
				<button type="button" role="tab" className="gw-tab" aria-selected={tab === "models"} onClick={() => onTab("models")}>
					模型<span>{provider.models.length}</span>
				</button>
				<button type="button" role="tab" className="gw-tab" aria-selected={tab === "connection"} onClick={() => onTab("connection")}>
					连接
				</button>
				<button type="button" role="tab" className="gw-tab" aria-selected={tab === "advanced"} onClick={() => onTab("advanced")}>
					高级
				</button>
				<div style={{ marginLeft: "auto", alignSelf: "center" }}>
					<Toggle checked={provider.enabled} onChange={() => onToggleEnabled()} label={provider.enabled ? "启用中" : "已停用"} />
				</div>
			</div>

			{tab === "models" ? (
				<>
					<div className="gw-toolbar">
						<div className="gw-search">
							<SearchIcon size={13} />
							<input
								className="gw-input"
								value={modelQuery}
								onChange={(event) => onModelQuery(event.target.value)}
								placeholder="按名称、ID 或 API 过滤模型"
								aria-label="过滤模型"
							/>
						</div>
						<Button variant="ghost" onClick={onAddModel}>
							<PlusIcon size={12} /> 添加模型
						</Button>
						<Button variant="ghost" onClick={onDiscover}>
							<RefreshIcon size={12} /> 从上游拉取
						</Button>
						<span className="gw-toolbar-count">
							显示 {models.length} / {provider.models.length}
						</span>
					</div>
					{provider.models.length === 0 ? (
						<div className="gw-empty">
							<EmptyMark />
							<h3>还没有模型</h3>
							<p>
								从上游拉取 {provider.name} 的模型目录，或手动添加一枚。模型参数会逐字段写进服务端配置。
							</p>
							<div className="gw-actions">
								<Button variant="signal" onClick={onDiscover}>
									<RefreshIcon size={12} /> 从上游拉取
								</Button>
								<Button variant="ghost" onClick={onAddModel}>
									<PlusIcon size={12} /> 手动添加
								</Button>
							</div>
						</div>
					) : models.length === 0 ? (
						<div className="gw-empty">
							<h3>没有匹配的模型</h3>
							<p>换个关键词，或者清空过滤条件。</p>
							<Button variant="ghost" onClick={() => onModelQuery("")}>
								清空过滤
							</Button>
						</div>
					) : (
						<div>
							<div className="gw-model-head">
								<span>模型</span>
								<span>输入</span>
								<span>上下文</span>
								<span>输出</span>
								<span>价格 / 1M</span>
								<span aria-hidden="true" />
							</div>
							{models.map((model) => (
								<div
									key={model.id}
									className="gw-model"
									role="button"
									tabIndex={0}
									onClick={() => onEditModel(model)}
									onKeyDown={(event) => {
										if (event.target !== event.currentTarget) return;
										if (event.key === "Enter" || event.key === " ") {
											event.preventDefault();
											onEditModel(model);
										}
									}}
								>
									<div className="gw-model-main">
										<div className="gw-model-name">{model.name}</div>
										<div className="gw-model-id">{model.id}</div>
									</div>
									<div className="gw-model-cell">
										<div className="gw-tags">
											{model.input.includes("image") ? <span className="gw-tag" data-tone="jade">视觉</span> : null}
											{model.reasoning ? <span className="gw-tag" data-tone="violet">推理</span> : null}
											{!model.input.includes("image") && !model.reasoning ? <span className="gw-tag">文本</span> : null}
										</div>
									</div>
									<div className="gw-model-cell">{formatTokens(model.contextWindow)}</div>
									<div className="gw-model-cell">{formatTokens(model.maxTokens)}</div>
									<div className="gw-model-cell gw-price">
										{formatCostPair(model.cost)} <small>USD</small>
									</div>
									<div className="gw-model-actions">
										<button
											type="button"
											className="gw-mini-btn"
											aria-label={`编辑 ${model.name}`}
											title="编辑"
											onClick={(event) => {
												event.stopPropagation();
												onEditModel(model);
											}}
										>
											<PencilIcon size={12} />
										</button>
										<button
											type="button"
											className="gw-mini-btn"
											data-tone="danger"
											aria-label={`删除 ${model.name}`}
											title="删除"
											onClick={(event) => {
												event.stopPropagation();
												onDeleteModel(model);
											}}
										>
											<TrashIcon size={12} />
										</button>
									</div>
								</div>
							))}
						</div>
					)}
				</>
			) : null}

			{tab === "connection" ? (
				<div style={{ paddingTop: 20 }}>
					<ProviderConnection key={provider.id} provider={provider} snapshot={snapshot} gateway={gateway} onToast={onToast} />
				</div>
			) : null}
			{tab === "advanced" ? (
				<div style={{ paddingTop: 20 }}>
					<ProviderAdvanced key={`${provider.id}:${snapshot.generatedAt}`} snapshot={snapshot} gateway={gateway} onToast={onToast} />
				</div>
			) : null}
		</>
	);
}
