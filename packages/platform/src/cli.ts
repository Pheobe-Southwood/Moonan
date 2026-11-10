import { createLogger } from "./logger.js";
import {
	defaultPluginsDir,
	defaultPluginsFile,
	isLoopback,
	officialPlugins,
	PluginRegistry,
	resolvePluginRef,
	start,
	VERSION,
	type Moonan,
	type OfficialPluginRef,
	type RegistryEntry,
} from "./index.js";
import { normalizeRef } from "./plugins.js";

const HELP = `moonan — a local plugin platform

Usage
  moonan [options]
  moonan plugins <list|add|enable|disable|remove> [options]

Options
  -p, --port <port>        Port to listen on                  (default 21315)
  -H, --hostname <host>    Address to bind                    (default 127.0.0.1)
      --plugins-dir <dir>  Scan for plugin directories        (default ~/.moonan/plugins)
      --plugins-file <path> Plugin registry file              (default ~/.moonan/plugins.json)
      --data-file <path>   Unified plugin data file           (default ~/.moonan/data.json)
  -P, --plugin <ref>       Add a plugin for this process only (repeatable)
      --no-official        Do not load the built-in official plugins
      --safe-mode          Load only the locked official plugins (recovery shell)
      --allow-management   Enable the plugin-management API beyond loopback
      --dev                Validate every cell write against its schema (development)
      --allow-origin <o>   Accept this browser origin besides same-origin (repeatable)
      --max-calls <n>      Max concurrent calls per WebSocket link (default: no limit)
      --web-dist <dir>     Serve a built shell from <dir>     (default: the bundled one)
  -h, --help               Show this help
  -v, --version            Print the version

Plugin management
  The official plugins are declared in this package's manifest and installed as optional
  dependencies; \`moonan\` loads them without --plugin. The 插件 page in the UI lists every
  plugin and can enable, disable, add (register) and remove entries.

  \`moonan plugins list\` and the other subcommands edit ~/.moonan/plugins.json without
  starting the server. They are the recovery path when a plugin breaks startup:
    moonan plugins list
    moonan plugins disable <ref>     (--force for a locked entry)
    moonan plugins add ./my-plugin --disabled

Data
  The platform keeps exportable plugin data in one JSON file. A plugin registers a data
  codec to make its namespace part of export/import; private caches may still use their own
  files. The platform itself contains no feature semantics.

  The plugin registry (\`plugins.json\`) is engine configuration, not plugin data: it is not
  part of /api/data/export, so importing a bundle can never change which plugins load.

Security
  There is no account authentication. Cross-origin WebSocket connections and the built-in
  reload endpoint are refused unless their origin is same-origin or listed with
  --allow-origin. The plugin-management API is limited to a loopback bind unless
  --allow-management is passed.
`;

interface Args {
	port?: number;
	hostname?: string;
	pluginsDir?: string;
	pluginsFile?: string;
	dataFile?: string;
	plugins: string[];
	official: boolean;
	safeMode: boolean;
	allowManagement: boolean;
	dev: boolean;
	allowedOrigins: string[];
	maxCalls?: number;
	webDist?: string;
	help: boolean;
	version: boolean;
}

function valueOf(argv: readonly string[], index: number, flag: string): { value: string; index: number } {
	const value = argv[index + 1];
	if (value === undefined) throw new Error(`${flag} needs a value`);
	return { value, index: index + 1 };
}

function parse(argv: readonly string[]): Args {
	const args: Args = {
		plugins: [],
		official: true,
		safeMode: false,
		allowManagement: false,
		dev: false,
		allowedOrigins: [],
		help: false,
		version: false,
	};
	for (let index = 0; index < argv.length; index += 1) {
		const flag = argv[index]!;
		switch (flag) {
			case "-p":
			case "--port": {
				const next = valueOf(argv, index, flag);
				index = next.index;
				const port = Number(next.value);
				if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`invalid port: ${next.value}`);
				args.port = port;
				break;
			}
			case "-H":
			case "--hostname": {
				const next = valueOf(argv, index, flag);
				index = next.index;
				args.hostname = next.value;
				break;
			}
			case "--plugins-dir": {
				const next = valueOf(argv, index, flag);
				index = next.index;
				args.pluginsDir = next.value;
				break;
			}
			case "--plugins-file": {
				const next = valueOf(argv, index, flag);
				index = next.index;
				args.pluginsFile = next.value;
				break;
			}
			case "--data-file": {
				const next = valueOf(argv, index, flag);
				index = next.index;
				args.dataFile = next.value;
				break;
			}
			case "-P":
			case "--plugin": {
				const next = valueOf(argv, index, flag);
				index = next.index;
				args.plugins.push(next.value);
				break;
			}
			case "--no-official":
				args.official = false;
				break;
			case "--safe-mode":
				args.safeMode = true;
				break;
			case "--allow-management":
				args.allowManagement = true;
				break;
			case "--dev":
				args.dev = true;
				break;
			case "--allow-origin": {
				const next = valueOf(argv, index, flag);
				index = next.index;
				args.allowedOrigins.push(next.value);
				break;
			}
			case "--max-calls": {
				const next = valueOf(argv, index, flag);
				index = next.index;
				const value = Number(next.value);
				if (!Number.isInteger(value) || value < 1) throw new Error(`invalid max-calls: ${next.value}`);
				args.maxCalls = value;
				break;
			}
			case "--web-dist": {
				const next = valueOf(argv, index, flag);
				index = next.index;
				args.webDist = next.value;
				break;
			}
			case "-h":
			case "--help":
				args.help = true;
				break;
			case "-v":
			case "--version":
				args.version = true;
				break;
			default:
				throw new Error(`unknown option: ${flag}`);
		}
	}
	return args;
}

interface PluginsArgs {
	command: "list" | "add" | "enable" | "disable" | "remove";
	target?: string;
	json: boolean;
	disabled: boolean;
	force: boolean;
	pluginsFile?: string;
}

function parsePluginsArgs(argv: readonly string[]): PluginsArgs {
	const command = argv[0];
	if (command !== "list" && command !== "add" && command !== "enable" && command !== "disable" && command !== "remove") {
		throw new Error(`unknown plugins command: ${command ?? "(none)"}. Try \`moonan plugins list\`.`);
	}
	const result: PluginsArgs = { command, json: false, disabled: false, force: false };
	for (let index = 1; index < argv.length; index += 1) {
		const flag = argv[index]!;
		switch (flag) {
			case "--json":
				result.json = true;
				break;
			case "--disabled":
				result.disabled = true;
				break;
			case "--force":
				result.force = true;
				break;
			case "--plugins-file": {
				const next = valueOf(argv, index, flag);
				index = next.index;
				result.pluginsFile = next.value;
				break;
			}
			default:
				if (flag.startsWith("-")) throw new Error(`unknown option: ${flag}`);
				if (result.target !== undefined) throw new Error(`unexpected argument: ${flag}`);
				result.target = flag;
		}
	}
	if (command !== "list" && (result.target === undefined || result.target.trim().length === 0)) {
		throw new Error(`\`moonan plugins ${command}\` needs a plugin ref`);
	}
	return result;
}

/** The persisted selection merged with the official defaults (official entries are implicit). */
async function loadPlugins(pluginsFile: string): Promise<{
	registry: PluginRegistry;
	official: Map<string, OfficialPluginRef>;
	entries: Map<string, RegistryEntry>;
}> {
	const registry = await PluginRegistry.open(pluginsFile);
	const official = new Map(officialPlugins().map((item) => [item.ref, item]));
	const entries = new Map<string, RegistryEntry>();
	for (const entry of registry.entries()) entries.set(entry.ref, { ...entry });
	for (const item of official.values()) {
		if (!entries.has(item.ref)) entries.set(item.ref, { ref: item.ref, enabled: true });
	}
	return { registry, official, entries };
}

async function savePlugins(registry: PluginRegistry, entries: Map<string, RegistryEntry>): Promise<void> {
	await registry.replace([...entries.values()]);
}

function describeTarget(entries: Map<string, RegistryEntry>, target: string): RegistryEntry | undefined {
	const normalized = normalizeRef(target, process.cwd());
	return entries.get(target) ?? entries.get(normalized);
}

async function runPlugins(argv: readonly string[]): Promise<void> {
	const args = parsePluginsArgs(argv);
	const pluginsFile = args.pluginsFile ?? defaultPluginsFile();
	const { registry, official, entries } = await loadPlugins(pluginsFile);
	if (registry.warning()) console.error(`moonan: ${registry.warning()}`);

	if (args.command === "list") {
		const rows = [...entries.values()].map((entry) => {
			const facets = resolvePluginRef(entry.ref, process.cwd());
			return {
				ref: entry.ref,
				enabled: entry.enabled,
				builtin: official.has(entry.ref),
				locked: official.get(entry.ref)?.locked === true,
				name: facets.name,
				version: facets.version,
				source: facets.source,
				error: facets.error,
			};
		});
		if (args.json) {
			process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
			return;
		}
		for (const row of rows) {
			const kind = row.locked ? "locked" : row.builtin ? "builtin" : row.source;
			const state = row.enabled ? "enabled " : "disabled";
			const detail = row.error ? `  error: ${row.error}` : "";
			process.stdout.write(`${state}  ${kind.padEnd(8)}  ${row.ref}  (${row.name}@${row.version})${detail}\n`);
		}
		return;
	}

	const target = args.target!;
	const entry = describeTarget(entries, target);
	if (args.command === "add") {
		const normalized = normalizeRef(target, process.cwd());
		if (entries.has(normalized)) throw new Error(`plugin "${normalized}" is already registered`);
		const facets = resolvePluginRef(normalized, process.cwd());
		if (facets.error !== undefined) throw new Error(`cannot load "${normalized}": ${facets.error}`);
		entries.set(normalized, { ref: normalized, enabled: !args.disabled });
		await savePlugins(registry, entries);
		process.stdout.write(`${args.disabled ? "added (disabled)" : "added"}: ${normalized}\n`);
		return;
	}
	if (!entry) throw new Error(`unknown plugin: ${target}`);
	if (args.command === "enable" || args.command === "disable") {
		const enabled = args.command === "enable";
		if (!enabled && official.get(entry.ref)?.locked === true && !args.force) {
			throw new Error(`"${entry.ref}" is locked; pass --force to disable it anyway`);
		}
		entry.enabled = enabled;
		await savePlugins(registry, entries);
		process.stdout.write(`${enabled ? "enabled" : "disabled"}: ${entry.ref}\n`);
		return;
	}
	if (official.has(entry.ref)) {
		// Seeded on every start, so removing it from the file would be undone immediately.
		throw new Error(`"${entry.ref}" is built in and seeded on every start; disable it instead`);
	}
	entries.delete(entry.ref);
	await savePlugins(registry, entries);
	process.stdout.write(`removed: ${entry.ref}\n`);
}

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	if (argv[0] === "plugins") {
		try {
			await runPlugins(argv.slice(1));
		} catch (error) {
			console.error(`moonan: ${error instanceof Error ? error.message : String(error)}`);
			process.exitCode = 1;
		}
		return;
	}

	let args: Args;
	try {
		args = parse(argv);
	} catch (error) {
		console.error(`moonan: ${error instanceof Error ? error.message : String(error)}`);
		console.error("Try `moonan --help`.");
		process.exitCode = 2;
		return;
	}

	if (args.help) {
		process.stdout.write(HELP);
		return;
	}
	if (args.version) {
		process.stdout.write(`${VERSION}\n`);
		return;
	}

	const logger = createLogger();
	let moonan: Moonan;
	try {
		moonan = await start({
			...(args.port !== undefined ? { port: args.port } : {}),
			...(args.hostname !== undefined ? { hostname: args.hostname } : {}),
			...(args.pluginsDir !== undefined ? { pluginsDir: args.pluginsDir } : {}),
			...(args.pluginsFile !== undefined ? { pluginsFile: args.pluginsFile } : {}),
			...(args.dataFile !== undefined ? { dataFile: args.dataFile } : {}),
			...(args.webDist !== undefined ? { webDist: args.webDist } : {}),
			...(args.dev ? { dev: true } : {}),
			...(args.allowedOrigins.length > 0 ? { allowedOrigins: args.allowedOrigins } : {}),
			...(args.maxCalls !== undefined ? { maxCalls: args.maxCalls } : {}),
			official: args.official,
			safeMode: args.safeMode,
			allowManagement: args.allowManagement,
			plugins: args.plugins,
			logger,
		});
	} catch (error) {
		// A failed facet batch is fatal by design: chord's install is not a rollback
		// transaction, so continuing would run a half-installed host.
		logger.error("startup failed", error);
		process.exitCode = 1;
		return;
	}

	const hostname = args.hostname ?? "127.0.0.1";
	logger.info(`Moonan ${VERSION} listening on ${moonan.url}`);
	logger.info(`plugin registry: ${moonan.pluginsFile}`);
	logger.info(`plugins directory: ${args.pluginsDir ?? defaultPluginsDir()} (read-only scan)`);
	logger.info(`unified data file: ${moonan.dataFile}`);
	if (args.dev) logger.info("dev mode: every cell write is validated against its schema");
	if (args.safeMode) logger.warn("safe mode: only the locked official plugins are enabled");
	if (args.maxCalls !== undefined) logger.info(`websocket call limit: ${args.maxCalls} concurrent calls per link`);
	if (args.allowedOrigins.length > 0) logger.info(`extra browser origins: ${args.allowedOrigins.join(", ")}`);
	if (moonan.startup?.degraded) {
		logger.warn(
			`started with a reduced plugin set (${moonan.startup.skipped.join(", ")}); the registry was not changed. Use the 插件 page or \`moonan plugins\` to recover.`,
		);
	}
	if (moonan.plugins.length === 0) {
		logger.warn("no plugins resolved: pass --plugin <package|dir>, or use the 插件 page to add one");
	}
	for (const plugin of moonan.plugins) {
		if (plugin.startupSkipped) logger.warn(`plugin "${plugin.name}" skipped by degraded startup`);
		else if (plugin.error) logger.warn(`plugin "${plugin.name}" failed: ${plugin.error}`);
		else if (!plugin.enabled) logger.info(`plugin "${plugin.name}" ${plugin.version} (disabled)`);
		else logger.info(`plugin "${plugin.name}" ${plugin.version} (${plugin.source}${plugin.web ? ", web" : ""})`);
	}
	if (!isLoopback(hostname) && !args.allowManagement) {
		logger.warn("plugin management API is disabled on a non-loopback bind; pass --allow-management to enable it");
	}
	if (!isLoopback(hostname)) {
		logger.warn(
			`bound to ${hostname}: there is no account authentication, so anyone who can reach this port can drive every plugin (cross-origin browsers are refused, but this is not a security boundary)`,
		);
	}

	let closing = false;
	const shutdown = (signal: string) => {
		if (closing) return;
		closing = true;
		logger.info(`${signal}: shutting down`);
		void moonan
			.close()
			.catch((error: unknown) => logger.error("shutdown failed", error))
			.finally(() => process.exit(0));
	};
	process.on("SIGINT", () => shutdown("SIGINT"));
	process.on("SIGTERM", () => shutdown("SIGTERM"));
}

await main();
