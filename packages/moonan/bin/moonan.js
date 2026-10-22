#!/usr/bin/env node
import { main } from "../dist/cli.js";

main().catch((error) => {
	console.error(error instanceof Error ? error.stack ?? error.message : error);
	process.exitCode = 1;
});
