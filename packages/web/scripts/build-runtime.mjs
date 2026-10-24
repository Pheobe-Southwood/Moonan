import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build, context } from "esbuild";

/**
 * Builds the modules the import map in `index.html` points at.
 *
 * A plugin's browser facet is `import()`ed at runtime, so it cannot be bundled with the
 * shell: it has to resolve `react`, `@earendil-works/chord` and `@moonan_ai/sdk` through
 * the import map instead. That only works if the shell and every plugin share one copy
 * of each — a second React makes hooks throw, a second Chord makes the `Panels` token
 * different, and both failures look like "the panel does not appear" rather than an error.
 *
 * So every entry below is built in **one pass with splitting**: shared code lands in
 * `chunk-*.js` and both the shell and the plugins reach the same module instance.
 *
 * `react` and `react-dom` ship CJS, so their entries re-export the names explicitly —
 * `export *` from a CJS module yields a namespace object, not the static named exports a
 * browser facet needs for `import { useState } from "react"`.
 */
const REACT_NAMES = [
	"Children", "Component", "Fragment", "Profiler", "PureComponent", "StrictMode", "Suspense",
	"cloneElement", "createContext", "createElement", "createFactory", "createRef", "forwardRef",
	"isValidElement", "lazy", "memo", "startTransition", "use", "useCallback", "useContext",
	"useDebugValue", "useDeferredValue", "useEffect", "useId", "useImperativeHandle",
	"useInsertionEffect", "useLayoutEffect", "useMemo", "useReducer", "useRef", "useState",
	"useSyncExternalStore", "useTransition", "version",
];

const entries = {
	react: `import React from "react";\nexport default React;\nexport const { ${REACT_NAMES.join(", ")} } = React;`,
	"jsx-runtime":
		'import runtime from "react/jsx-runtime";\nexport const Fragment = runtime.Fragment;\nexport const jsx = runtime.jsx;\nexport const jsxs = runtime.jsxs;\nexport default runtime;',
	"react-dom":
		'import ReactDOM from "react-dom";\nimport client from "react-dom/client";\nexport const createRoot = client.createRoot;\nexport const hydrateRoot = client.hydrateRoot;\nexport const createPortal = ReactDOM.createPortal;\nexport const flushSync = ReactDOM.flushSync;\nexport const version = ReactDOM.version;\nexport default ReactDOM;',
	typebox: 'export * from "typebox";',
	// Chord imports this deep entry itself; a plugin may want it for schema validation.
	"typebox-value": 'export * from "typebox/value";',
	chord: 'export * from "@earendil-works/chord";',
	"chord-output": 'export * from "@earendil-works/chord/output";',
	sdk: 'export * from "@moonan_ai/sdk";',
	"sdk-web": 'export * from "@moonan_ai/sdk/web";',
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
	// Build once eagerly: watch mode must not leave the shell copying an empty directory.
	const ctx = await context(options);
	await ctx.rebuild();
	await ctx.watch();
} else {
	await build(options);
}
console.log(`runtime entries: ${Object.keys(entries).join(", ")}`);
