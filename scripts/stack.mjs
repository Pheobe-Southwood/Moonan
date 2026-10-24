import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

export const WEB_DIST = join(root, "packages/web/dist");

/** Poll until something answers; a slow first compile is fine, a closed port is not. */
async function waitForHttp(url, isAlive, timeoutMs = 180_000) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		try {
			const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
			if (response.ok) return;
		} catch {
			// not up yet
		}
		if (!isAlive()) throw new Error(`a child process exited while waiting for ${url}`);
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${url}`);
		await new Promise((resolve) => setTimeout(resolve, 200));
	}
}

function viteBin() {
	return [
		join(root, "packages/web/node_modules/vite/bin/vite.js"),
		join(root, "node_modules/vite/bin/vite.js"),
	].find((candidate) => existsSync(candidate));
}

/**
 * One server, one port: the Node process owns chord, the WebSocket, the data and the
 * built web app. There is no second dev server, because a plugin's browser facet is
 * fetched over HTTP from the same origin as the WebSocket — a proxy would only add a
 * way for the two to disagree.
 *
 * `watch` adds the three compilers a browser facet needs: TypeScript for the plugin
 * packages, Vite for the shell and esbuild for the shared runtime modules.
 */
export async function startStack(options = {}) {
	const port = options.port ?? 21315;
	const dataDir = options.dataDir ?? join(root, ".data");
	const quiet = options.quiet ?? false;
	const watch = options.watch ?? false;
	const webDist = options.webDist ?? WEB_DIST;
	const children = [];
	const logs = [];
	let stopping = false;

	if (!existsSync(join(webDist, "index.html"))) {
		throw new Error(`${webDist} has no index.html — run \`pnpm build\` first`);
	}

	const launch = (name, command, args, extra = {}) => {
		const { cwd = root, ...env } = extra;
		const child = spawn(command, args, {
			cwd,
			env: { ...process.env, ...env },
			stdio: ["ignore", "pipe", "pipe"],
		});
		const record = (stream) => (chunk) => {
			const text = chunk.toString();
			logs.push(...text.split("\n").filter(Boolean).map((line) => `[${name}] ${line}`));
			if (!quiet) (stream === "err" ? process.stderr : process.stdout).write(text);
		};
		child.stdout.on("data", record("out"));
		child.stderr.on("data", record("err"));
		child.on("exit", (code) => {
			if (!stopping && code !== 0) console.error(`[${name}] exited with code ${code}`);
		});
		children.push(child);
		return child;
	};

	const stopAll = async () => {
		stopping = true;
		await Promise.all(
			children.map(
				(child) =>
					new Promise((resolve) => {
						if (child.exitCode !== null) return resolve();
						child.once("exit", resolve);
						child.kill("SIGTERM");
						setTimeout(() => child.kill("SIGKILL"), 3_000).unref();
					}),
			),
		);
	};

	const serverArgs = ["--conditions=development", "--import", "tsx"];
	if (watch) serverArgs.push("--watch");
	serverArgs.push(
		"packages/moonan/src/cli.ts",
		"--port",
		String(port),
		"--hostname",
		"127.0.0.1",
		"--data-dir",
		dataDir,
		"--web-dist",
		webDist,
	);
	launch("server", process.execPath, serverArgs);

	if (watch) {
		launch("types", "pnpm", [
			"-r",
			"--parallel",
			"--filter",
			"@moonan_ai/contracts",
			"--filter",
			"@moonan_ai/web-api",
			"--filter",
			"@moonan_ai/plugin-*",
			"dev",
		]);
		launch("runtime", process.execPath, ["packages/web/scripts/build-runtime.mjs", "--watch"]);
		const vite = viteBin();
		if (!vite) throw new Error("vite is not installed — run `pnpm install`");
		launch("web", process.execPath, [vite, "build", "--watch"], { cwd: join(root, "packages/web") });
	}

	const url = `http://127.0.0.1:${port}`;
	const isAlive = () => children.every((child) => child.exitCode === null);
	try {
		await waitForHttp(`${url}/`, isAlive);
		await waitForHttp(`${url}/api/plugins`, isAlive);
	} catch (error) {
		await stopAll();
		throw new Error(`${error instanceof Error ? error.message : String(error)}\n${logs.slice(-40).join("\n")}`);
	}

	return { url, port, dataDir, webDist, logs, stop: stopAll };
}
