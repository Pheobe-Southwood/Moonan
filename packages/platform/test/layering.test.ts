import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function sources(area: string, pattern = /\.(ts|tsx|mjs|js)$/): { file: string; text: string }[] {
	const dir = join(root, area);
	const entries = readdirSync(dir, { recursive: true, withFileTypes: true });
	return entries
		.filter((entry) => entry.isFile() && pattern.test(entry.name) && !entry.parentPath.includes("node_modules"))
		.map((entry) => {
			const file = join(entry.parentPath, entry.name);
			return { file: file.slice(root.length + 1), text: readFileSync(file, "utf8") };
		});
}

function manifest(area: string): { name?: string; dependencies?: Record<string, string>; devDependencies?: Record<string, string>; peerDependencies?: Record<string, string> } {
	return JSON.parse(readFileSync(join(root, area, "package.json"), "utf8"));
}

/**
 * The architecture, asserted rather than assumed.
 *
 * The platform's whole claim is that it stores nothing and knows no feature. That is easy to
 * break with one import and hard to notice: `pnpm build` would still succeed. These are
 * the lines that must not be crossed.
 */
describe("layering", () => {
	it("has no database or persistence code anywhere in the platform", () => {
		for (const area of ["packages/platform/src", "packages/sdk/src", "packages/web/src"]) {
			for (const { file, text } of sources(area)) {
				expect(text, file).not.toMatch(/node:sqlite|better-sqlite3|CREATE TABLE|\.db["'`]/);
			}
		}
	});

	it("keeps AI packages out of the platform and the SDK", () => {
		for (const area of ["packages/platform", "packages/sdk", "packages/web", "."]) {
			const deps = { ...manifest(area).dependencies, ...manifest(area).devDependencies, ...manifest(area).peerDependencies };
			for (const name of Object.keys(deps)) {
				expect(name, `${area}/package.json`).not.toMatch(/pi-(ai|agent-core|mcp|durable)|openai|anthropic/);
			}
		}
	});

	it("keeps the platform out of React and out of any plugin", () => {
		for (const { file, text } of sources("packages/platform/src")) {
			expect(text, file).not.toMatch(/from "react/);
			expect(text, file).not.toMatch(/@moonan_ai\/(?!sdk)/);
		}
	});

	it("keeps React in the SDK's browser entry only", () => {
		for (const { file, text } of sources("packages/sdk/src")) {
			if (file.endsWith("web.ts")) continue;
			expect(text, file).not.toMatch(/from "react/);
		}
	});

	it("keeps the shell from importing a panel", () => {
		for (const { file, text } of sources("packages/web/src")) {
			expect(text, file).not.toMatch(/examples\/|plugin-/);
		}
	});

	it("keeps the SDK free of the built shell", () => {
		for (const { file, text } of sources("packages/sdk/src")) {
			expect(text, file).not.toMatch(/@moonan_ai\/web/);
		}
	});

	it("declares the three published directions in the docs", () => {
		const readme = readFileSync(join(root, "README.md"), "utf8");
		expect(readme).toMatch(/@moonan_ai\/sdk/);
		expect(readme).toMatch(/@moonan_ai\/moonan/);
	});

	it("uses the platform vocabulary in the current guides", () => {
		for (const file of ["README.md", "docs/architecture.md", "docs/plugins.md"]) {
			const text = readFileSync(join(root, file), "utf8");
			expect(text, file).not.toMatch(/基座|Substrate|substrate/);
		}
	});
});
