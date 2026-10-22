import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const NODE_PORT = Number(process.env.MOONAN_NODE_PORT ?? 21316);

export default defineConfig(({ mode }) => ({
	plugins: [react()],
	server: {
		port: 21315,
		strictPort: true,
		proxy: {
			"/ws": { target: `ws://127.0.0.1:${NODE_PORT}`, ws: true },
			"/api": { target: `http://127.0.0.1:${NODE_PORT}`, changeOrigin: false },
			"/plugins": { target: `http://127.0.0.1:${NODE_PORT}`, changeOrigin: false },
		},
	},
	build: {
		outDir: "dist",
		emptyOutDir: true,
		target: "es2022",
	},
	// In dev the workspace packages resolve to TypeScript sources; a build uses their dist.
	resolve: mode === "development" ? { conditions: ["module", "browser", "development"] } : undefined,
}));
