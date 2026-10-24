import { AgentContract, AgentIndexContract, AppContract, ProvidersContract } from "@moonan_ai/contracts";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button, ErrorNote, Field, PageHead, Select, Tag, TextArea, TextInput, useAction, useReadable, useRemote, useT, type PanelProps } from "@moonan_ai/web-api";
import { messages } from "./i18n.js";

const MAIN_AGENT = "main";

interface Variable {
	key: string;
	label: string;
	type: "text" | "textarea";
	value: string;
	global?: boolean;
	placeholder?: string;
}

interface AgentConfig {
	name: string;
	description: string;
	systemPrompt: string;
	variables: Variable[];
	model: { provider: string; id: string } | null;
}

interface AgentSummary {
	id: string;
	pluginId: string;
	name: string;
	description: string;
	model: { provider: string; id: string } | null;
	status: string;
	needsModel: boolean;
}

interface Draft {
	name: string;
	description: string;
	systemPrompt: string;
	variables: Variable[];
	model: { provider: string; id: string } | null;
	user: string;
}

function draftOf(config: AgentConfig | undefined, user: string): Draft {
	return {
		name: config?.name ?? "",
		description: config?.description ?? "",
		systemPrompt: config?.systemPrompt ?? "",
		variables: config?.variables.map((variable) => ({ ...variable })) ?? [],
		model: config?.model ?? null,
		user,
	};
}

export function AgentsTab({ host, user }: PanelProps) {
	const t = useT(messages);
	const app = useRemote(host, AppContract, {});
	const index = useRemote(host, AgentIndexContract, {});
	const agents = useReadable<AgentSummary[]>(index?.agents, []);
	const main = useRemote(host, AgentContract, { agent: MAIN_AGENT });
	const config = useReadable<AgentConfig | undefined>(main?.config, undefined);
	const providersRef = useRemote(host, ProvidersContract, {});
	const providers = useReadable<any[]>(providersRef?.providers, []);

	const [draft, setDraft] = useState<Draft>(() => draftOf(config, user));
	const [providerId, setProviderId] = useState("");
	const [models, setModels] = useState<{ id: string; name: string }[]>([]);
	const save = useAction(async () => {
		if (!main) return;
		await main.updateConfig({
			name: draft.name,
			description: draft.description,
			systemPrompt: draft.systemPrompt,
			variables: draft.variables,
			model: draft.model,
		});
		if (app && draft.user !== user) await app.update({ user: draft.user });
	});

	// A reconnect re-acquires the same object and replays its state; only a real
	// change should throw away what the user is typing.
	const appliedConfig = useRef("");
	useEffect(() => {
		if (!config) return;
		const fingerprint = `${JSON.stringify(config)}|${user}`;
		if (fingerprint === appliedConfig.current) return;
		appliedConfig.current = fingerprint;
		setDraft(draftOf(config, user));
		setProviderId(config.model?.provider ?? "");
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [config, user]);

	useEffect(() => {
		if (providerId || providers.length === 0) return;
		const first = providers[0];
		if (first?.id) setProviderId(first.id);
	}, [providerId, providers]);

	useEffect(() => {
		if (!providersRef || !providerId) {
			setModels([]);
			return;
		}
		let cancelled = false;
		providersRef
			.models({ provider: providerId })
			.then((list: { id: string; name: string }[]) => {
				if (!cancelled) setModels(list);
			})
			.catch(() => {
				if (!cancelled) setModels([]);
			});
		return () => {
			cancelled = true;
		};
	}, [providersRef, providerId]);

	const summary = agents.find((agent) => agent.id === MAIN_AGENT);
	const selectedModel = draft.model;
	const merged = useMemo(
		() => (providerId && !models.some((model) => model.id === selectedModel?.id) && selectedModel ? [{ id: selectedModel.id, name: selectedModel.id }] : models),
		[models, providerId, selectedModel],
	);

	if (!main) {
		return <div className="empty">{t("common.loading")}…</div>;
	}

	return (
		<div>
			<PageHead eyebrow={t("agents.eyebrow")} title={t("agents.title")} lede={t("agents.lede")} />

			<div className="split" style={{ marginTop: 32 }}>
				<aside>
					<h3>{t("nav.agents")}</h3>
					<div className="list">
						{agents.map((agent) => (
							<div className="list-item" key={agent.id} data-selected={agent.id === MAIN_AGENT}>
								<div>
									<div className="list-title">{agent.name}</div>
									<div className="list-meta">
										{agent.model ? `${agent.model.provider}/${agent.model.id}` : agent.description}
									</div>
								</div>
								<Tag tone={agent.needsModel ? "warn" : agent.status === "streaming" ? "on" : undefined}>
									{agent.needsModel ? t("agents.no_model") : t(`status.${agent.status}`)}
								</Tag>
							</div>
						))}
					</div>
					{summary ? (
						<div className="mono faint" style={{ marginTop: 16 }}>
							{t("agents.plugin")}: {summary.pluginId}
						</div>
					) : null}
				</aside>

				<section className="form">
					<Field label={t("agents.name")} help={t("agents.name.help")} htmlFor="agent-name">
						<TextInput
							id="agent-name"
							value={draft.name}
							onChange={(event) => setDraft({ ...draft, name: event.target.value })}
						/>
					</Field>

					<Field label={t("agents.description")} htmlFor="agent-description">
						<TextInput
							id="agent-description"
							value={draft.description}
							onChange={(event) => setDraft({ ...draft, description: event.target.value })}
						/>
					</Field>

					<div className="section section--flush">
						<h3>变量</h3>
						<div className="stack">
							{draft.variables.map((variable, position) => (
								<Field
									key={variable.key}
									label={variable.label}
									help={variable.global ? "所有 Agent 共用" : undefined}
									htmlFor={`variable-${variable.key}`}
								>
									{variable.type === "textarea" ? (
										<TextArea
											id={`variable-${variable.key}`}
											value={variable.value}
											placeholder={variable.placeholder}
											onChange={(event) => {
												const variables = draft.variables.map((candidate, index) =>
													index === position ? { ...candidate, value: event.target.value } : candidate,
												);
												setDraft({ ...draft, variables });
											}}
										/>
									) : (
										<TextInput
											id={`variable-${variable.key}`}
											value={variable.value}
											placeholder={variable.placeholder}
											onChange={(event) => {
												const variables = draft.variables.map((candidate, index) =>
													index === position ? { ...candidate, value: event.target.value } : candidate,
												);
												setDraft({ ...draft, variables });
											}}
										/>
									)}
								</Field>
							))}

							<Field label={t("agents.user")} help={t("agents.user.help")} htmlFor="agent-user">
								<TextInput id="agent-user" value={draft.user} onChange={(event) => setDraft({ ...draft, user: event.target.value })} />
							</Field>
						</div>
					</div>

					<div className="section">
						<h3>{t("agents.model")}</h3>
						<div className="row-2">
							<Field label={t("nav.providers")} htmlFor="agent-provider">
								<Select
									id="agent-provider"
									value={providerId}
									onChange={(event) => {
										setProviderId(event.target.value);
										setDraft({ ...draft, model: null });
									}}
								>
									{providers.map((provider) => (
										<option key={provider.id} value={provider.id}>
											{provider.name}
										</option>
									))}
								</Select>
							</Field>
							<Field label={t("agents.model")} help={t("agents.model.help")} htmlFor="agent-model">
								<Select
									id="agent-model"
									value={draft.model?.provider === providerId ? draft.model.id : ""}
									onChange={(event) => {
										const id = event.target.value;
										setDraft({ ...draft, model: id ? { provider: providerId, id } : null });
									}}
								>
									<option value="">{t("agents.model.unset")}</option>
									{merged.map((model) => (
										<option key={model.id} value={model.id}>
											{model.name}
										</option>
									))}
								</Select>
							</Field>
						</div>
					</div>

					<details className="section">
						<summary className="tool-name" style={{ cursor: "pointer" }}>
							{t("agents.advanced")} · {t("agents.prompt")}
						</summary>
						<div className="mt-24">
							<Field label={t("agents.prompt")} help={t("agents.prompt.help")} htmlFor="agent-prompt">
								<TextArea
									id="agent-prompt"
									mono
									rows={16}
									value={draft.systemPrompt}
									onChange={(event) => setDraft({ ...draft, systemPrompt: event.target.value })}
								/>
							</Field>
						</div>
					</details>

					<ErrorNote error={save.error} />
					<div className="actions">
						<Button onClick={() => void save.run()} disabled={save.pending}>
							{save.pending ? "…" : t("common.save")}
						</Button>
					</div>
				</section>
			</div>
		</div>
	);
}
