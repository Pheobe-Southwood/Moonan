import { build } from "esbuild";
import { fileURLToPath } from "node:url";

/**
 * The browser facet is one ESM file. Everything the shell already shares through its
 * import map stays external: a second React instance makes hooks throw, and a second
 * Chord/SDK pair would put two identity worlds in one page.
 */
const root = fileURLToPath(new URL("..", import.meta.url));

await build({
	absWorkingDir: root,
	entryPoints: ["src/web/web.tsx"],
	outfile: "dist/web.js",
	bundle: true,
	format: "esm",
	platform: "browser",
	target: "es2022",
	jsx: "automatic",
	sourcemap: false,
	legalComments: "none",
	define: { "process.env.NODE_ENV": '"production"' },
	external: [
		"react",
		"react/jsx-runtime",
		"react-dom",
		"react-dom/client",
		"@earendil-works/chord",
		"@earendil-works/chord/context",
		"@earendil-works/chord/output",
		"typebox",
		"typebox/value",
		"@moonan_ai/sdk",
		"@moonan_ai/sdk/web",
	],
	logLevel: "warning",
});

console.log("ai-gateway web facet: dist/web.js");
