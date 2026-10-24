import { spawnSync } from "node:child_process";
import { startStack } from "./stack.mjs";

const port = Number(process.env.MOONAN_PORT ?? 21315);

/** Everything the browser loads must exist before the first page load. */
function build(stepArgs) {
	const result = spawnSync("pnpm", stepArgs, { stdio: "inherit" });
	if (result.status !== 0) process.exit(result.status ?? 1);
}

build(["-r", "--filter", "@moonan_ai/contracts", "--filter", "@moonan_ai/web-api", "--filter", "@moonan_ai/plugin-*", "build"]);
build(["--dir", "packages/web", "build"]);

const stack = await startStack({
	port,
	watch: true,
	dataDir: process.env.MOONAN_DATA_DIR ?? undefined,
});

console.log(`\n  Moonan dev\n  app   ${stack.url}\n`);

let closing = false;
const shutdown = async () => {
	if (closing) return;
	closing = true;
	await stack.stop();
	process.exit(0);
};

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
