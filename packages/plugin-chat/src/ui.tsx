import { AgentContract, AgentIndexContract } from "@moonan_ai/contracts";
import { ChatContract } from "./contract.js";
import { useEffect, useRef, useState } from "react";
import { Button, ErrorNote, useAction, useReadable, useRemote, useT, type PanelProps } from "@moonan_ai/web-api";
import { messages as translations } from "./i18n.js";

const MAIN_AGENT = "main";

interface ChatMessage {
	seq: number;
	direction: "in" | "out";
	text: string;
	createdAt: number;
}

interface AgentSummary {
	id: string;
	name: string;
	model: { provider: string; id: string } | null;
	status: string;
	needsModel: boolean;
}

function formatTime(timestamp: number): string {
	const date = new Date(timestamp);
	return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

export function ChatTab({ host, user }: PanelProps) {
	const t = useT(translations);
	const index = useRemote(host, AgentIndexContract, {});
	const agents = useReadable<AgentSummary[]>(index?.agents, []);
	const summary = agents.find((agent) => agent.id === MAIN_AGENT);
	const main = useRemote(host, AgentContract, { agent: MAIN_AGENT });
	const chat = useRemote(host, ChatContract, { agent: MAIN_AGENT });
	const messages = useReadable<ChatMessage[]>(chat?.messages, []);
	const phase = useReadable<string>(main?.phase, "idle");

	const [draft, setDraft] = useState("");
	const feed = useRef<HTMLDivElement | null>(null);
	const send = useAction(async (text: string) => {
		if (!chat) return;
		await chat.post({ text });
	});

	useEffect(() => {
		const node = feed.current;
		if (node) node.scrollTop = node.scrollHeight;
	}, [messages.length, phase]);

	const busy = phase === "streaming" || phase === "queued";
	const name = summary?.name || "…";

	const submit = async () => {
		const text = draft.trim();
		if (!text || !chat) return;
		setDraft("");
		await send.run(text);
	};

	return (
		<div className="chat">
			<div className="chat-head">
				<div className="inline">
					<span className="chat-name">{name}</span>
					{summary?.model ? (
						<span className="mono faint">
							{summary.model.provider}/{summary.model.id}
						</span>
					) : null}
				</div>
				<span className="hint">
					{t(`status.${phase}`)}
				</span>
			</div>

			{summary?.needsModel ? (
				<div className="banner">
					{t("chat.model_missing")} — {t("chat.model_missing.body")}{" "}
					<button type="button" className="link" onClick={() => (location.hash = "#/agents")}>
						{t("nav.agents")}
					</button>
				</div>
			) : null}
			<ErrorNote error={send.error} />

			<div className="chat-feed" ref={feed}>
				{messages.length === 0 && !busy ? (
					<div className="chat-empty">
						<h2>{t("chat.empty.title")}</h2>
						<p className="lede">{t("chat.empty.body")}</p>
					</div>
				) : null}

				<div className="ledger">
					{messages.map((message) => (
						<div className="entry" data-kind={message.direction} key={message.seq}>
							<div className="entry-label">
								<strong>{message.direction === "in" ? user : name}</strong>
								<time>{formatTime(message.createdAt)}</time>
							</div>
							<div className="entry-body">{message.text}</div>
						</div>
					))}
					{busy ? (
						<div className="entry" data-kind="out">
							<div className="entry-label">
								<strong>{name}</strong>
								<time>{t("chat.thinking")}</time>
							</div>
							<div className="entry-body">
								<span className="caret" />
							</div>
						</div>
					) : null}
				</div>
			</div>

			<div className="composer">
				<textarea
					rows={1}
					value={draft}
					placeholder={t("chat.placeholder")}
					onChange={(event) => setDraft(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
							event.preventDefault();
							void submit();
						}
					}}
					aria-label={t("chat.placeholder")}
					autoFocus
				/>
				<Button onClick={() => void submit()} disabled={!draft.trim() || !chat}>
					{t("chat.send")}
				</Button>
			</div>
			<div className="hint" style={{ paddingBottom: 8 }}>
				{t("chat.hint")}
			</div>
		</div>
	);
}
