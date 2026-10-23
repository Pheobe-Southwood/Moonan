import { defineConfig } from "vitest/config";

export default defineConfig({
	resolve: { conditions: ["module", "development"] },
	test: {
		environment: "node",
		include: ["test/**/*.test.ts"],
		testTimeout: 60_000,
		hookTimeout: 60_000,
		// Built-in facets load by module URL through chord's `nodeLoader`, exactly like
		// disk plugins. tsx's loader hook is what lets that import a `.ts` source file.
		pool: "forks",
		execArgv: ["--conditions=development", "--import", "tsx"],
	},
});
