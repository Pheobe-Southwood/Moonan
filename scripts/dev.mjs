import { startStack } from "./stack.mjs";

const nodePort = Number(process.env.MOONAN_NODE_PORT ?? 21316);
const webPort = Number(process.env.MOONAN_PORT ?? 21315);

const stack = await startStack({
	nodePort,
	webPort,
	dataDir: process.env.MOONAN_DATA_DIR ?? undefined,
});

console.log(`\n  Moonan dev\n  web   ${stack.url}\n  node  http://127.0.0.1:${nodePort}\n`);

let closing = false;
const shutdown = async () => {
	if (closing) return;
	closing = true;
	await stack.stop();
	process.exit(0);
};

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
