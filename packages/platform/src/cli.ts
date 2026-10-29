import { createLogger } from "./logger.js";
import { defaultPluginsDir, start, VERSION, type Moonan } from "./index.js";

const HELP = `moonan — a local plugin platform

Usage
  moonan [options]

Options
  -p, --port <port>        Port to listen on                  (default 21315)
  -H, --hostname <host>    Address to bind                    (default 127.0.0.1)
      --plugins-dir <dir>  Scan for plugin directories        (default ~/.moonan/plugins)
      --data-file <path>   Unified plugin data file            (default ~/.moonan/data.json)
  -P, --plugin <ref>       Resolve a plugin: package name or directory (repeatable)
      --dev                Validate every cell write against its schema (development)
      --allow-origin <o>   Accept this browser origin besides same-origin (repeatable)
      --max-calls <n>      Max concurrent calls per WebSocket link (default: no limit)
      --web-dist <dir>     Serve a built shell from <dir>     (default: the bundled one)
  -h, --help               Show this help
  -v, --version            Print the version

The platform keeps exportable plugin data in one JSON file. A plugin registers a data
codec to make its namespace part of export/import; private caches may still use their own
files. The platform itself contains no feature semantics.

There is no account authentication. Cross-origin WebSocket connections and the built-in
reload endpoint are refused unless their origin is same-origin or listed with
--allow-origin.
`;

interface Args {
	port?: number;
	hostname?: string;
	pluginsDir?: string;
	dataFile?: string;
	plugins: string[];
	dev: boolean;
	allowedOrigins: string[];
	maxCalls?: number;
	webDist?: string;
	help: boolean;
	version: boolean;
}

function parse(argv: readonly string[]): Args {
	const args: Args = { plugins: [], dev: false, allowedOrigins: [], help: false, version: false };
	for (let index = 0; index < argv.length; index += 1) {
		const flag = argv[index];
		const next = (): string => {
			const value = argv[index + 1];
			if (value === undefined) throw new Error(`${flag} needs a value`);
			index += 1;
			return value;
		};
		switch (flag) {
			case "-p":
			case "--port": {
				const raw = next();
				const port = Number(raw);
				if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`invalid port: ${raw}`);
				args.port = port;
				break;
			}
			case "-H":
			case "--hostname":
				args.hostname = next();
				break;
			case "--plugins-dir":
				args.pluginsDir = next();
				break;
			case "--data-file":
				args.dataFile = next();
				break;
			case "-P":
			case "--plugin":
				args.plugins.push(next());
				break;
			case "--dev":
				args.dev = true;
				break;
			case "--allow-origin":
				args.allowedOrigins.push(next());
				break;
			case "--max-calls": {
				const raw = next();
				const value = Number(raw);
				if (!Number.isInteger(value) || value < 1) throw new Error(`invalid max-calls: ${raw}`);
				args.maxCalls = value;
				break;
			}
			case "--web-dist":
				args.webDist = next();
				break;
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

async function main(): Promise<void> {
	let args: Args;
	try {
		args = parse(process.argv.slice(2));
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
			...(args.dataFile !== undefined ? { dataFile: args.dataFile } : {}),
			...(args.webDist !== undefined ? { webDist: args.webDist } : {}),
			...(args.dev ? { dev: true } : {}),
			...(args.allowedOrigins.length > 0 ? { allowedOrigins: args.allowedOrigins } : {}),
			...(args.maxCalls !== undefined ? { maxCalls: args.maxCalls } : {}),
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

	logger.info(`Moonan ${VERSION} listening on ${moonan.url}`);
	logger.info(`plugins directory: ${args.pluginsDir ?? defaultPluginsDir()} (read-only)`);
	logger.info(`unified data file: ${moonan.dataFile}`);
	if (args.dev) logger.info("dev mode: every cell write is validated against its schema");
	if (args.maxCalls !== undefined) logger.info(`websocket call limit: ${args.maxCalls} concurrent calls per link`);
	if (args.allowedOrigins.length > 0) logger.info(`extra browser origins: ${args.allowedOrigins.join(", ")}`);
	if (moonan.plugins.length === 0) {
		logger.warn("no plugins resolved: pass --plugin <package|dir>, or drop directories into the plugins directory");
	}
	for (const plugin of moonan.plugins) {
		if (plugin.error) logger.warn(`plugin "${plugin.name}" failed: ${plugin.error}`);
		else logger.info(`plugin "${plugin.name}" ${plugin.version} (${plugin.source}${plugin.web ? ", web" : ""})`);
	}
	const hostname = args.hostname ?? "127.0.0.1";
	if (!/^(127\.|::1$|localhost$)/.test(hostname)) {
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
