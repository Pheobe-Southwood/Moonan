import { networkInterfaces } from "node:os";
import { pathToFileURL } from "node:url";
import { defaultDataDir, start } from "./index.js";

const HELP = `moonan — 本地运行的 AI 角色扮演工作台
          a local-first roleplay workbench

用法 / usage:
  moonan [选项]

选项 / options:
  --port <n>        监听端口，默认 21315
  --hostname <h>    监听地址，默认 0.0.0.0（局域网可访问）
                    只给本机用可以传 127.0.0.1
  --data-dir <dir>  数据目录，默认 ~/.moonan
  --web-dist <dir>  已构建的前端目录（开发时用）
  --help            显示帮助
  --version         显示版本
`;

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);

function lanUrls(port: number): string[] {
	const urls: string[] = [];
	for (const addresses of Object.values(networkInterfaces())) {
		for (const address of addresses ?? []) {
			if (address.family === "IPv4" && !address.internal) urls.push(`http://${address.address}:${port}`);
		}
	}
	return urls;
}

interface CliOptions {
	port?: number;
	hostname?: string;
	dataDir?: string;
	webDist?: string;
}

function parse(argv: string[]): CliOptions | "help" | "version" {
	const options: CliOptions = {};
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--help" || arg === "-h") return "help";
		if (arg === "--version" || arg === "-v") return "version";
		if (arg === "--port") {
			const value = argv[index + 1];
			if (!value) throw new Error("--port 需要一个数字");
			const port = Number(value);
			if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error(`无效端口: ${value}`);
			options.port = port;
			index += 1;
			continue;
		}
		if (arg === "--hostname") {
			const value = argv[index + 1];
			if (!value) throw new Error("--hostname 需要一个地址");
			options.hostname = value;
			index += 1;
			continue;
		}
		if (arg === "--data-dir") {
			const value = argv[index + 1];
			if (!value) throw new Error("--data-dir 需要一个路径");
			options.dataDir = value;
			index += 1;
			continue;
		}
		if (arg === "--web-dist") {
			const value = argv[index + 1];
			if (!value) throw new Error("--web-dist 需要一个路径");
			options.webDist = value;
			index += 1;
			continue;
		}
		throw new Error(`未知参数: ${arg}`);
	}
	return options;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
	let parsed: CliOptions | "help" | "version";
	try {
		parsed = parse(argv);
	} catch (error) {
		console.error(error instanceof Error ? error.message : error);
		console.error("");
		console.error(HELP);
		process.exitCode = 1;
		return;
	}
	if (parsed === "help") {
		console.log(HELP);
		return;
	}
	if (parsed === "version") {
		const { VERSION } = await import("./plugins/index.js");
		console.log(VERSION);
		return;
	}

	const instance = await start({
		...(parsed.port !== undefined ? { port: parsed.port } : {}),
		...(parsed.hostname !== undefined ? { hostname: parsed.hostname } : {}),
		dataDir: parsed.dataDir ?? defaultDataDir(),
		...(parsed.webDist !== undefined ? { webDist: parsed.webDist } : {}),
	});

	console.log(`Moonan 正在运行: ${instance.url}`);
	for (const url of lanUrls(instance.port)) console.log(`         局域网: ${url}`);
	console.log(`数据目录: ${parsed.dataDir ?? defaultDataDir()}`);
	if (!LOOPBACK.has(parsed.hostname ?? "0.0.0.0")) {
		console.warn("注意：界面没有登录鉴权，能访问这个端口的人都能控制 Agent、密钥与 MCP 工具。");
		console.warn("      只想本机使用请加 --hostname 127.0.0.1。");
	}

	const shutdown = async (signal: string) => {
		console.log(`\n收到 ${signal}，正在关闭…`);
		await instance.close().catch(() => undefined);
		process.exit(0);
	};
	process.once("SIGINT", () => void shutdown("SIGINT"));
	process.once("SIGTERM", () => void shutdown("SIGTERM"));
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
	void main();
}
