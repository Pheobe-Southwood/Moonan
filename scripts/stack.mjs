import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

/** Poll until something answers; a slow first compile is fine, a closed port is not. */
async function waitForHttp(url, isAlive, timeoutMs = 120_000) {
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

/**
 * Dev stack: the Node server owns chord/WS/data on `nodePort`, Vite serves the
 * web app on `webPort` and proxies /ws, /api and /plugins to it.
 *
 * Both children bind 127.0.0.1 explicitly: on some hosts `localhost` resolves to
 * ::1 first, which leaves 127.0.0.1 refused.
 */
export async function startStack(options = {}) {
	const nodePort = options.nodePort ?? 21316;
	const webPort = options.webPort ?? 21315;
	const dataDir = options.dataDir ?? join(root, ".data");
	const quiet = options.quiet ?? false;
	const children = [];
	const logs = [];
	let stopping = false;

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

	launch("server", process.execPath, [
		"--conditions=development",
		"--import",
		"tsx",
		"packages/moonan/src/cli.ts",
		"--port",
		String(nodePort),
		"--hostname",
		"127.0.0.1",
		"--data-dir",
		dataDir,
	]);

	const viteBin = [join(root, "packages/web/node_modules/vite/bin/vite.js"), join(root, "node_modules/vite/bin/vite.js")].find(
		(candidate) => existsSync(candidate),
	);
	launch("web", process.execPath, [viteBin ?? "vite", "--host", "127.0.0.1", "--port", String(webPort), "--strictPort"], {
		MOONAN_NODE_PORT: String(nodePort),
		cwd: join(root, "packages/web"),
	});

	const url = `http://127.0.0.1:${webPort}`;
	const isAlive = () => children.every((child) => child.exitCode === null);
	try {
		await waitForHttp(`${url}/`, isAlive);
		await waitForHttp(`http://127.0.0.1:${nodePort}/api/plugins`, isAlive);
	} catch (error) {
		await stopAll();
		throw new Error(`${error instanceof Error ? error.message : String(error)}\n${logs.slice(-40).join("\n")}`);
	}

	return { url, nodePort, webPort, dataDir, logs, stop: stopAll };
}
