import { defineConfig } from "vitest/config";

export default defineConfig({
	resolve: { conditions: ["module", "development"] },
	test: {
		environment: "happy-dom",
		include: ["test/**/*.test.{ts,tsx}"],
	},
});
