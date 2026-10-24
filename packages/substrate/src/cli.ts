import { createLogger } from "./logger.js";
import { defaultPluginsDir, start, VERSION } from "./index.js";

const HELP = `moonan — a zero-data plugin substrate

Usage
  moonan [options]

Options
  -p, --port <port>        Port to listen on                  (default 21315)
  -H, --hostname <host>    Address to bind                    (default 127.0.0.1)
      --plugins-dir <dir>  Scan for plugin directories        (default ~/.moonan/plugins)
  -P, --plugin <ref>       Load a plugin: package name or directory (repeatable)
      --web-dist <dir>     Serve a built shell from <dir>     (default: the bundled one)
  -h, --help               Show this help
  -v, --version            Print the version

The substrate stores nothing: no database, no config file. A plugin that needs to keep
data owns its own storage; this process only hosts and serves.
`;

interface Args {
	port?: number;
	hostname?: string;
	pluginsDir?: string;
	plugins: string[];
	webDist?: string;
	help: boolean;
	version: boolean;
}

function parse(argv: readonly string[]): Args {
	const args: Args = { plugins: [], help: false, version: false };
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
			case "-P":
			case "--plugin":
				args.plugins.push(next());
				break;
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
	const moonan = await start({
		...(args.port !== undefined ? { port: args.port } : {}),
		...(args.hostname !== undefined ? { hostname: args.hostname } : {}),
		...(args.pluginsDir !== undefined ? { pluginsDir: args.pluginsDir } : {}),
		...(args.webDist !== undefined ? { webDist: args.webDist } : {}),
		plugins: args.plugins,
		logger,
	});

	logger.info(`Moonan ${VERSION} listening on ${moonan.url}`);
	logger.info(`plugins directory: ${args.pluginsDir ?? defaultPluginsDir()} (read-only)`);
	if (moonan.plugins.length === 0) {
		logger.warn("no plugins loaded: pass --plugin <package|dir>, or drop directories into the plugins directory");
	}
	for (const plugin of moonan.plugins) {
		if (plugin.error) logger.warn(`plugin "${plugin.id}" failed: ${plugin.error}`);
		else logger.info(`plugin "${plugin.id}" ${plugin.version} (${plugin.source}${plugin.web ? ", web" : ""})`);
	}
	const hostname = args.hostname ?? "127.0.0.1";
	if (!/^(127\.|::1$|localhost$)/.test(hostname)) {
		logger.warn(`bound to ${hostname}: the interface has no authentication, so anyone who can reach this port can drive every plugin`);
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
