import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { defineFacet, local, method } from "@earendil-works/chord";
import { applySqliteMigrations, type SqliteDatabase, type SqliteMigration } from "@earendil-works/chord/sqlite";
import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import { Type } from "typebox";
import {
	AgentToolGroups,
	HostPaths,
	McpContract,
	McpServerInputSchema,
	McpServerStateSchema,
	Panels,
} from "@moonan_ai/contracts";
import { MCP_AGENT_ID, McpService } from "./service.js";

const PLUGIN_ID = "mcp";

const MIGRATIONS: SqliteMigration[] = [
	{
		version: 1,
		statements: [
			`CREATE TABLE servers (
				id TEXT PRIMARY KEY,
				payload TEXT NOT NULL,
				enabled INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
			)`,
			`CREATE TABLE tools (
				server_id TEXT NOT NULL,
				tool_name TEXT NOT NULL,
				enabled INTEGER NOT NULL,
				PRIMARY KEY (server_id, tool_name)
			)`,
		],
	},
];

/** Servers and their connection pool, owned by the plugin. */
const McpStore = local("moonan.mcp.store", {
	version: 1,
	input: Type.Object({}),
	members: {
		servers: Type.Array(McpServerStateSchema),
		add: method(McpServerInputSchema, McpServerStateSchema),
		remove: method(Type.Object({ id: Type.String() })),
		setToolEnabled: method(Type.Object({ server: Type.String(), tool: Type.String(), enabled: Type.Boolean() })),
		reconnect: method(Type.Object({ id: Type.String() })),
	},
});

export default defineFacet((api) => {
	api.serve(
		McpStore,
		(_input, _principal, self) => {
			const paths = self.get(HostPaths, {});
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
			// The pool survives a reload: its connections are native objects, and
			// `version` says when its code changed enough to replace them.
			const service = self.resource<McpService>("pool", {
				version: 1,
				deps: [db],
				open: async () => new McpService(db.value),
				close: (pool) => pool.dispose(),
			});
			// Connecting is restartable background work: a reload restarts this task and
			// `restore()` is idempotent, so the pool is never rebuilt just to reconnect.
			self.task(async () => {
				await service.value.restore();
			});
			const servers = self.state("servers", Type.Array(McpServerStateSchema), {
				init: () => service.value.list(),
			});
			self.register(Panels, { mcp: { id: "mcp", titleKey: "nav.mcp", order: 50 } });
			self.register(AgentToolGroups, {
				mcp: { agents: [MCP_AGENT_ID], tools: () => service.value.currentTools() },
			});
			// A resource whose value is an event source: `self.on` subscribes once it opens.
			self.on("servers", service, () => {
				void api
					.root((ctx) => {
						servers.replace(ctx, service.value.list(), { diff: true });
					})
					.catch(() => undefined);
			});
			return {
				servers,
				add: async (input: Parameters<McpService["add"]>[0]) => {
					return service.value.add(input);
				},
				remove: async (args: { id: string }) => {
					await service.value.remove(args.id);
				},
				setToolEnabled: async (args: { server: string; tool: string; enabled: boolean }) => {
					await service.value.setToolEnabled(args.server, args.tool, args.enabled);
				},
				reconnect: async (args: { id: string }) => {
					await service.value.reconnect(args.id);
				},
			};
		},
		{ lifetime: "host" },
	);

	api.serve(McpContract, (_input, _principal, self) => {
		const store = self.get(McpStore, {});
		const servers = self.state("servers", Type.Array(McpServerStateSchema), { init: () => store.servers.value });
		self.on("servers", store.servers, (list, ctx) => {
			servers.replace(ctx, list, { diff: true });
		});
		return {
			variant: "v1" as const,
			servers,
			addServer: (input: Parameters<McpService["add"]>[0]) => store.add(input),
			removeServer: ({ id }: { id: string }) => store.remove({ id }),
			setToolEnabled: (args: { server: string; tool: string; enabled: boolean }) => store.setToolEnabled(args),
			reconnect: ({ id }: { id: string }) => store.reconnect({ id }),
		};
	});
});
