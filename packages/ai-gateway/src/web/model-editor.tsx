import { useMemo, useState } from "react";
import type { Ref } from "@moonan_ai/sdk";
import type { AiGateway } from "../contract.js";
import { THINKING_LEVELS, type CompatField, type GatewaySnapshot, type ModelConfig, type ProviderView } from "../schema.js";
import {
	Button,
	Checkbox,
	Drawer,
	Field,
	JsonField,
	KeyValueEditor,
	Notice,
	Section,
	Select,
	TextInput,
	Toggle,
} from "./controls.js";
import { formatCostPair, isHttpUrl } from "./format.js";
import type { PushToast } from "./provider-panels.js";

type GatewayRef = Ref<typeof AiGateway>;

const ZERO_COST: ModelConfig["cost"] = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const LEVEL_LABELS: Record<string, string> = {
	off: "off · 关闭",
	minimal: "minimal · 最少",
	low: "low · 低",
	medium: "medium · 中",
	high: "high · 高",
	xhigh: "xhigh · 极高",
	max: "max · 最大",
};

function newModel(provider: ProviderView): ModelConfig {
	return {
		id: "",
		name: "",
		api: provider.api,
		type: "chat",
		input: ["text"],
		cost: { ...ZERO_COST },
		contextWindow: 128_000,
		maxTokens: 8_192,
		reasoning: false,
	};
}

function optionalNumber(text: string): number | undefined {
	if (text.trim() === "") return undefined;
	const value = Number(text);
	return Number.isFinite(value) ? value : undefined;
}

function numberText(value: number | undefined): string {
	return value === undefined ? "" : String(value);
}

function cleanOptional<T extends Record<string, unknown>>(value: T | undefined): T | undefined {
	if (!value) return undefined;
	const entries = Object.entries(value).filter(([, entry]) => entry !== undefined && entry !== "");
	if (entries.length === 0) return undefined;
	return Object.fromEntries(entries) as T;
}

export function ModelEditor({
	open,
	provider,
	model,
	snapshot,
	gateway,
	onClose,
	onSaved,
	onToast,
}: {
	open: boolean;
	provider: ProviderView;
	model: ModelConfig | null;
	snapshot: GatewaySnapshot;
	gateway: GatewayRef;
	onClose: () => void;
	onSaved: (model: ModelConfig) => void;
	onToast: PushToast;
}) {
	const [draft, setDraft] = useState<ModelConfig>(() => (model ? structuredClone(model) : newModel(provider)));
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string>();
	const [invalidJson, setInvalidJson] = useState<Set<string>>(new Set());
	const [headers, setHeaders] = useState<Record<string, string>>(() => model?.headers ?? {});

	const api = draft.api ?? provider.api;
	const compatFields = useMemo(
		() => snapshot.options.apis.find((option) => option.id === api)?.compatFields ?? [],
		[api, snapshot.options.apis],
	);

	const patch = (next: Partial<ModelConfig>) => setDraft((current) => ({ ...current, ...next }));
	const setJsonValidity = (key: string, valid: boolean) => {
		setInvalidJson((current) => {
			const next = new Set(current);
			if (valid) next.delete(key);
			else next.add(key);
			return next;
		});
	};
	const setCompat = (key: string, value: unknown) => {
		const next = { ...(draft.compat ?? {}) };
		if (value === undefined) delete next[key];
		else next[key] = value as never;
		patch({ compat: Object.keys(next).length > 0 ? next : undefined });
	};

	const save = async () => {
		setError(undefined);
		if (invalidJson.size > 0) {
			setError("还有 JSON 字段没有解析成功。修正后再保存。");
			return;
		}
		const id = draft.id.trim();
		const contextWindow = Math.trunc(draft.contextWindow);
		const maxTokens = Math.trunc(draft.maxTokens);
		if (!id) {
			setError("模型 ID 不能为空。");
			return;
		}
		if (!Number.isFinite(contextWindow) || contextWindow < 1) {
			setError("上下文窗口必须是正整数。");
			return;
		}
		if (!Number.isFinite(maxTokens) || maxTokens < 1) {
			setError("最大输出 token 必须是正整数。");
			return;
		}
		if (draft.baseUrl?.trim() && !isHttpUrl(draft.baseUrl.trim())) {
			setError("Base URL 覆盖必须是 http:// 或 https:// 地址。");
			return;
		}
		const input = draft.input.includes("text") ? draft.input : (["text", ...draft.input] as ModelConfig["input"]);
		const next: ModelConfig = {
			...draft,
			id,
			name: draft.name.trim() || id,
			api: draft.api?.trim() || undefined,
			baseUrl: draft.baseUrl?.trim() || undefined,
			type: "chat",
			input: [...new Set(input)],
			cost: {
				input: Math.max(0, draft.cost.input),
				output: Math.max(0, draft.cost.output),
				cacheRead: Math.max(0, draft.cost.cacheRead),
				cacheWrite: Math.max(0, draft.cost.cacheWrite),
				...(draft.cost.tiers && draft.cost.tiers.length > 0 ? { tiers: draft.cost.tiers } : {}),
			},
			contextWindow,
			maxTokens,
			thinkingLevelMap: cleanOptional(draft.thinkingLevelMap),
			promptCache: cleanOptional(draft.promptCache),
			samplingParams: cleanOptional(draft.samplingParams),
			samplingParamsByThinkingLevel: cleanOptional(draft.samplingParamsByThinkingLevel),
			compat: cleanOptional(draft.compat),
			headers: Object.keys(headers).length > 0 ? headers : undefined,
			createdAt: model?.createdAt,
			updatedAt: model?.updatedAt,
		};
		setPending(true);
		try {
			const saved = await gateway.saveModel({
				providerId: provider.id,
				model: JSON.parse(JSON.stringify(next)) as ModelConfig,
				...(model ? { previousId: model.id } : {}),
			});
			onToast("success", model ? "模型已保存" : "模型已添加", saved.id);
			onSaved(saved);
			onClose();
		} catch (cause) {
			const message = cause instanceof Error ? cause.message : String(cause);
			setError(message);
			onToast("error", "保存失败", message);
		} finally {
			setPending(false);
		}
	};

	const contextWindow = numberText(draft.contextWindow);
	const maxTokens = numberText(draft.maxTokens);
	return (
		<Drawer
			open={open}
			onClose={onClose}
			width={620}
			kicker="模型参数"
			title={model ? model.name || model.id : "新建模型"}
			subtitle={`${provider.name} · ${api}`}
			footer={
				<>
					<div className="gw-sheet-foot-note">
						{draft.input.includes("image") ? "视觉输入" : "纯文本"}；上下文 {draft.contextWindow.toLocaleString()}；输出{" "}
						{draft.maxTokens.toLocaleString()}；{formatCostPair(draft.cost)} / 1M
					</div>
					<div className="gw-inline">
						<Button variant="ghost" onClick={onClose} disabled={pending}>
							取消
						</Button>
						<Button variant="primary" onClick={() => void save()} disabled={pending}>
							{pending ? "保存中…" : "保存模型"}
						</Button>
					</div>
				</>
			}
		>
			{error ? <Notice tone="error">{error}</Notice> : null}

			<Section title="身份" note="模型 ID 是上游真正使用的字符串。">
				<Field label="模型 ID" htmlFor="gw-model-id" help="请求时发送的 model 字段；必须与上游一致。" hint={<code>id</code>}>
					<TextInput id="gw-model-id" value={draft.id} onChange={(id) => patch({ id })} mono placeholder="gpt-5.4" />
				</Field>
				<Field label="显示名称" htmlFor="gw-model-name" hint={<code>name</code>}>
					<TextInput
						id="gw-model-name"
						value={draft.name}
						onChange={(name) => patch({ name })}
						placeholder="留空则使用模型 ID"
					/>
				</Field>
				<div className="gw-grid" data-cols="2">
					<Field label="API" htmlFor="gw-model-api" help="留空时跟随提供商的 API。" hint={<code>api</code>}>
						<TextInput
							id="gw-model-api"
							value={draft.api ?? ""}
							onChange={(value) => patch({ api: value })}
							mono
							list="gw-model-api-options"
						/>
						<datalist id="gw-model-api-options">
							{snapshot.options.apis.map((option) => (
								<option key={option.id} value={option.id}>
									{option.label}
								</option>
							))}
						</datalist>
					</Field>
					<Field label="Base URL 覆盖" htmlFor="gw-model-base" help="留空时使用提供商的 Base URL。" hint={<code>baseUrl</code>}>
						<TextInput
							id="gw-model-base"
							value={draft.baseUrl ?? ""}
							onChange={(value) => patch({ baseUrl: value })}
							mono
							placeholder={provider.baseUrl || "跟随提供商"}
						/>
					</Field>
				</div>
			</Section>

			<Section title="能力" note="这些字段直接填进 pi-ai 的 Model。" lede="输入模态决定消息里能不能带图片；reasoning 打开后，思考等级才有意义。">
				<div className="gw-inline" style={{ marginBottom: 14 }}>
					<Checkbox
						checked={draft.input.includes("text")}
						onChange={() => undefined}
						label="text（必选）"
						disabled
					/>
					<Checkbox
						checked={draft.input.includes("image")}
						onChange={(checked) =>
							patch({
								input: checked
									? [...new Set([...draft.input, "image"] as ModelConfig["input"])]
									: draft.input.filter((value) => value !== "image"),
							})
						}
						label="image · 视觉输入"
					/>
				</div>
				<Toggle checked={draft.reasoning} onChange={(reasoning) => patch({ reasoning })} label="支持 reasoning / thinking" />
				<div className="gw-grid" data-cols="2" style={{ marginTop: 12 }}>
					<Field label="contextWindow" htmlFor="gw-context" help="最大上下文 token 数。" hint={<code>contextWindow</code>}>
						<TextInput
							id="gw-context"
							value={contextWindow}
							onChange={(value) => patch({ contextWindow: optionalNumber(value) ?? 0 })}
							type="number"
						/>
					</Field>
					<Field label="maxTokens" htmlFor="gw-max-tokens" help="单次回复的最大输出 token。" hint={<code>maxTokens</code>}>
						<TextInput
							id="gw-max-tokens"
							value={maxTokens}
							onChange={(value) => patch({ maxTokens: optionalNumber(value) ?? 0 })}
							type="number"
						/>
					</Field>
					<Field label="promptCache.short" htmlFor="gw-cache-short" help="短缓存寿命（秒）。" hint={<code>promptCache</code>}>
						<TextInput
							id="gw-cache-short"
							value={numberText(draft.promptCache?.short)}
							onChange={(value) =>
								patch({
									promptCache: cleanOptional({
										...(draft.promptCache ?? {}),
										short: optionalNumber(value),
									}),
								})
							}
							type="number"
						/>
					</Field>
					<Field label="promptCache.long" htmlFor="gw-cache-long" help="长缓存寿命（秒）。" hint={<code>promptCache</code>}>
						<TextInput
							id="gw-cache-long"
							value={numberText(draft.promptCache?.long)}
							onChange={(value) =>
								patch({
									promptCache: cleanOptional({
										...(draft.promptCache ?? {}),
										long: optionalNumber(value),
									}),
								})
							}
							type="number"
						/>
					</Field>
				</div>
			</Section>

			<Section title="价格" note="USD / 百万 token" lede="pi-ai 用这些数字计算 usage.cost。缓存价按 cacheRead / cacheWrite 计。">
				<div className="gw-grid" data-cols="4">
					<Field label="input" hint={<code>cost</code>}>
						<TextInput
							value={String(draft.cost.input)}
							onChange={(value) => patch({ cost: { ...draft.cost, input: optionalNumber(value) ?? 0 } })}
							type="number"
						/>
					</Field>
					<Field label="output" hint={<code>cost</code>}>
						<TextInput
							value={String(draft.cost.output)}
							onChange={(value) => patch({ cost: { ...draft.cost, output: optionalNumber(value) ?? 0 } })}
							type="number"
						/>
					</Field>
					<Field label="cacheRead" hint={<code>cost</code>}>
						<TextInput
							value={String(draft.cost.cacheRead)}
							onChange={(value) => patch({ cost: { ...draft.cost, cacheRead: optionalNumber(value) ?? 0 } })}
							type="number"
						/>
					</Field>
					<Field label="cacheWrite" hint={<code>cost</code>}>
						<TextInput
							value={String(draft.cost.cacheWrite)}
							onChange={(value) => patch({ cost: { ...draft.cost, cacheWrite: optionalNumber(value) ?? 0 } })}
							type="number"
						/>
					</Field>
				</div>
				<div className="gw-inline" style={{ justifyContent: "space-between", marginTop: 4 }}>
					<span className="gw-hint">阶梯价格（可选）：超过 inputTokensAbove 后改用下一档。</span>
					<Button
						variant="ghost"
						small
						onClick={() =>
							patch({
								cost: {
									...draft.cost,
									tiers: [
										...(draft.cost.tiers ?? []),
										{ ...ZERO_COST, inputTokensAbove: 0 },
									],
								},
							})
						}
					>
						+ 添加阶梯
					</Button>
				</div>
				{(draft.cost.tiers ?? []).map((tier, index) => (
					<div key={index} className="gw-grid" data-cols="5" style={{ marginTop: 8, alignItems: "end" }}>
						<Field label="inputTokensAbove">
							<TextInput
								value={String(tier.inputTokensAbove)}
								onChange={(value) => {
									const tiers = (draft.cost.tiers ?? []).slice();
									tiers[index] = { ...tier, inputTokensAbove: optionalNumber(value) ?? 0 };
									patch({ cost: { ...draft.cost, tiers } });
								}}
								type="number"
							/>
						</Field>
						<Field label="input">
							<TextInput
								value={String(tier.input)}
								onChange={(value) => {
									const tiers = (draft.cost.tiers ?? []).slice();
									tiers[index] = { ...tier, input: optionalNumber(value) ?? 0 };
									patch({ cost: { ...draft.cost, tiers } });
								}}
								type="number"
							/>
						</Field>
						<Field label="output">
							<TextInput
								value={String(tier.output)}
								onChange={(value) => {
									const tiers = (draft.cost.tiers ?? []).slice();
									tiers[index] = { ...tier, output: optionalNumber(value) ?? 0 };
									patch({ cost: { ...draft.cost, tiers } });
								}}
								type="number"
							/>
						</Field>
						<Field label="cacheRead">
							<TextInput
								value={String(tier.cacheRead)}
								onChange={(value) => {
									const tiers = (draft.cost.tiers ?? []).slice();
									tiers[index] = { ...tier, cacheRead: optionalNumber(value) ?? 0 };
									patch({ cost: { ...draft.cost, tiers } });
								}}
								type="number"
							/>
						</Field>
						<Field label="cacheWrite">
							<TextInput
								value={String(tier.cacheWrite)}
								onChange={(value) => {
									const tiers = (draft.cost.tiers ?? []).slice();
									tiers[index] = { ...tier, cacheWrite: optionalNumber(value) ?? 0 };
									patch({ cost: { ...draft.cost, tiers } });
								}}
								type="number"
							/>
						</Field>
						<div style={{ gridColumn: "1 / -1", marginTop: -7 }}>
							<Button
								variant="ghost"
								small
								onClick={() => patch({ cost: { ...draft.cost, tiers: (draft.cost.tiers ?? []).filter((_, i) => i !== index) } })}
							>
								删除这一档
							</Button>
						</div>
					</div>
				))}
			</Section>

			<Section title="推理等级映射" note="thinkingLevelMap" lede="把 pi 的等级映射到上游接受的值。默认表示不写；不支持表示 null。">
				<div className="gw-stack">
					{THINKING_LEVELS.map((level) => {
						const current = draft.thinkingLevelMap?.[level];
						const mode = current === null ? "null" : current === undefined ? "default" : "custom";
						return (
							<div key={level} className="gw-grid" data-cols="2">
								<label className="gw-field">
									<span className="gw-label">{LEVEL_LABELS[level] ?? level}</span>
									<Select
										value={mode}
										onChange={(value) => {
											const next = { ...(draft.thinkingLevelMap ?? {}) };
											if (value === "default") delete next[level];
											else if (value === "null") next[level] = null;
											else next[level] = typeof current === "string" ? current : "";
											patch({ thinkingLevelMap: next });
										}}
										options={[
											{ value: "default", label: "默认" },
											{ value: "null", label: "不支持（null）" },
											{ value: "custom", label: "自定义值" },
										]}
									/>
								</label>
								{mode === "custom" ? (
									<Field label="映射值" hint={<code>{level}</code>}>
										<TextInput
											value={typeof current === "string" ? current : ""}
											onChange={(value) => patch({ thinkingLevelMap: { ...(draft.thinkingLevelMap ?? {}), [level]: value } })}
											placeholder={level}
										/>
									</Field>
								) : (
									<div />
								)}
							</div>
						);
					})}
				</div>
			</Section>

			<Section title="输入限制" note="inputLimits" lede="这些是本地侧的限制：超过时 pi-ai 会在发送前处理或拒绝，而不是等上游报错。">
				<div className="gw-grid" data-cols="2">
					<Field label="maxRequestBytes" hint={<code>inputLimits</code>}>
						<TextInput
							value={numberText(draft.inputLimits?.maxRequestBytes)}
							onChange={(value) => patch({ inputLimits: { ...(draft.inputLimits ?? {}), maxRequestBytes: optionalNumber(value) } })}
							type="number"
						/>
					</Field>
					<Field label="images.maxPerMessage" hint={<code>images</code>}>
						<TextInput
							value={numberText(draft.inputLimits?.images?.maxPerMessage)}
							onChange={(value) =>
								patch({
									inputLimits: {
										...(draft.inputLimits ?? {}),
										images: { ...(draft.inputLimits?.images ?? {}), maxPerMessage: optionalNumber(value) },
									},
								})
							}
							type="number"
						/>
					</Field>
					<Field label="images.maxPerRequest" hint={<code>images</code>}>
						<TextInput
							value={numberText(draft.inputLimits?.images?.maxPerRequest)}
							onChange={(value) =>
								patch({
									inputLimits: {
										...(draft.inputLimits ?? {}),
										images: { ...(draft.inputLimits?.images ?? {}), maxPerRequest: optionalNumber(value) },
									},
								})
							}
							type="number"
						/>
					</Field>
					<Field label="images.resize.maxWidth" hint={<code>resize</code>}>
						<TextInput
							value={numberText(draft.inputLimits?.images?.resize?.maxWidth)}
							onChange={(value) =>
								patch({
									inputLimits: {
										...(draft.inputLimits ?? {}),
										images: {
											...(draft.inputLimits?.images ?? {}),
											resize: { ...(draft.inputLimits?.images?.resize ?? {}), maxWidth: optionalNumber(value) },
										},
									},
								})
							}
							type="number"
						/>
					</Field>
					<Field label="images.resize.maxHeight" hint={<code>resize</code>}>
						<TextInput
							value={numberText(draft.inputLimits?.images?.resize?.maxHeight)}
							onChange={(value) =>
								patch({
									inputLimits: {
										...(draft.inputLimits ?? {}),
										images: {
											...(draft.inputLimits?.images ?? {}),
											resize: { ...(draft.inputLimits?.images?.resize ?? {}), maxHeight: optionalNumber(value) },
										},
									},
								})
							}
							type="number"
						/>
					</Field>
					<Field label="images.resize.maxBytes" hint={<code>resize</code>}>
						<TextInput
							value={numberText(draft.inputLimits?.images?.resize?.maxBytes)}
							onChange={(value) =>
								patch({
									inputLimits: {
										...(draft.inputLimits ?? {}),
										images: {
											...(draft.inputLimits?.images ?? {}),
											resize: { ...(draft.inputLimits?.images?.resize ?? {}), maxBytes: optionalNumber(value) },
										},
									},
								})
							}
							type="number"
						/>
					</Field>
					<Field label="images.resize.jpegQuality" hint={<code>1 – 100</code>}>
						<TextInput
							value={numberText(draft.inputLimits?.images?.resize?.jpegQuality)}
							onChange={(value) =>
								patch({
									inputLimits: {
										...(draft.inputLimits ?? {}),
										images: {
											...(draft.inputLimits?.images ?? {}),
											resize: { ...(draft.inputLimits?.images?.resize ?? {}), jpegQuality: optionalNumber(value) },
										},
									},
								})
							}
							type="number"
						/>
					</Field>
				</div>
			</Section>

			<Section title="采样参数" note="JSON" lede="samplingParams 会合并进 OpenAI 兼容请求体；samplingParamsByThinkingLevel 按思考等级覆盖。">
				<div className="gw-grid" data-cols="1">
					<JsonField
						key={`sampling-${draft.api ?? provider.api}`}
						label="samplingParams"
						value={draft.samplingParams}
						onValidity={(valid) => setJsonValidity("samplingParams", valid)}
						onChange={(value) => patch({ samplingParams: value as Record<string, unknown> | undefined })}
						placeholder='{ "top_p": 0.9, "top_k": 40 }'
					/>
					<JsonField
						key={`sampling-levels-${draft.api ?? provider.api}`}
						label="samplingParamsByThinkingLevel"
						value={draft.samplingParamsByThinkingLevel}
						onValidity={(valid) => setJsonValidity("samplingParamsByThinkingLevel", valid)}
						onChange={(value) =>
							patch({ samplingParamsByThinkingLevel: value as ModelConfig["samplingParamsByThinkingLevel"] })
						}
						placeholder='{ "high": { "top_p": 0.8 } }'
					/>
				</div>
			</Section>

			<Section
				title="兼容性"
				note={`${compatFields.length} 个字段 · 来自 pi-ai`}
				lede="字段名就是 pi-ai Model.compat 的键。留空表示不覆盖，适配器用默认值或自动探测。"
			>
				{compatFields.length === 0 ? (
					<div className="gw-hint">当前 API 在 pi-ai 1.4.0 里没有可覆盖的兼容字段。</div>
				) : (
					<>
						<div className="gw-grid" data-cols="2">
							{compatFields.map((field) => (
								<CompatControl
									key={`${api}:${field.key}`}
									field={field}
									value={draft.compat?.[field.key]}
									onChange={(value) => setCompat(field.key, value)}
									onValidity={(valid) => setJsonValidity(`compat:${field.key}`, valid)}
								/>
							))}
						</div>
						<Button variant="ghost" small onClick={() => patch({ compat: undefined })}>
							清空所有兼容字段
						</Button>
					</>
				)}
			</Section>

			<Section title="模型请求头" note="可选" lede="只在这个模型的请求上附加；同名键覆盖 Provider 请求头。">
				<KeyValueEditor
					value={headers}
					onChange={setHeaders}
					keyPlaceholder="x-model-header"
					valuePlaceholder="value"
					addLabel="添加模型请求头"
				/>
			</Section>
		</Drawer>
	);
}

function CompatControl({
	field,
	value,
	onChange,
	onValidity,
}: {
	field: CompatField;
	value: unknown;
	onChange: (value: unknown) => void;
	onValidity: (valid: boolean) => void;
}) {
	const help = field.description;
	const defaultHint = field.default !== undefined ? `默认：${JSON.stringify(field.default)}` : undefined;
	if (field.kind === "boolean") {
		return (
			<Field label={field.label} help={help} hint={defaultHint}>
				<Select
					value={value === undefined ? "" : String(value)}
					onChange={(next) => onChange(next === "" ? undefined : next === "true")}
					options={[
						{ value: "", label: "未设置" },
						{ value: "true", label: "true" },
						{ value: "false", label: "false" },
					]}
				/>
			</Field>
		);
	}
	if (field.kind === "enum") {
		return (
			<Field label={field.label} help={help} hint={defaultHint}>
				<Select
					value={value === undefined ? "" : String(value)}
					onChange={(next) => onChange(next === "" ? undefined : next)}
					options={[{ value: "", label: "未设置" }, ...(field.options ?? []).map((option) => ({ value: option, label: option }))]}
				/>
			</Field>
		);
	}
	if (field.kind === "number") {
		return (
			<Field label={field.label} help={help} hint={defaultHint}>
				<TextInput
					value={value === undefined ? "" : String(value)}
					onChange={(next) => onChange(next.trim() === "" ? undefined : Number(next))}
					type="number"
				/>
			</Field>
		);
	}
	if (field.kind === "string") {
		return (
			<Field label={field.label} help={help} hint={defaultHint}>
				<TextInput value={value === undefined ? "" : String(value)} onChange={(next) => onChange(next === "" ? undefined : next)} />
			</Field>
		);
	}
	return (
		<div style={{ gridColumn: "1 / -1" }}>
			<JsonField
				key={`${field.key}-json`}
				label={field.label}
				value={value}
				onValidity={onValidity}
				onChange={onChange}
				placeholder={defaultHint ?? "{}"}
			/>
			{help ? <div className="gw-help" style={{ marginTop: -8, marginBottom: 12 }}>{help}</div> : null}
		</div>
	);
}
