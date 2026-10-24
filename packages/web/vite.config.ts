import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * Bare specifiers the browser resolves through the import map in `index.html`.
 *
 * They stay external so the shell and every runtime-loaded plugin share one instance
 * of React, Chord, TypeBox and the contracts. The bundles in `public/runtime` are
 * produced by `scripts/build-runtime.mjs` before this build runs.
 */
const SHARED = [
	"react",
	"react/jsx-runtime",
	"react-dom",
	"react-dom/client",
	"@earendil-works/chord",
	"@earendil-works/chord/output",
	"typebox",
	"@moonan_ai/contracts",
	"@moonan_ai/web-api",
];

export default defineConfig({
	plugins: [react()],
	build: {
		outDir: "dist",
		emptyOutDir: true,
		target: "es2022",
		rollupOptions: { external: SHARED },
	},
});
