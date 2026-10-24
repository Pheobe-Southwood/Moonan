import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build, context } from "esbuild";

/**
 * Builds the modules the import map in `index.html` points at.
 *
 * Chord ships no browser loader and React is CJS, so a browser facet cannot import
 * `react` or `@earendil-works/chord` directly. Each entry here is a tiny wrapper that
 * is bundled into one self-contained ESM file; the import map then makes every plugin
 * share the shell's single copy of each module.
 */
const outdir = fileURLToPath(new URL("../public/runtime/", import.meta.url));
const resolveDir = fileURLToPath(new URL("..", import.meta.url));

const REACT_EXPORTS = [
	"Children",
	"Component",
	"Fragment",
	"Profiler",
	"PureComponent",
	"StrictMode",
	"Suspense",
	"cloneElement",
	"createContext",
	"createElement",
	"createFactory",
	"createRef",
	"forwardRef",
	"isValidElement",
	"lazy",
	"memo",
	"startTransition",
	"use",
	"useCallback",
	"useContext",
	"useDebugValue",
	"useDeferredValue",
	"useEffect",
	"useId",
	"useImperativeHandle",
	"useInsertionEffect",
	"useLayoutEffect",
	"useMemo",
	"useReducer",
	"useRef",
	"useState",
	"useSyncExternalStore",
	"useTransition",
	"version",
].join(", ");

const ENTRIES = [
	{
		name: "react",
		external: [],
		contents: `import React from "react";\nexport default React;\nexport const { ${REACT_EXPORTS} } = React;`,
	},
	{
		name: "jsx-runtime",
		external: [],
		contents: 'import * as runtime from "react/jsx-runtime";\nexport const { Fragment, jsx, jsxs } = runtime;\nexport default runtime;',
	},
	{
		name: "react-dom",
		external: ["react"],
		contents:
			'import ReactDOM from "react-dom";\nimport { createRoot, hydrateRoot } from "react-dom/client";\nexport default ReactDOM;\nexport const { createPortal, flushSync, version } = ReactDOM;\nexport { createRoot, hydrateRoot };',
	},
	{ name: "typebox", external: [], contents: 'export * from "typebox";' },
	{
		name: "chord",
		external: ["typebox"],
		contents: 'export * from "@earendil-works/chord";',
	},
	{
		name: "chord-output",
		external: ["typebox", "@earendil-works/chord"],
		contents: 'export * from "@earendil-works/chord/output";',
	},
	{
		name: "contracts",
		external: ["@earendil-works/chord", "typebox"],
		contents: 'export * from "@moonan_ai/contracts";',
	},
	{
		name: "web-api",
		external: ["react", "react/jsx-runtime", "@earendil-works/chord", "typebox", "@moonan_ai/contracts"],
		contents: 'export * from "@moonan_ai/web-api";',
	},
];

const watch = process.argv.includes("--watch");

await mkdir(outdir, { recursive: true });

for (const entry of ENTRIES) {
	const options = {
		stdin: {
			contents: entry.contents,
			resolveDir,
			sourcefile: `${entry.name}.js`,
			loader: "js",
		},
		bundle: true,
		format: "esm",
		platform: "browser",
		target: "es2022",
		outfile: join(outdir, `${entry.name}.js`),
		external: entry.external,
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
	console.log(`runtime/${entry.name}.js`);
}
