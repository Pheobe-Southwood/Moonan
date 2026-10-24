import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { type Ctx, defineFacet, local, method } from "@earendil-works/chord";
import { applySqliteMigrations, type SqliteDatabase, type SqliteMigration } from "@earendil-works/chord/sqlite";
import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import { Type } from "typebox";
import {
	AgentAdmin,
	AgentTools,
	AppAdmin,
	ChatMessageSchema,
	HostPaths,
	type ChatMessage,
} from "@moonan_ai/contracts";
import { ChatContract } from "./contract.js";

const BATCH_WINDOW_MS = 2_000;
const MAIN_AGENT = "main";
const HISTORY_LIMIT = 200;
const PLUGIN_ID = "chat";

const MIGRATIONS: SqliteMigration[] = [
	{
		version: 1,
		statements: [
			`CREATE TABLE messages (
				seq INTEGER PRIMARY KEY AUTOINCREMENT,
				agent_id TEXT NOT NULL,
				direction TEXT NOT NULL,
				text TEXT NOT NULL,
				created_at INTEGER NOT NULL
			)`,
			"CREATE INDEX messages_by_agent ON messages (agent_id, seq)",
		],
	},
];

const PendingSchema = Type.Object({ id: Type.String(), agent: Type.String(), text: Type.String(), at: Type.Number() });
type Pending = { id: string; agent: string; text: string; at: number };

/** Everything the plugin owns: the database, the revision counter and the batch queue. */
const ChatStore = local("moonan.chat.store", {
	version: 1,
	input: Type.Object({}),
	members: {
		revision: Type.Number(),
		post: method(Type.Object({ agent: Type.String(), text: Type.String() })),
		page: method(
			Type.Object({ agent: Type.String(), before: Type.Optional(Type.Number()), limit: Type.Number() }),
			Type.Array(ChatMessageSchema),
		),
	},
});

async function insert(
	db: SqliteDatabase,
	agentId: string,
	direction: ChatMessage["direction"],
	text: string,
): Promise<ChatMessage> {
	const createdAt = Date.now();
	await db.run(
		"INSERT INTO messages (agent_id, direction, text, created_at) VALUES (?, ?, ?, ?)",
		agentId,
		direction,
		text,
		createdAt,
	);
	const row = await db.get<{ seq: number }>("SELECT last_insert_rowid() AS seq");
	return { seq: Number(row?.seq ?? 0), direction, text, createdAt };
}

async function page(
	db: SqliteDatabase,
	agentId: string,
	options: { before?: number; limit: number },
): Promise<ChatMessage[]> {
	const limit = Math.max(1, Math.min(options.limit, 500));
	const rows =
		options.before === undefined
			? await db.all<{ seq: number; direction: string; text: string; created_at: number }>(
					"SELECT seq, direction, text, created_at FROM messages WHERE agent_id = ? ORDER BY seq DESC LIMIT ?",
					agentId,
					limit,
				)
			: await db.all<{ seq: number; direction: string; text: string; created_at: number }>(
					"SELECT seq, direction, text, created_at FROM messages WHERE agent_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?",
					agentId,
					options.before,
					limit,
				);
	return rows
		.map((row) => ({
			seq: Number(row.seq),
			direction: row.direction as ChatMessage["direction"],
			text: row.text,
			createdAt: Number(row.created_at),
		}))
		.reverse();
}

function formatTime(timestamp: number): string {
	const date = new Date(timestamp);
	return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal.aborted) {
			resolve();
			return;
		}
		const timer = setTimeout(resolve, ms);
		signal.addEventListener(
			"abort",
			() => {
				clearTimeout(timer);
				resolve();
			},
			{ once: true },
		);
	});
}

/**
 * The chat window. Owns its bubbles, the two-second batch rule and the `send_message`
 * tool — the only way a character can reach the person.
 *
 * `ChatStore` is the host-lifetime owner of the SQLite file; the per-agent
 * `ChatContract` objects only read pages from it and re-read them when `revision`
 * changes. That keeps one writer and lets a reload keep the open database.
 */
export default defineFacet((api) => {
	api.serve(
		ChatStore,
		(_input, _principal, self) => {
			const paths = self.get(HostPaths, {});
			const admin = self.get(AgentAdmin, {});
			const app = self.get(AppAdmin, {});
			const db = self.resource<SqliteDatabase>("db", {
				version: 1,
				deps: [paths],
				open: async () => {
					const dir = join(paths.dataDir.value, "plugins-data");
					await mkdir(dir, { recursive: true });
					const database = await openNodeSqliteDatabase(join(dir, `${PLUGIN_ID}.db`));
					await database.exec("PRAGMA journal_mode = WAL");
					await applySqliteMigrations(database, MIGRATIONS, { table: "schema_migrations" });
					return database;
				},
				close: (database) => database.close(),
			});
			const revision = self.state("revision", Type.Number(), 0);
			const pending = self.state("pending", Type.Array(PendingSchema), []);

			const bump = async (ctx: Ctx): Promise<void> => {
				revision.change(ctx, (value) => value + 1);
			};

			// A static contribution: the registry is swapped wholesale at commit.
			self.register(AgentTools, {
				send_message: {
					agents: [MAIN_AGENT],
					tool: {
						name: "send_message",
						label: "向对话窗口发送消息",
						description:
							"以角色的身份向用户发送一条消息，显示在 WebUI 的对话窗口中。这是用户唯一能看到的内容；心理描写不要放进这里，直接输出为文本即可。",
						parameters: Type.Object({ content: Type.String({ description: "用户能看到的文本" }) }),
						execute: async (_toolCallId, params) => {
							const { content } = params as { content: string };
							await api.root(async (ctx) => {
								await insert(db.value, MAIN_AGENT, "out", content);
								await bump(ctx);
							});
							return { content: [{ type: "text" as const, text: "已发送" }], details: undefined };
						},
					},
				},
			});

			self.task(async (ctx) => {
				while (!ctx.signal.aborted) {
					await sleep(100, ctx.signal);
					if (ctx.signal.aborted) break;
					const now = Date.now();
					const due = pending.value.filter((item) => now - item.at >= BATCH_WINDOW_MS);
					if (due.length === 0) continue;
					for (const agent of new Set(due.map((item) => item.agent))) {
						const batch = due.filter((item) => item.agent === agent);
						const ids = new Set(batch.map((item) => item.id));
						// Cells hand out JSON copies: drop by id, never by object identity.
						pending.change(ctx, (draft) => {
							for (let index = draft.length - 1; index >= 0; index -= 1) {
								const item = draft[index];
								if (item && ids.has(item.id)) draft.splice(index, 1);
							}
						});
						if (!(await admin.canSend({ agent }))) {
							console.warn(`[chat] agent "${agent}" has no model; dropped ${batch.length} message(s)`);
							continue;
						}
						const lines = batch.map((item) => `[${formatTime(item.at)}] ${item.text}`).join("\n");
						const user = (await app.get()).user;
						try {
							await admin.send({ agent, text: `${user}通过webui给你发送了 ${batch.length} 条消息：\n${lines}` });
						} catch (error) {
							console.error("chat batch failed", error);
						}
					}
				}
			});

			return {
				revision,
				post: async (args: { agent: string; text: string }, ctx: Ctx) => {
					await insert(db.value, args.agent, "in", args.text);
					await bump(ctx);
					pending.change(ctx, (draft) => {
						draft.push({
							id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
							agent: args.agent,
							text: args.text,
							at: Date.now(),
						} satisfies Pending);
					});
				},
				page: (args: { agent: string; before?: number; limit: number }) => page(db.value, args.agent, args),
			};
		},
		{ lifetime: "host" },
	);

	api.serve(
		ChatContract,
		(input, _principal, self) => {
			const store = self.get(ChatStore, {});
			const messages = self.state("messages", Type.Array(ChatMessageSchema), {
				init: (ctx) => store.page({ agent: input.agent, limit: HISTORY_LIMIT }, ctx),
			});
			self.on("revision", store.revision, async (_value, ctx) => {
				messages.replace(ctx, await store.page({ agent: input.agent, limit: HISTORY_LIMIT }, ctx));
			});
			return {
				variant: "v1" as const,
				messages,
				post: async ({ text }: { text: string }, ctx) => {
					await store.post({ agent: input.agent, text }, ctx);
				},
				page: ({ before, limit }: { before?: number; limit: number }, ctx) =>
					store.page({ agent: input.agent, before, limit }, ctx),
			};
		},
		{ linger: 30_000 },
	);
}, { uses: [HostPaths, AgentAdmin, AppAdmin] });
