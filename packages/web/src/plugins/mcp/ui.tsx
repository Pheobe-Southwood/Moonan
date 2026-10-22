import { McpContract } from "@moonan_ai/contracts";
import { useState } from "react";
import type { TabProps } from "../../app.js";
import { useAction, useReadable, useRemote } from "../../chord/hooks.js";
import { useT } from "../../i18n.js";
import { Button, Empty, ErrorNote, Field, PageHead, Select, Switch, Tag, TextArea, TextInput } from "../../ui.js";

interface McpTool {
	name: string;
	description: string;
	enabled: boolean;
}

interface McpServer {
	id: string;
	name: string;
	transport: "stdio" | "http";
	target: string;
	status: "idle" | "connecting" | "connected" | "error";
	error?: string;
	tools: McpTool[];
}

function parseHeaders(text: string): Record<string, string> | undefined {
	const entries = text
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line) => {
			const index = line.indexOf(":");
			if (index < 0) return null;
			return [line.slice(0, index).trim(), line.slice(index + 1).trim()] as const;
		})
		.filter((entry): entry is readonly [string, string] => entry !== null);
	return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

export function McpTab(_props: TabProps) {
	const t = useT();
	const mcp = useRemote(McpContract, {});
	const servers = useReadable<McpServer[]>(mcp?.servers, []);
	const [open, setOpen] = useState(false);
	const [form, setForm] = useState({
		name: "",
		transport: "stdio" as "stdio" | "http",
		command: "",
		args: "",
		url: "",
		headers: "",
	});

	const add = useAction(async () => {
		if (!mcp || !form.name.trim()) return;
		const args = form.args
			.split(/\s+/)
			.map((part) => part.trim())
			.filter(Boolean);
		const headers = parseHeaders(form.headers);
		await mcp.addServer({
			name: form.name.trim(),
			transport: form.transport,
			...(form.transport === "stdio"
				? { command: form.command.trim(), ...(args.length > 0 ? { args } : {}) }
				: { url: form.url.trim(), ...(headers ? { headers } : {}) }),
		});
		setForm({ name: "", transport: "stdio", command: "", args: "", url: "", headers: "" });
		setOpen(false);
	});
	const remove = useAction(async (id: string) => {
		if (!mcp) return;
		await mcp.removeServer({ id });
	});
	const reconnect = useAction(async (id: string) => {
		if (!mcp) return;
		await mcp.reconnect({ id });
	});

	const statusTone = (status: McpServer["status"]) => (status === "connected" ? "on" : status === "error" ? "warn" : undefined);

	return (
		<div>
			<PageHead
				eyebrow={t("mcp.eyebrow")}
				title={t("mcp.title")}
				lede={t("mcp.lede")}
				actions={
					<Button variant="ghost" onClick={() => setOpen((current) => !current)}>
						{open ? t("common.cancel") : t("mcp.add")}
					</Button>
				}
			/>

			<ErrorNote error={add.error ?? remove.error ?? reconnect.error} />

			{open ? (
				<div className="form" style={{ marginTop: 32, paddingBottom: 32, borderBottom: "1px solid var(--rule)" }}>
					<div className="row-2">
						<Field label={t("mcp.name")} htmlFor="mcp-name">
							<TextInput id="mcp-name" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
						</Field>
						<Field label={t("mcp.transport")} htmlFor="mcp-transport">
							<Select
								id="mcp-transport"
								value={form.transport}
								onChange={(event) => setForm({ ...form, transport: event.target.value as "stdio" | "http" })}
							>
								<option value="stdio">{t("mcp.transport.stdio")}</option>
								<option value="http">{t("mcp.transport.http")}</option>
							</Select>
						</Field>
					</div>
					{form.transport === "stdio" ? (
						<div className="row-2">
							<Field label={t("mcp.command")} htmlFor="mcp-command">
								<TextInput
									id="mcp-command"
									mono
									value={form.command}
									placeholder="npx"
									onChange={(event) => setForm({ ...form, command: event.target.value })}
								/>
							</Field>
							<Field label={t("mcp.args")} help={t("mcp.args.help")} htmlFor="mcp-args">
								<TextInput
									id="mcp-args"
									mono
									value={form.args}
									placeholder="-y @modelcontextprotocol/server-filesystem /tmp"
									onChange={(event) => setForm({ ...form, args: event.target.value })}
								/>
							</Field>
						</div>
					) : (
						<>
							<Field label={t("mcp.url")} htmlFor="mcp-url">
								<TextInput
									id="mcp-url"
									mono
									value={form.url}
									placeholder="https://example.com/mcp"
									onChange={(event) => setForm({ ...form, url: event.target.value })}
								/>
							</Field>
							<Field label={t("mcp.headers")} help={t("mcp.headers.help")} htmlFor="mcp-headers">
								<TextArea id="mcp-headers" mono rows={4} value={form.headers} onChange={(event) => setForm({ ...form, headers: event.target.value })} />
							</Field>
						</>
					)}
					<div className="actions">
						<Button onClick={() => void add.run()} disabled={add.pending || !form.name.trim()}>
							{t("common.add")}
						</Button>
					</div>
				</div>
			) : null}

			<div style={{ marginTop: 32 }}>
				{servers.length === 0 ? <Empty>{t("mcp.empty")}</Empty> : null}
				{servers.map((server) => (
					<section key={server.id} style={{ padding: "24px 0", borderBottom: "1px solid var(--rule)" }}>
						<div className="list-item" style={{ border: 0, padding: 0 }}>
							<div>
								<div className="list-title">{server.name}</div>
								<div className="list-meta">
									{server.transport} · {server.target}
								</div>
								{server.error ? <div className="mono" style={{ color: "var(--accent)", marginTop: 4 }}>{server.error}</div> : null}
							</div>
							<div className="inline">
								<Tag tone={statusTone(server.status)}>{t(`mcp.status.${server.status}`)}</Tag>
								<Button variant="ghost" size="sm" onClick={() => void reconnect.run(server.id)} disabled={reconnect.pending}>
									{t("mcp.reconnect")}
								</Button>
								<Button variant="danger" size="sm" onClick={() => void remove.run(server.id)} disabled={remove.pending}>
									{t("common.remove")}
								</Button>
							</div>
						</div>

						<div style={{ marginTop: 16 }}>
							<h3>
								{t("mcp.tools")} · {server.tools.length}
							</h3>
							{server.tools.length === 0 ? (
								<div className="mono faint">{t("mcp.no_tools")}</div>
							) : (
								<div className="stack">
									{server.tools.map((tool) => (
										<div
											key={tool.name}
											style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto", gap: 24, alignItems: "center" }}
										>
											<div>
												<div className="mono" style={{ fontSize: 13 }}>
													{tool.name}
												</div>
												<div className="faint" style={{ fontSize: 12 }}>
													{tool.description}
												</div>
											</div>
											<Switch
												checked={tool.enabled}
												label={tool.enabled ? "on" : "off"}
												onChange={(next) => {
													if (!mcp) return;
													void mcp.setToolEnabled({ server: server.id, tool: tool.name, enabled: next }).catch((error: unknown) => {
														console.error("[mcp] toggle failed", error);
													});
												}}
											/>
										</div>
									))}
								</div>
							)}
						</div>
					</section>
				))}
			</div>
		</div>
	);
}
