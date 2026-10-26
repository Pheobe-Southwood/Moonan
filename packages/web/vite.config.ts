import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * Bare specifiers the browser resolves through the import map in `index.html`.
 *
 * They stay external so the shell and every runtime-loaded plugin share one instance of
 * React, Chord, TypeBox and the SDK. The bundles in `public/runtime` are produced by
 * `scripts/build-runtime.mjs`, which runs before this build.
 */
const SHARED = [
	"react",
	"react/jsx-runtime",
	"react-dom",
	"react-dom/client",
	"@earendil-works/chord",
	"@earendil-works/chord/context",
	"@earendil-works/chord/delta",
	"@earendil-works/chord/output",
	"typebox",
	"typebox/value",
	"@moonan_ai/sdk",
	"@moonan_ai/sdk/web",
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
