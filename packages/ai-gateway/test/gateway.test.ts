import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const script = fileURLToPath(new URL("./fixtures/gateway-run.mjs", import.meta.url));
const cwd = fileURLToPath(new URL("..", import.meta.url));

/**
 * This runs in a child process on purpose.
 *
 * Vitest's worker carries the "development" export condition, so a dynamic import of the
 * plugin's server facet would resolve `@moonan_ai/sdk` to TypeScript sources that Node's
 * loader cannot execute. A real Node process uses the same "default" condition production
 * does — which is exactly the path this test is supposed to cover.
 */
describe("the ai-gateway facet", () => {
	it("persists through chord, discovery, reload and a restart", async () => {
		const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
			const child = spawn(process.execPath, [script], {
				cwd,
				env: { ...process.env, NODE_OPTIONS: "" },
				stdio: ["ignore", "pipe", "pipe"],
			});
			let stdout = "";
			let stderr = "";
			child.stdout.setEncoding("utf8");
			child.stderr.setEncoding("utf8");
			child.stdout.on("data", (chunk: string) => {
				stdout += chunk;
			});
			child.stderr.on("data", (chunk: string) => {
				stderr += chunk;
			});
			child.once("error", reject);
			child.once("exit", (code) => resolve({ code, stdout, stderr }));
		});

		expect(result.stderr).toBe("");
		expect(result.code, result.stderr || result.stdout).toBe(0);
		const line = result.stdout.trim().split(/\r?\n/).at(-1) ?? "";
		const parsed = JSON.parse(line) as { ok: boolean; providers: number; models: number };
		expect(parsed).toEqual({ ok: true, providers: 2, models: 4 });
	}, 60_000);
});
