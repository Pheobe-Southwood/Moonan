import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build, context } from "esbuild";

/**
 * Builds the modules the import map in `index.html` points at.
 *
 * Chord ships no browser loader and React is CJS, so a browser facet cannot import
 * `react` or `@earendil-works/chord` directly. Each entry below is generated from the
 * specifier it re-exports, and **all of them are built in one pass with splitting**:
 * that is what makes the shell, `react-dom` and every plugin share exactly one copy of
 * React and one copy of Chord. Bundling `react-dom` with `react` external does not work
 * — its CJS build calls `require("react")`, which esbuild cannot turn into an ESM import.
 */
const entries = {
	react: 'export * from "react";',
	"jsx-runtime": 'export * from "react/jsx-runtime";',
	"react-dom": 'export * from "react-dom";\nexport * from "react-dom/client";',
	typebox: 'export * from "typebox";',
	// Chord imports this deep entry directly; a plugin may want it too.
	"typebox-value": 'export * from "typebox/value";',
	chord: 'export * from "@earendil-works/chord";',
	"chord-output": 'export * from "@earendil-works/chord/output";',
	contracts: 'export * from "@moonan_ai/contracts";',
	"web-api": 'export * from "@moonan_ai/web-api";',
};

const packageDir = fileURLToPath(new URL("..", import.meta.url));
const entryDir = join(packageDir, ".runtime-entries");
const outdir = join(packageDir, "public", "runtime");
const watch = process.argv.includes("--watch");

await rm(entryDir, { recursive: true, force: true });
await rm(outdir, { recursive: true, force: true });
await mkdir(entryDir, { recursive: true });
await mkdir(outdir, { recursive: true });

const entryPoints = {};
for (const [name, contents] of Object.entries(entries)) {
	const file = join(entryDir, `${name}.js`);
	await writeFile(file, `${contents}\n`);
	entryPoints[name] = file;
}

const options = {
	entryPoints,
	outdir,
	bundle: true,
	splitting: true,
	format: "esm",
	platform: "browser",
	target: "es2022",
	entryNames: "[name]",
	chunkNames: "chunk-[hash]",
	define: { "process.env.NODE_ENV": '"production"' },
	logLevel: "warning",
};

if (watch) {
	// First build eagerly so the shell never copies an empty directory.
	const ctx = await context(options);
	await ctx.rebuild();
	await ctx.watch();
} else {
	await build(options);
}
console.log(`runtime entries: ${Object.keys(entries).join(", ")}`);
