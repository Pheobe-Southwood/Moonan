#!/usr/bin/env node
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * The published entry point.
 *
 * A built package runs `dist/cli.js`. A source checkout (`pnpm dev`, or a local link) has
 * no `dist` yet, so it registers tsx and runs `src/cli.ts` — the same trade the rest of
 * the tree makes with `--conditions=development`.
 */
const built = new URL("../dist/cli.js", import.meta.url);
const source = new URL("../src/cli.ts", import.meta.url);

if (existsSync(fileURLToPath(built))) {
	await import(built.href);
} else if (existsSync(fileURLToPath(source))) {
	const { register } = await import("tsx/esm/api");
	register();
	await import(source.href);
} else {
	console.error("moonan: no built entry (dist/cli.js) and no source entry (src/cli.ts)");
	process.exit(1);
}
