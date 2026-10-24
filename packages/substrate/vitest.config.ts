import { defineConfig } from "vitest/config";

export default defineConfig({
	resolve: { conditions: ["module", "development"] },
	test: {
		environment: "node",
		include: ["test/**/*.test.ts"],
		testTimeout: 60_000,
		hookTimeout: 60_000,
		// Facets load by module URL through chord's `nodeLoader`, exactly like a disk plugin.
		// tsx's hook is what lets that import a `.ts` source file in a dev tree.
		pool: "forks",
		execArgv: ["--conditions=development", "--import", "tsx"],
	},
});
