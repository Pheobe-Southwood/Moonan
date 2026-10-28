import { useEffect, useMemo, useState } from "react";
import type { Ref } from "@moonan_ai/sdk";
import type { AiGateway } from "../contract.js";
import type {
	DiscoveredModel,
	DiscoveryResult,
	GatewaySettings,
	GatewaySnapshot,
	ProviderView,
} from "../schema.js";
import {
	Button,
	Drawer,
	Field,
	JsonField,
	KeyValueEditor,
	Modal,
	Notice,
	Section,
	Select,
	TextInput,
	Toggle,
} from "./controls.js";
import { RefreshIcon, SearchIcon } from "./icons.js";
import { authLabel, formatCostPair, formatTokens, isHttpUrl } from "./format.js";

export type GatewayRef = Ref<typeof AiGateway>;
export type ToastTone = "success" | "error" | "info";
export type PushToast = (tone: ToastTone, title: string, detail?: string) => void;

function numberText(value: number | undefined): string {
	return value === undefined ? "" : String(value);
}

function numberValue(text: string): number | undefined {
	if (text.trim() === "") return undefined;
	const value = Number(text);
	return Number.isFinite(value) ? value : undefined;
}

function slugify(value: string): string {
	return value
		.toLowerCase()
		.trim()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^[-_.]+|[-_.]+$/g, "")
		.slice(0, 64);
}

export function ProviderConnection({
	provider,
	snapshot,
	gateway,
	onToast,
}: {
	provider: ProviderView;
	snapshot: GatewaySnapshot;
	gateway: GatewayRef;
	onToast: PushToast;
}) {
	const [name, setName] = useState(provider.name);
	const [api, setApi] = useState(provider.api);
	const [baseUrl, setBaseUrl] = useState(provider.baseUrl);
	const [key, setKey] = useState("");
	const [headers, setHeaders] = useState<Record<string, string>>(() =>
		Object.fromEntries(Object.entries(provider.headers ?? {}).filter(([, value]) => value !== null)) as Record<string, string>,
	);
	const [env, setEnv] = useState<Record<string, string>>(provider.env ?? {});
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string>();

	const listId = `gw-apis-${provider.id}`;
	const oauth = provider.authKind !== "api-key";

	useEffect(() => {
		setName(provider.name);
		setApi(provider.api);
		setBaseUrl(provider.baseUrl);
		setHeaders(
			Object.fromEntries(Object.entries(provider.headers ?? {}).filter(([, value]) => value !== null)) as Record<string, string>,
		);
		setEnv(provider.env ?? {});
		setKey("");
	}, [provider.id]);

	const save = async (patch: { apiKey?: string } = {}) => {
		if (baseUrl.trim() && !isHttpUrl(baseUrl.trim())) {
			setError("Base URL 必须是 http:// 或 https:// 地址。");
			return;
		}
		if (!api.trim()) {
			setError("API 不能为空。");
			return;
		}
		setPending(true);
		setError(undefined);
		try {
			await gateway.saveProvider({
				id: provider.id,
				patch: {
					name: name.trim(),
					api: api.trim(),
					baseUrl: baseUrl.trim(),
					headers,
					env,
					...(patch.apiKey !== undefined ? { apiKey: patch.apiKey } : {}),
				},
			});
			setKey("");
			onToast("success", "连接已保存", "写入服务端配置文件。");
		} catch (cause) {
			const message = cause instanceof Error ? cause.message : String(cause);
			setError(message);
			onToast("error", "保存失败", message);
		} finally {
			setPending(false);
		}
	};

	const saveKey = async () => {
		if (!key.trim()) return;
		await save({ apiKey: key.trim() });
	};

	const clearKey = async () => {
		setPending(true);
		setError(undefined);
		try {
			await gateway.saveProvider({ id: provider.id, patch: { apiKey: "" } });
			setKey("");
			onToast("success", "密钥已清除", "提供商仍保留，但请求不再带密钥。");
		} catch (cause) {
			const message = cause instanceof Error ? cause.message : String(cause);
			setError(message);
			onToast("error", "清除失败", message);
		} finally {
			setPending(false);
		}
	};

	return (
		<div>
			{oauth ? (
				<Notice tone="info">
					这个内置提供商在 pi-ai 中支持 OAuth。面板只保存 API Key；OAuth 与环境凭据仍可由 pi-ai 自己读取。
				</Notice>
			) : null}
			{error ? <Notice tone="error">{error}</Notice> : null}

			<Section title="身份" note="显示名称只在面板里用。">
				<div className="gw-grid" data-cols="2">
					<Field label="显示名称" htmlFor={`gw-name-${provider.id}`}>
						<TextInput id={`gw-name-${provider.id}`} value={name} onChange={setName} placeholder="例如 OpenAI 工作区" />
					</Field>
					<Field
						label="API"
						htmlFor={`gw-api-${provider.id}`}
						help="决定请求经过 pi-ai 的哪个适配器。"
						hint={<code>api</code>}
					>
						<TextInput id={`gw-api-${provider.id}`} value={api} onChange={setApi} mono list={listId} />
						<datalist id={listId}>
							{snapshot.options.apis.map((option) => (
								<option key={option.id} value={option.id}>
									{option.label}
								</option>
							))}
						</datalist>
					</Field>
				</div>
				<Field
					label="Base URL"
					htmlFor={`gw-base-${provider.id}`}
					help="API 根地址，通常是 https://host/v1。自定义代理也填这里。"
					hint={<code>baseUrl</code>}
				>
					<TextInput
						id={`gw-base-${provider.id}`}
						value={baseUrl}
						onChange={setBaseUrl}
						mono
						type="url"
						placeholder="https://api.example.com/v1"
						invalid={baseUrl.trim() !== "" && !isHttpUrl(baseUrl.trim())}
					/>
				</Field>
			</Section>

			<Section title="密钥" note="服务端明文保存，文件权限 0600。">
				<div className="gw-inline" style={{ marginBottom: 12 }}>
					{provider.hasKey ? (
						<>
							<span className="gw-badge" data-tone="jade">
								<i /> 已保存
							</span>
							<span className="gw-hint" style={{ fontFamily: "var(--gw-mono)" }}>
								{provider.keyHint}
							</span>
							<Button variant="ghost" small onClick={() => void clearKey()} disabled={pending}>
								清除密钥
							</Button>
						</>
					) : (
						<span className="gw-badge" data-tone="amber">
							<i /> 缺少密钥
						</span>
					)}
				</div>
				<Field
					label={provider.hasKey ? "替换 API Key" : "API Key"}
					htmlFor={`gw-key-${provider.id}`}
					help={
						provider.hasKey
							? "留空表示保持现有密钥；填写后会立刻替换服务端保存的值。"
							: "密钥只写入服务端配置文件，浏览器不会收到已保存的明文。"
					}
					hint={<code>apiKey</code>}
				>
					<div className="gw-inline" style={{ alignItems: "stretch" }}>
						<div style={{ flex: 1, minWidth: 0 }}>
							<TextInput
								id={`gw-key-${provider.id}`}
								value={key}
								onChange={setKey}
								type="password"
								autoComplete="off"
								placeholder={provider.hasKey ? `已保存 ${provider.keyHint ?? ""}` : "sk-…"}
							/>
						</div>
						<Button onClick={() => void saveKey()} disabled={!key.trim() || pending}>
							替换密钥
						</Button>
					</div>
				</Field>
			</Section>

			<Section title="请求头与环境变量" note="可留空。">
				<Field label="请求头" help="Provider 级请求头。同名请求头会覆盖适配器的默认值。">
					<KeyValueEditor
						value={headers}
						onChange={setHeaders}
						keyPlaceholder="x-custom-header"
						valuePlaceholder="value"
						addLabel="添加请求头"
					/>
				</Field>
				<Field label="环境变量" help="Provider 级环境变量。适合区域、项目 ID 等非密钥配置；AWS / Vertex 也读这里。">
					<KeyValueEditor
						value={env}
						onChange={setEnv}
						keyPlaceholder="AWS_REGION"
						valuePlaceholder="us-east-1"
						addLabel="添加变量"
					/>
				</Field>
			</Section>

			<div className="gw-inline" style={{ marginTop: 20 }}>
				<Button variant="primary" onClick={() => void save()} disabled={pending}>
					{pending ? "保存中…" : "保存连接"}
				</Button>
			</div>
		</div>
	);
}

export function ProviderAdvanced({
	snapshot,
	gateway,
	onToast,
}: {
	snapshot: GatewaySnapshot;
	gateway: GatewayRef;
	onToast: PushToast;
}) {
	const [settings, setSettings] = useState<GatewaySettings>(() => structuredClone(snapshot.settings));
	const [temperature, setTemperature] = useState(numberText(snapshot.settings.requestDefaults.temperature));
	const [maxTokens, setMaxTokens] = useState(numberText(snapshot.settings.requestDefaults.maxTokens));
	const [timeout, setTimeoutText] = useState(numberText(snapshot.settings.requestDefaults.timeoutMs));
	const [maxRetries, setMaxRetries] = useState(numberText(snapshot.settings.requestDefaults.maxRetries));
	const [maxRetryDelay, setMaxRetryDelay] = useState(numberText(snapshot.settings.requestDefaults.maxRetryDelayMs));
	const [wsTimeout, setWsTimeout] = useState(numberText(snapshot.settings.requestDefaults.websocketConnectTimeoutMs));
	const [discoveryTimeout, setDiscoveryTimeout] = useState(numberText(snapshot.settings.discoveryTimeoutMs) || "20000");
	const [reasoning, setReasoning] = useState(snapshot.settings.requestDefaults.reasoning ?? "");
	const [budgetMinimal, setBudgetMinimal] = useState(numberText(snapshot.settings.requestDefaults.thinkingBudgets?.minimal));
	const [budgetLow, setBudgetLow] = useState(numberText(snapshot.settings.requestDefaults.thinkingBudgets?.low));
	const [budgetMedium, setBudgetMedium] = useState(numberText(snapshot.settings.requestDefaults.thinkingBudgets?.medium));
	const [budgetHigh, setBudgetHigh] = useState(numberText(snapshot.settings.requestDefaults.thinkingBudgets?.high));
	const [metadata, setMetadata] = useState<Record<string, unknown> | undefined>(
		snapshot.settings.requestDefaults.metadata,
	);
	const [sampling, setSampling] = useState<Record<string, unknown> | undefined>(
		snapshot.settings.requestDefaults.samplingParams,
	);
	const [pending, setPending] = useState(false);
	const [reloading, setReloading] = useState(false);
	const [error, setError] = useState<string>();
	const [metadataInvalid, setMetadataInvalid] = useState(false);
	const [samplingInvalid, setSamplingInvalid] = useState(false);

	const requestDefaults = snapshot.settings.requestDefaults;
	const defaults = { ...requestDefaults, ...settings.requestDefaults };

	const save = async () => {
		if (metadataInvalid || samplingInvalid) {
			setError("还有 JSON 字段没有解析成功。修正后再保存。");
			return;
		}
		setPending(true);
		setError(undefined);
		try {
			const requestDefaults: GatewaySettings["requestDefaults"] = {
				transport: defaults.transport,
				cacheRetention: defaults.cacheRetention,
				toolChoice: defaults.toolChoice,
				...(reasoning ? { reasoning: reasoning as GatewaySettings["requestDefaults"]["reasoning"] } : {}),
				...(budgetMinimal || budgetLow || budgetMedium || budgetHigh
					? {
						thinkingBudgets: {
							...(numberValue(budgetMinimal) ? { minimal: numberValue(budgetMinimal) } : {}),
							...(numberValue(budgetLow) ? { low: numberValue(budgetLow) } : {}),
							...(numberValue(budgetMedium) ? { medium: numberValue(budgetMedium) } : {}),
							...(numberValue(budgetHigh) ? { high: numberValue(budgetHigh) } : {}),
						},
					}
					: {}),
				deferred: defaults.deferred,
				temperature: numberValue(temperature),
				maxTokens: numberValue(maxTokens),
				timeoutMs: numberValue(timeout),
				maxRetries: numberValue(maxRetries),
				maxRetryDelayMs: numberValue(maxRetryDelay),
				websocketConnectTimeoutMs: numberValue(wsTimeout),
				...(metadata && Object.keys(metadata).length > 0 ? { metadata } : {}),
				...(sampling && Object.keys(sampling).length > 0 ? { samplingParams: sampling } : {}),
			};
			const next: GatewaySettings = {
				discoveryTimeoutMs: numberValue(discoveryTimeout) ?? 20_000,
				requestDefaults,
			};
			// JSON round-trip strips undefined so the server's strict schema sees only fields
			// the user actually set.
			await gateway.saveSettings({ settings: JSON.parse(JSON.stringify(next)) as GatewaySettings });
			onToast("success", "默认值已保存", "下一次请求会使用这些参数。");
		} catch (cause) {
			const message = cause instanceof Error ? cause.message : String(cause);
			setError(message);
			onToast("error", "保存失败", message);
		} finally {
			setPending(false);
		}
	};

	const reload = async () => {
		setReloading(true);
		setError(undefined);
		try {
			await gateway.reloadFromDisk();
			onToast("success", "已从磁盘重新加载", "内存状态已替换为文件内容。");
		} catch (cause) {
			const message = cause instanceof Error ? cause.message : String(cause);
			setError(message);
			onToast("error", "重新加载失败", message);
		} finally {
			setReloading(false);
		}
	};

	return (
		<div>
			{error ? <Notice tone="error">{error}</Notice> : null}
			<Section title="请求默认值" note="所有提供商共用；模型自己的采样参数优先。">
				<div className="gw-grid" data-cols="3">
					<Field label="temperature" hint={<code>0 – 2</code>}>
						<TextInput value={temperature} onChange={setTemperature} type="number" />
					</Field>
					<Field label="maxTokens" hint={<code>request</code>}>
						<TextInput value={maxTokens} onChange={setMaxTokens} type="number" />
					</Field>
					<Field label="transport" hint={<code>StreamOptions</code>}>
						<Select
							value={defaults.transport ?? "auto"}
							onChange={(value) =>
								setSettings({ ...settings, requestDefaults: { ...settings.requestDefaults, transport: value as GatewaySettings["requestDefaults"]["transport"] } })
							}
							options={snapshot.options.transports.map((value) => ({ value, label: value }))}
						/>
					</Field>
					<Field label="cacheRetention" hint={<code>prompt cache</code>}>
						<Select
							value={defaults.cacheRetention ?? "short"}
							onChange={(value) =>
								setSettings({
									...settings,
									requestDefaults: {
										...settings.requestDefaults,
										cacheRetention: value as GatewaySettings["requestDefaults"]["cacheRetention"],
									},
								})
							}
							options={snapshot.options.cacheRetentions.map((value) => ({ value, label: value }))}
						/>
					</Field>
					<Field label="timeoutMs" hint={<code>HTTP</code>}>
						<TextInput value={timeout} onChange={setTimeoutText} type="number" />
					</Field>
					<Field label="maxRetries" hint={<code>SDK</code>}>
						<TextInput value={maxRetries} onChange={setMaxRetries} type="number" />
					</Field>
					<Field label="maxRetryDelayMs" hint={<code>SDK</code>}>
						<TextInput value={maxRetryDelay} onChange={setMaxRetryDelay} type="number" />
					</Field>
					<Field label="websocketConnectTimeoutMs" hint={<code>WS</code>}>
						<TextInput value={wsTimeout} onChange={setWsTimeout} type="number" />
					</Field>
					<Field label="toolChoice" hint={<code>simple</code>}>
						<Select
							value={defaults.toolChoice ?? "auto"}
							onChange={(value) =>
								setSettings({
									...settings,
									requestDefaults: {
										...settings.requestDefaults,
										toolChoice: value as GatewaySettings["requestDefaults"]["toolChoice"],
									},
								})
							}
							options={snapshot.options.toolChoices.map((value) => ({ value, label: value }))}
						/>
					</Field>
				</div>
				<div className="gw-grid" data-cols="3" style={{ marginBottom: 6 }}>
					<Field label="reasoning" hint={<code>SimpleStreamOptions</code>}>
						<Select
							value={reasoning}
							onChange={setReasoning}
							options={[
								{ value: "", label: "未设置" },
								...(snapshot.options.thinkingLevels.filter((level) => level !== "off")).map((level) => ({
									value: level,
									label: level,
								})),
							]}
						/>
					</Field>
				</div>
				<div className="gw-grid" data-cols="4">
					<Field label="thinkingBudgets.minimal" hint={<code>tokens</code>}>
						<TextInput value={budgetMinimal} onChange={setBudgetMinimal} type="number" />
					</Field>
					<Field label="thinkingBudgets.low" hint={<code>tokens</code>}>
						<TextInput value={budgetLow} onChange={setBudgetLow} type="number" />
					</Field>
					<Field label="thinkingBudgets.medium" hint={<code>tokens</code>}>
						<TextInput value={budgetMedium} onChange={setBudgetMedium} type="number" />
					</Field>
					<Field label="thinkingBudgets.high" hint={<code>tokens</code>}>
						<TextInput value={budgetHigh} onChange={setBudgetHigh} type="number" />
					</Field>
				</div>
				<div className="gw-inline" style={{ marginBottom: 15 }}>
					<Toggle
						checked={Boolean(defaults.deferred)}
						onChange={(value) =>
							setSettings({ ...settings, requestDefaults: { ...settings.requestDefaults, deferred: value } })
						}
						label="默认请求 deferred response"
					/>
				</div>
				<div className="gw-grid" data-cols="2">
					<JsonField
						key={`metadata-${snapshot.generatedAt}`}
						label="metadata"
						value={metadata}
						onValidity={setMetadataInvalid}
						onChange={(value) => setMetadata(value as Record<string, unknown> | undefined)}
						placeholder='{ "user_id": "local" }'
					/>
					<JsonField
						key={`sampling-${snapshot.generatedAt}`}
						label="samplingParams"
						value={sampling}
						onValidity={setSamplingInvalid}
						onChange={(value) => setSampling(value as Record<string, unknown> | undefined)}
						placeholder='{ "top_p": 0.9, "top_k": 40 }'
					/>
				</div>
			</Section>

			<Section title="发现" note="只影响模型列表请求。">
				<Field label="拉取超时（毫秒）" help="从上游读取模型列表时使用；默认 20000。" hint={<code>discoveryTimeoutMs</code>}>
					<TextInput value={discoveryTimeout} onChange={setDiscoveryTimeout} type="number" />
				</Field>
			</Section>

			<div className="gw-inline" style={{ marginTop: 20 }}>
				<Button variant="primary" onClick={() => void save()} disabled={pending}>
					{pending ? "保存中…" : "保存默认值"}
				</Button>
			</div>

			<Section title="服务端文件" note="这里的值不经过浏览器存储。">
				<div className="gw-notice" data-tone="info" style={{ display: "grid", gap: 4 }}>
					<div>
						<span className="gw-hint">配置文件</span>
						<div style={{ fontFamily: "var(--gw-mono)", fontSize: 10.5, overflowWrap: "anywhere" }}>
							{snapshot.storage.configPath}
						</div>
					</div>
					<div>
						<span className="gw-hint">备份</span>
						<div style={{ fontFamily: "var(--gw-mono)", fontSize: 10.5, overflowWrap: "anywhere" }}>
							{snapshot.storage.backupPath}
						</div>
					</div>
					<div className="gw-hint">
						{snapshot.storage.exists ? "文件已存在" : "文件尚未创建"} · 权限 {snapshot.storage.mode ?? "—"} ·
						{snapshot.storage.writable ? " 可写" : " 目录不可写"} · 最近保存 {snapshot.storage.lastSavedAt ?? "—"}
					</div>
					{snapshot.storage.notice ? <div className="gw-error">{snapshot.storage.notice}</div> : null}
				</div>
				<div className="gw-inline" style={{ marginTop: 12 }}>
					<Button variant="ghost" onClick={() => void reload()} disabled={reloading}>
						<RefreshIcon size={12} /> {reloading ? "重新加载中…" : "从磁盘重新加载"}
					</Button>
				</div>
			</Section>
		</div>
	);
}

export function AddProviderModal({
	open,
	onClose,
	snapshot,
	gateway,
	onAdded,
	onToast,
}: {
	open: boolean;
	onClose: () => void;
	snapshot: GatewaySnapshot;
	gateway: GatewayRef;
	onAdded: (provider: ProviderView) => void;
	onToast: PushToast;
}) {
	const [tab, setTab] = useState<"builtin" | "custom">("builtin");
	const [query, setQuery] = useState("");
	const [pending, setPending] = useState<string>();
	const [error, setError] = useState<string>();
	const [name, setName] = useState("");
	const [id, setId] = useState("");
	const [customApi, setCustomApi] = useState("openai-completions");
	const [baseUrl, setBaseUrl] = useState("");
	const [key, setKey] = useState("");
	const [idTouched, setIdTouched] = useState(false);

	useEffect(() => {
		if (!open) return;
		setTab("builtin");
		setQuery("");
		setError(undefined);
		setPending(undefined);
		setName("");
		setId("");
		setCustomApi("openai-completions");
		setBaseUrl("");
		setKey("");
		setIdTouched(false);
	}, [open]);

	const added = useMemo(() => new Set(snapshot.providers.map((provider) => provider.id)), [snapshot.providers]);
	const filtered = useMemo(() => {
		const needle = query.trim().toLowerCase();
		if (!needle) return snapshot.presets;
		return snapshot.presets.filter(
			(preset) => preset.name.toLowerCase().includes(needle) || preset.id.toLowerCase().includes(needle),
		);
	}, [query, snapshot.presets]);

	const addBuiltin = async (presetId: string) => {
		setPending(presetId);
		setError(undefined);
		try {
			const provider = await gateway.addBuiltinProvider({ presetId });
			onToast("success", "提供商已添加", `已导入 ${provider.models.length} 个模型。`);
			onAdded(provider);
			onClose();
		} catch (cause) {
			const message = cause instanceof Error ? cause.message : String(cause);
			setError(message);
			onToast("error", "添加失败", message);
		} finally {
			setPending(undefined);
		}
	};

	const addCustom = async () => {
		setPending("custom");
		setError(undefined);
		try {
			const provider = await gateway.addProvider({
				id: id.trim(),
				name: name.trim() || id.trim(),
				api: customApi.trim(),
				baseUrl: baseUrl.trim(),
				...(key.trim() ? { apiKey: key.trim() } : {}),
			});
			onToast("success", "提供商已添加", "现在可以从上游拉取模型了。");
			onAdded(provider);
			onClose();
		} catch (cause) {
			const message = cause instanceof Error ? cause.message : String(cause);
			setError(message);
			onToast("error", "添加失败", message);
		} finally {
			setPending(undefined);
		}
	};

	const listId = "gw-custom-apis";

	return (
		<Modal
			open={open}
			onClose={onClose}
			title="添加提供商"
			subtitle="从 pi-ai 的内置目录开始，或连接一个自定义端点。"
			width={800}
		>
			<div className="gw-inline" style={{ justifyContent: "space-between", marginBottom: 14 }}>
				<div className="gw-segment" role="group" aria-label="添加方式">
					<button type="button" aria-pressed={tab === "builtin"} onClick={() => setTab("builtin")}>
						内置目录
					</button>
					<button type="button" aria-pressed={tab === "custom"} onClick={() => setTab("custom")}>
						自定义
					</button>
				</div>
				<span className="gw-hint">pi-ai 1.4.0 / {snapshot.presets.length} 个提供商</span>
			</div>
			{error ? <Notice tone="error">{error}</Notice> : null}

			{tab === "builtin" ? (
				<>
					<div className="gw-search" style={{ marginBottom: 10 }}>
						<SearchIcon size={13} />
						<input
							className="gw-input"
							value={query}
							onChange={(event) => setQuery(event.target.value)}
							placeholder="搜索提供商或 ID"
							aria-label="搜索内置提供商"
						/>
					</div>
					<div className="gw-preset-list">
						{filtered.map((preset) => {
							const exists = added.has(preset.id);
							return (
								<button
									key={preset.id}
									type="button"
									className="gw-preset"
									disabled={exists || pending !== undefined}
									onClick={() => void addBuiltin(preset.id)}
								>
									<div style={{ minWidth: 0 }}>
										<div className="gw-preset-name">{preset.name}</div>
										<div className="gw-preset-id">{preset.id}</div>
									</div>
									<div className="gw-preset-meta">
										<b>{preset.modelCount}</b>
										模型
									</div>
									<div className="gw-preset-meta">{authLabel(preset.authKind)}</div>
									<span className="gw-preset-add gw-badge" data-tone={exists ? "jade" : undefined}>
										{exists ? "已添加" : pending === preset.id ? "导入中…" : "添加"}
									</span>
								</button>
							);
						})}
					</div>
					{filtered.length === 0 ? <div className="gw-hint" style={{ padding: "16px 4px" }}>没有匹配的提供商。</div> : null}
					<div className="gw-hint" style={{ marginTop: 12 }}>
						 添加内置提供商会导入该提供商的全部对话模型。之后可以逐个编辑参数、删除不需要的模型。
					</div>
				</>
			) : (
				<>
					<div className="gw-grid" data-cols="2">
						<Field label="显示名称" htmlFor="gw-add-name">
							<TextInput
								id="gw-add-name"
								value={name}
								onChange={(value) => {
									setName(value);
									if (!idTouched) setId(slugify(value));
								}}
								placeholder="我的网关"
							/>
						</Field>
						<Field label="提供商 ID" htmlFor="gw-add-id" help="用于地址与日志，创建后不建议修改。" hint={<code>id</code>}>
							<TextInput
								id="gw-add-id"
								value={id}
								onChange={(value) => {
									setId(value);
									setIdTouched(true);
								}}
								mono
								placeholder="my-gateway"
							/>
						</Field>
					</div>
					<div className="gw-grid" data-cols="2">
						<Field label="API" htmlFor="gw-add-api" hint={<code>api</code>}>
							<TextInput id="gw-add-api" value={customApi} onChange={setCustomApi} mono list={listId} />
							<datalist id={listId}>
								{snapshot.options.apis.map((option) => (
									<option key={option.id} value={option.id}>
										{option.label}
									</option>
								))}
							</datalist>
						</Field>
						<Field label="Base URL" htmlFor="gw-add-base" hint={<code>baseUrl</code>}>
							<TextInput
								id="gw-add-base"
								value={baseUrl}
								onChange={setBaseUrl}
								mono
								type="url"
								placeholder="http://127.0.0.1:11434/v1"
							/>
						</Field>
					</div>
					<Field label="API Key" htmlFor="gw-add-key" help="可留空，适用于本机无鉴权端点。" hint={<code>apiKey</code>}>
						<TextInput
							id="gw-add-key"
							value={key}
							onChange={setKey}
							type="password"
							autoComplete="off"
							placeholder="sk-…"
						/>
					</Field>
					<div className="gw-inline" style={{ justifyContent: "flex-end" }}>
						<Button variant="ghost" onClick={onClose}>
							取消
						</Button>
						<Button
							variant="primary"
							onClick={() => void addCustom()}
							disabled={!id.trim() || !customApi.trim() || pending !== undefined}
						>
							{pending === "custom" ? "创建中…" : "添加自定义提供商"}
						</Button>
					</div>
				</>
			)}
		</Modal>
	);
}

export function DiscoveryDrawer({
	open,
	provider,
	gateway,
	onClose,
	onImported,
	onToast,
}: {
	open: boolean;
	provider: ProviderView | null;
	gateway: GatewayRef;
	onClose: () => void;
	onImported: (result: { added: number; skipped: number; replaced: number; total: number }) => void;
	onToast: PushToast;
}) {
	const [loading, setLoading] = useState(false);
	const [result, setResult] = useState<DiscoveryResult>();
	const [error, setError] = useState<string>();
	const [query, setQuery] = useState("");
	const [selected, setSelected] = useState<Set<string>>(new Set());
	const [mode, setMode] = useState<"skip" | "replace">("skip");
	const [importing, setImporting] = useState(false);

	const run = async () => {
		if (!provider) return;
		setLoading(true);
		setError(undefined);
		setResult(undefined);
		setQuery("");
		try {
			const next = await gateway.discoverModels({ id: provider.id });
			setResult(next);
			setSelected(new Set(next.models.filter((model) => !model.alreadyConfigured).map((model) => model.id)));
		} catch (cause) {
			const message = cause instanceof Error ? cause.message : String(cause);
			setError(message);
			onToast("error", "拉取失败", message);
		} finally {
			setLoading(false);
		}
	};

	useEffect(() => {
		if (!open || !provider) return;
		void run();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open, provider?.id]);

	const filtered = useMemo(() => {
		if (!result) return [];
		const needle = query.trim().toLowerCase();
		if (!needle) return result.models;
		return result.models.filter(
			(model) => model.id.toLowerCase().includes(needle) || model.name.toLowerCase().includes(needle),
		);
	}, [query, result]);

	const importNow = async () => {
		if (!provider || !result) return;
		setImporting(true);
		setError(undefined);
		try {
			const models: DiscoveredModel[] = result.models
				.filter((model) => selected.has(model.id))
				.map(({ alreadyConfigured: _already, ...model }) => model);
			const imported = await gateway.importModels({ providerId: provider.id, models, mode });
			onToast(
				"success",
				"模型已导入",
				`新增 ${imported.added}，覆盖 ${imported.replaced}，跳过 ${imported.skipped}。`,
			);
			onImported(imported);
			onClose();
		} catch (cause) {
			const message = cause instanceof Error ? cause.message : String(cause);
			setError(message);
			onToast("error", "导入失败", message);
		} finally {
			setImporting(false);
		}
	};

	const newModels = result ? result.models.filter((model) => !model.alreadyConfigured) : [];
	const allSelected = newModels.length > 0 && newModels.every((model) => selected.has(model.id));

	return (
		<Drawer
			open={open}
			onClose={onClose}
			width={720}
			kicker="上游模型目录"
			title={provider ? `从 ${provider.name} 拉取` : "拉取模型"}
			subtitle={provider?.baseUrl || "—"}
			footer={
				result && !loading && !error ? (
					<>
						<span className="gw-sheet-foot-note">已选 {selected.size} 个模型</span>
						<div className="gw-inline">
							<Select
								value={mode}
								onChange={(value) => setMode(value as "skip" | "replace")}
								options={[
									{ value: "skip", label: "跳过同名模型" },
									{ value: "replace", label: "覆盖同名模型" },
								]}
							/>
							<Button variant="signal" onClick={() => void importNow()} disabled={selected.size === 0 || importing}>
								{importing ? "导入中…" : `导入 ${selected.size} 个模型`}
							</Button>
						</div>
					</>
				) : undefined
			}
		>
			{loading ? (
				<div className="gw-scanning">
					<div className="gw-scan-line" />
					<strong>正在读取上游模型目录</strong>
					<span>请求 {provider?.baseUrl || "提供商端点"} 的模型列表。密钥只在服务端使用。</span>
				</div>
			) : error ? (
				<>
					<Notice tone="error">{error}</Notice>
					<div className="gw-inline" style={{ marginTop: 14 }}>
						<Button variant="primary" onClick={() => void run()}>
							<RefreshIcon size={12} /> 重试
						</Button>
					</div>
				</>
			) : result ? (
				<>
					<div className="gw-inline" style={{ justifyContent: "space-between", marginBottom: 10 }}>
						<div>
							<span className="gw-badge" data-tone={result.source === "catalog" ? "amber" : "jade"}>
								<i /> {result.source === "catalog" ? "内置目录" : "上游实时"}
							</span>
							<span className="gw-hint" style={{ marginLeft: 8 }}>
								{result.models.length} 个可导入，{newModels.length} 个新增
							</span>
						</div>
						<Button variant="ghost" small onClick={() => void run()}>
							<RefreshIcon size={11} /> 重新拉取
						</Button>
					</div>
					{result.warnings.length > 0 ? (
						<Notice tone="info">
							{result.warnings.map((warning) => (
								<div key={warning}>{warning}</div>
							))}
						</Notice>
					) : null}
					<div className="gw-inline" style={{ justifyContent: "space-between", margin: "12px 0 6px" }}>
						<label className="gw-check">
							<input
								type="checkbox"
								checked={allSelected}
								onChange={(event) =>
									setSelected(
										event.target.checked ? new Set(newModels.map((model) => model.id)) : new Set(),
									)
								}
							/>
							<span>全选新增</span>
						</label>
						<span className="gw-hint">已选 {selected.size} 个</span>
					</div>
					<div className="gw-search" style={{ marginBottom: 8 }}>
						<SearchIcon size={13} />
						<input
							className="gw-input"
							value={query}
							onChange={(event) => setQuery(event.target.value)}
							placeholder="按模型名或 ID 过滤"
							aria-label="过滤拉取到的模型"
						/>
					</div>
					<div className="gw-discover-list">
						{filtered.map((model) => (
							<label
								key={model.id}
								className="gw-discover"
								data-existing={model.alreadyConfigured ? "true" : undefined}
							>
								<input
									type="checkbox"
									disabled={model.alreadyConfigured}
									checked={model.alreadyConfigured || selected.has(model.id)}
									onChange={(event) => {
										const next = new Set(selected);
										if (event.target.checked) next.add(model.id);
										else next.delete(model.id);
										setSelected(next);
									}}
								/>
								<div style={{ minWidth: 0 }}>
									<div className="gw-discover-name">
										{model.name}
										{model.reasoning ? <span className="gw-tag" data-tone="violet" style={{ marginLeft: 5 }}>推理</span> : null}
										{model.input?.includes("image") ? <span className="gw-tag" data-tone="jade" style={{ marginLeft: 3 }}>视觉</span> : null}
									</div>
									<div className="gw-discover-id">{model.id}</div>
								</div>
								<div className="gw-discover-meta">{formatTokens(model.contextWindow)} ctx</div>
								<div className="gw-discover-meta">{formatTokens(model.maxTokens)} out</div>
								<div className={model.alreadyConfigured ? "gw-discover-status" : "gw-discover-meta"}>
									{model.alreadyConfigured ? "已存在" : model.cost ? formatCostPair(model.cost) : "—"}
								</div>
							</label>
						))}
					</div>
					{filtered.length === 0 ? <div className="gw-hint" style={{ padding: "16px 4px" }}>没有匹配的模型。</div> : null}
					<div className="gw-hint" style={{ padding: "12px 2px 0" }}>
						已选 {selected.size} 个。导入会立刻写入服务端配置。
					</div>
				</>
			) : null}
		</Drawer>
	);
}

