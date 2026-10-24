import { AgentContract } from "@moonan_ai/contracts";
import { LogsContract } from "./contract.js";
import { useEffect, useRef, useState } from "react";
import { Button, Empty, useReadable, useRemote, useT, type PanelProps } from "@moonan_ai/web-api";
import { messages } from "./i18n.js";

const MAIN_AGENT = "main";

interface TranscriptEntry {
	seq: number;
	role: string;
	message: any;
	createdAt: number;
}

interface LiveMessage {
	turn: number;
	text: string;
	thinking: string;
	tools: { id: string; name: string; args: string; state: string; result?: string }[];
}

interface Block {
	kind: "text" | "thinking" | "tool" | "result";
	label?: string;
	text: string;
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			if (typeof part === "string") return part;
			if (part && typeof part === "object" && "text" in part) return String((part as { text: unknown }).text);
			return "";
		})
		.filter(Boolean)
		.join("\n");
}

function blocksOf(message: any): Block[] {
	const role = message?.role;
	if (role === "toolResult") {
		return [{ kind: "result", label: message.toolName ?? "tool", text: textOf(message.content) || "(empty)" }];
	}
	const content = message?.content;
	if (typeof content === "string") return [{ kind: "text", text: content }];
	if (!Array.isArray(content)) return [{ kind: "text", text: "" }];
	const blocks: Block[] = [];
	for (const part of content) {
		if (!part || typeof part !== "object") continue;
		if (part.type === "text") blocks.push({ kind: "text", text: String(part.text ?? "") });
		else if (part.type === "thinking") blocks.push({ kind: "thinking", label: "思考", text: String(part.thinking ?? "") });
		else if (part.type === "toolCall") {
			blocks.push({
				kind: "tool",
				label: String(part.name ?? "tool"),
				text: JSON.stringify(part.arguments ?? {}, null, 2),
			});
		}
	}
	return blocks.length > 0 ? blocks : [{ kind: "text", text: "" }];
}

function roleLabel(role: string, t: (key: string) => string): string {
	if (role === "user") return t("logs.role.user");
	if (role === "assistant") return t("logs.role.assistant");
	if (role === "toolResult") return t("logs.role.tool");
	return t("logs.role.system");
}

export function LogsTab({ host }: PanelProps) {
	const t = useT(messages);
	const logs = useRemote(host, LogsContract, { agent: MAIN_AGENT });
	const main = useRemote(host, AgentContract, { agent: MAIN_AGENT });
	const live = useReadable<LiveMessage>(main?.live, { turn: 0, text: "", thinking: "", tools: [] });
	const phase = useReadable<string>(main?.phase, "idle");

	const [entries, setEntries] = useState<TranscriptEntry[]>([]);
	const [exhausted, setExhausted] = useState(false);
	const [loading, setLoading] = useState(false);
	const bottom = useRef<HTMLDivElement | null>(null);
	const seenTurn = useRef(0);
	const shown = useRef(0);

	const load = async (before?: number) => {
		if (!logs) return;
		setLoading(true);
		try {
			const page = (await logs.page({ limit: 100, ...(before !== undefined ? { before } : {}) })) as TranscriptEntry[];
			if (before === undefined) {
				setEntries(page);
				setExhausted(page.length < 100);
			} else {
				setEntries((current) => [...page, ...current]);
				setExhausted(page.length < 100);
			}
		} catch (error) {
			console.error("[logs] page failed", error);
		} finally {
			setLoading(false);
		}
	};

	useEffect(() => {
		if (!logs) {
			setEntries([]);
			return;
		}
		void load();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [logs]);

	useEffect(() => {
		if (!logs) return;
		if (phase === "idle" && live.turn !== seenTurn.current) {
			seenTurn.current = live.turn;
			void load();
		}
		if (live.turn > seenTurn.current && phase !== "idle") {
			seenTurn.current = live.turn;
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [phase, live.turn]);

	useEffect(() => {
		// Follow new entries, but leave the page at the top on first load.
		if (shown.current !== 0 && entries.length > shown.current) bottom.current?.scrollIntoView({ block: "end" });
		shown.current = entries.length;
	}, [entries.length]);

	const streaming = phase === "streaming" || phase === "queued";

	return (
		<div>
			<div className="page-head">
				<div>
					<p className="eyebrow">{t("logs.eyebrow")}</p>
					<h1>{t("logs.title")}</h1>
					<p className="lede">模型看到和说出的每一条内容，包括工具调用。用户可见的对话不在这里。</p>
				</div>
				<div className="inline">
					{exhausted ? null : (
						<Button variant="ghost" size="sm" disabled={loading} onClick={() => void load(entries[0]?.seq)}>
							{t("logs.load_more")}
						</Button>
					)}
				</div>
			</div>

			{entries.length === 0 && !streaming ? <Empty>{t("logs.empty")}</Empty> : null}

			<div className="ledger">
				{entries.map((entry) => (
					<div className="entry" data-kind={entry.role === "user" ? "in" : entry.role === "assistant" ? "out" : "tool"} key={entry.seq}>
						<div className="entry-label">
							<strong>{roleLabel(entry.role, t)}</strong>
							<span>#{entry.seq}</span>
						</div>
						<div>
							{blocksOf(entry.message).map((block, index) => (
								<div key={index}>
									{block.kind === "tool" ? (
										<>
											<span className="tool-name">→ {block.label}</span>
											<div className="tool-block">{block.text}</div>
										</>
									) : block.kind === "result" ? (
										<>
											<span className="tool-name">← {block.label}</span>
											<div className="tool-block">{block.text}</div>
										</>
									) : block.kind === "thinking" ? (
										<details>
											<summary className="tool-name">思考</summary>
											<div className="tool-block">{block.text}</div>
										</details>
									) : (
										<div className="entry-body">{block.text}</div>
									)}
								</div>
							))}
						</div>
					</div>
				))}
			</div>

			{streaming ? (
				<div className="ledger" style={{ borderTop: "1px solid var(--rule)" }}>
					<div className="entry" data-kind="out">
						<div className="entry-label">
							<strong>{t("logs.live")}</strong>
							<span>turn {live.turn}</span>
						</div>
						<div>
							{live.thinking ? (
								<div className="tool-block" style={{ marginBottom: 12 }}>
									{live.thinking}
								</div>
							) : null}
							{live.tools.map((tool) => (
								<div key={tool.id}>
									<span className="tool-name">→ {tool.name}</span>
									<div className="tool-block">{tool.args}</div>
									{tool.result ? <div className="tool-block">← {tool.result}</div> : null}
								</div>
							))}
							<div className="entry-body">
								{live.text}
								<span className="caret" />
							</div>
						</div>
					</div>
				</div>
			) : null}
			<div ref={bottom} />
		</div>
	);
}
