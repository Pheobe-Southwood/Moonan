import { ProvidersContract } from "@moonan_ai/contracts";
import { useEffect, useMemo, useState } from "react";
import type { TabProps } from "../../app.js";
import { useAction, useReadable, useRemote } from "../../chord/hooks.js";
import { useT } from "../../i18n.js";
import { Button, Empty, ErrorNote, Field, PageHead, Select, Tag, TextArea, TextInput } from "../../ui.js";

interface ProviderInfo {
	id: string;
	name: string;
	kind: "builtin" | "custom";
	hasKey: boolean;
	oauth: boolean;
	api?: string;
	baseUrl?: string;
}

interface ModelInfo {
	id: string;
	name: string;
	contextWindow: number;
	maxTokens: number;
	reasoning: boolean;
}

const API_OPTIONS = ["openai-completions", "anthropic-messages"];

export function ProvidersTab(_props: TabProps) {
	const t = useT();
	const providersRef = useRemote(ProvidersContract, {});
	const providers = useReadable<ProviderInfo[]>(providersRef?.providers, []);
	const [selected, setSelected] = useState<string | "new" | null>(null);
	const [query, setQuery] = useState("");
	const [key, setKey] = useState("");
	const [models, setModels] = useState<ModelInfo[]>([]);

	const [custom, setCustom] = useState({ id: "", name: "", baseUrl: "", api: API_OPTIONS[0] as string, models: "" });

	const saveKey = useAction(async () => {
		if (!providersRef || !selected || selected === "new") return;
		await providersRef.setKey({ provider: selected, key: key.trim() });
		setKey("");
	});
	const clearKey = useAction(async () => {
		if (!providersRef || !selected || selected === "new") return;
		await providersRef.clearKey({ provider: selected });
	});
	const addCustom = useAction(async () => {
		if (!providersRef) return;
		const models = custom.models
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean)
			.map((line) => {
				const [name, id] = line.includes("=") ? line.split("=") : [line, line];
				return { id: (id ?? name ?? "").trim(), name: (name ?? "").trim() };
			})
			.filter((model) => model.id);
		if (!custom.id.trim() || !custom.baseUrl.trim() || models.length === 0) return;
		await providersRef.addCustom({
			id: custom.id.trim(),
			name: custom.name.trim() || custom.id.trim(),
			baseUrl: custom.baseUrl.trim(),
			api: custom.api,
			models,
		});
		setCustom({ id: "", name: "", baseUrl: "", api: API_OPTIONS[0] as string, models: "" });
		setSelected(custom.id.trim());
	});
	const removeCustom = useAction(async (id: string) => {
		if (!providersRef) return;
		await providersRef.removeCustom({ id });
		setSelected(null);
	});

	const filtered = useMemo(() => {
		const needle = query.trim().toLowerCase();
		if (!needle) return providers;
		return providers.filter(
			(provider) => provider.name.toLowerCase().includes(needle) || provider.id.toLowerCase().includes(needle),
		);
	}, [providers, query]);

	const detail = selected && selected !== "new" ? providers.find((provider) => provider.id === selected) : undefined;

	useEffect(() => {
		if (selected === null && providers.length > 0) setSelected(providers[0]?.id ?? null);
	}, [providers, selected]);

	useEffect(() => {
		if (!providersRef || !detail) {
			setModels([]);
			return;
		}
		let cancelled = false;
		providersRef
			.models({ provider: detail.id })
			.then((list: ModelInfo[]) => {
				if (!cancelled) setModels(list);
			})
			.catch(() => {
				if (!cancelled) setModels([]);
			});
		return () => {
			cancelled = true;
		};
	}, [providersRef, detail?.id]);

	return (
		<div>
			<PageHead
				eyebrow={t("providers.eyebrow")}
				title={t("providers.title")}
				lede={t("providers.lede")}
				actions={
					<Button
						variant="ghost"
						onClick={() => {
							setSelected("new");
							setKey("");
						}}
					>
						{t("providers.custom.add")}
					</Button>
				}
			/>

			<div className="split" style={{ marginTop: 32 }}>
				<aside>
					<Field label={t("common.search")} htmlFor="provider-search">
						<TextInput
							id="provider-search"
							value={query}
							placeholder={t("providers.search")}
							onChange={(event) => setQuery(event.target.value)}
						/>
					</Field>
					<div className="list" style={{ marginTop: 16 }}>
						{filtered.map((provider) => (
							<button
								key={provider.id}
								type="button"
								className="list-item"
								data-selected={selected === provider.id}
								style={{ background: "none", border: 0, borderBottom: "1px solid var(--rule-soft)", textAlign: "left", cursor: "pointer", width: "100%" }}
								onClick={() => {
									setSelected(provider.id);
									setKey("");
								}}
							>
								<div>
									<div className="list-title">{provider.name}</div>
									<div className="list-meta">{provider.id}</div>
								</div>
								<Tag tone={provider.hasKey ? "on" : undefined}>
									{provider.hasKey ? t("providers.configured") : t("providers.unconfigured")}
								</Tag>
							</button>
						))}
					</div>
					{filtered.length === 0 ? <Empty>{t("common.none")}</Empty> : null}
				</aside>

				<section className="form">
					{!selected ? <Empty>{t("providers.pick")}</Empty> : null}

					{selected === "new" ? (
						<>
							<h2>{t("providers.custom.add")}</h2>
							<div className="row-2">
								<Field label={t("providers.custom.id")} htmlFor="custom-id">
									<TextInput
										id="custom-id"
										mono
										value={custom.id}
										placeholder="my-provider"
										onChange={(event) => setCustom({ ...custom, id: event.target.value })}
									/>
								</Field>
								<Field label={t("providers.custom.name")} htmlFor="custom-name">
									<TextInput id="custom-name" value={custom.name} onChange={(event) => setCustom({ ...custom, name: event.target.value })} />
								</Field>
							</div>
							<Field label={t("providers.custom.base")} htmlFor="custom-base">
								<TextInput
									id="custom-base"
									mono
									value={custom.baseUrl}
									placeholder="https://api.example.com/v1"
									onChange={(event) => setCustom({ ...custom, baseUrl: event.target.value })}
								/>
							</Field>
							<Field label={t("providers.custom.api")} htmlFor="custom-api">
								<Select id="custom-api" value={custom.api} onChange={(event) => setCustom({ ...custom, api: event.target.value })}>
									{API_OPTIONS.map((api) => (
										<option key={api} value={api}>
											{api}
										</option>
									))}
								</Select>
							</Field>
							<Field label={t("providers.custom.models")} help={t("providers.custom.models.help")} htmlFor="custom-models">
								<TextArea
									id="custom-models"
									mono
									rows={6}
									value={custom.models}
									placeholder={"我的模型=my-model"}
									onChange={(event) => setCustom({ ...custom, models: event.target.value })}
								/>
							</Field>
							<ErrorNote error={addCustom.error} />
							<div className="actions">
								<Button onClick={() => void addCustom.run()} disabled={addCustom.pending}>
									{t("common.add")}
								</Button>
								<Button variant="ghost" onClick={() => setSelected(null)}>
									{t("common.cancel")}
								</Button>
							</div>
						</>
					) : null}

					{detail ? (
						<>
							<h2>{detail.name}</h2>
							<div className="inline" style={{ marginBottom: 8 }}>
								<Tag tone={detail.hasKey ? "on" : undefined}>
									{detail.hasKey ? t("providers.configured") : t("providers.unconfigured")}
								</Tag>
								<span className="mono faint">{detail.id}</span>
								{detail.kind === "custom" ? <Tag>{t("providers.custom")}</Tag> : null}
							</div>
							{detail.baseUrl ? <div className="mono faint">{detail.baseUrl}</div> : null}
							{detail.api ? <div className="mono faint">{detail.api}</div> : null}

							<Field label={t("providers.key")} help={t("providers.key.placeholder")} htmlFor="provider-key">
								<TextInput
									id="provider-key"
									mono
									type="password"
									autoComplete="off"
									value={key}
									onChange={(event) => setKey(event.target.value)}
								/>
							</Field>
							<ErrorNote error={saveKey.error ?? clearKey.error ?? removeCustom.error} />
							<div className="actions">
								<Button onClick={() => void saveKey.run()} disabled={!key.trim() || saveKey.pending}>
									{t("providers.save_key")}
								</Button>
								<Button variant="ghost" onClick={() => void clearKey.run()} disabled={!detail.hasKey || clearKey.pending}>
									{t("providers.clear_key")}
								</Button>
								{detail.oauth ? (
									<Button variant="ghost" disabled title={t("providers.oauth.disabled")}>
										{t("providers.oauth")}
									</Button>
								) : null}
								{detail.kind === "custom" ? (
									<Button variant="danger" onClick={() => void removeCustom.run(detail.id)}>
										{t("providers.remove")}
									</Button>
								) : null}
							</div>

							<div className="section">
								<h3>
									{models.length} {t("providers.count")}
								</h3>
								<div className="mono faint" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "4px 24px" }}>
									{models.slice(0, 60).map((model) => (
										<span key={model.id}>{model.name}</span>
									))}
								</div>
							</div>
						</>
					) : null}
				</section>
			</div>
		</div>
	);
}
