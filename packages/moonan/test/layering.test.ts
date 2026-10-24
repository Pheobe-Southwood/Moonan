import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

async function sources(area: string): Promise<{ file: string; text: string }[]> {
	const dir = join(root, area);
	const entries = await readdir(dir, { recursive: true, withFileTypes: true });
	const files = entries
		.filter((entry) => entry.isFile() && /\.(ts|tsx)$/.test(entry.name))
		.map((entry) => join(entry.parentPath, entry.name));
	return Promise.all(files.map(async (file) => ({ file, text: await readFile(file, "utf8") })));
}

/**
 * The layering the refactor buys: the kernel and the contracts know nothing about a
 * plugin, and the shell knows nothing about a panel. If one of these fails, a plugin
 * has leaked into the core and `pnpm build` would still succeed — only the architecture
 * would be broken.
 */
describe("layering", () => {
	it("keeps plugin packages out of the kernel, the contracts and the shell", async () => {
		for (const area of ["packages/core/src", "packages/contracts/src", "packages/web/src"]) {
			for (const { file, text } of await sources(area)) {
				expect(text, file).not.toMatch(/@moonan_ai\/plugin-/);
			}
		}
	}, 30_000);

	it("keeps the panels registry out of the kernel", async () => {
		for (const area of ["packages/core/src", "packages/contracts/src"]) {
			for (const { file, text } of await sources(area)) {
				expect(text, file).not.toMatch(/moonan\.panels|Panels/);
			}
		}
	}, 30_000);

	it("keeps React out of the kernel", async () => {
		for (const { file, text } of await sources("packages/core/src")) {
			expect(text, file).not.toMatch(/from "react/);
		}
	}, 30_000);
});
