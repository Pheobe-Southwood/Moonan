import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

async function waitForHttp(url, timeoutMs = 60_000) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		try {
			const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
			if (response.ok) return;
		} catch {
			// not up yet
		}
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${url}`);
		await new Promise((resolve) => setTimeout(resolve, 200));
	}
}

/**
 * Dev stack: the Node server owns chord/WS/data on `nodePort`, Vite serves the
 * web app on `webPort` and proxies /ws, /api and /plugins to it.
 */
export async function startStack(options = {}) {
	const nodePort = options.nodePort ?? 21316;
	const webPort = options.webPort ?? 21315;
	const dataDir = options.dataDir ?? join(root, ".data");
	const quiet = options.quiet ?? false;
	const children = [];
	const logs = [];
	let stopping = false;

	const launch = (name, command, args, env = {}) => {
		const child = spawn(command, args, {
			cwd: root,
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

	launch("server", process.execPath, [
		"--conditions=development",
		"--import",
		"tsx",
		"packages/moonan/src/cli.ts",
		"--port",
		String(nodePort),
		"--data-dir",
		dataDir,
	]);
	launch(
		"web",
		"pnpm",
		["--filter", "@moonan/web", "exec", "vite", "--port", String(webPort), "--strictPort"],
		{ MOONAN_NODE_PORT: String(nodePort) },
	);

	const url = `http://127.0.0.1:${webPort}`;
	await waitForHttp(`${url}/`);

	return {
		url,
		nodePort,
		webPort,
		dataDir,
		logs,
		async stop() {
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
		},
	};
}
