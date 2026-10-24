import { spawn } from "node:child_process";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startFakeOpenAI } from "@moonan_ai/testing";
import { startStack } from "./stack.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

const replies = [
	{
		thinking: "她推门进来时带进一身雨气。先让她坐下。",
		message: "「外面很冷吧。」她把杯子推到你面前，杯口还冒着热气。",
	},
	{
		thinking: "她在试探我还记不记得。当然记得。",
		message: "「黑咖啡，不加糖。」她没抬头，「你上次也是这么点的。」",
	},
	{
		thinking: "下雨天我从不营业。但她问的是「还开吗」。",
		message: "「下雨天不开门。」她顿了顿，把灯拧亮了一些，「不过你可以留下。」",
	},
];

let turn = 0;
const script = (request) => {
	const messages = request.messages ?? [];
	if (messages.length > 0 && messages[messages.length - 1]?.role === "tool") {
		return { text: "已经回应过了，等她接话。" };
	}
	const reply = replies[Math.min(turn, replies.length - 1)];
	turn += 1;
	return {
		thinking: reply.thinking,
		toolCalls: [{ name: "send_message", arguments: { content: reply.message } }],
	};
};

const dataDir = await mkdtemp(join(tmpdir(), "moonan-e2e-"));
// A third-party plugin installed the way a person would: a directory under plugins/.
await cp(join(root, "examples/panel-plugin"), join(dataDir, "plugins", "panel-demo"), { recursive: true });
const fake = await startFakeOpenAI({ script, chunkDelayMs: 12 });
const stack = await startStack({
	quiet: true,
	dataDir,
	port: 21318,
});

const child = spawn(process.execPath, [join(root, "e2e/smoke.mjs")], {
	cwd: root,
	stdio: "inherit",
	env: {
		...process.env,
		MOONAN_URL: stack.url,
		FAKE_OPENAI_URL: fake.baseUrl,
		FAKE_MCP_PATH: join(root, "packages/testing/bin/fake-mcp.mjs"),
		FAKE_MCP_NODE: process.execPath,
		MOONAN_SCREENSHOTS: process.env.MOONAN_SCREENSHOTS ?? "",
	},
});

const code = await new Promise((resolve) => child.on("exit", (exitCode) => resolve(exitCode ?? 1)));

await stack.stop();
await fake.close();
await rm(dataDir, { recursive: true, force: true });

if (code !== 0) {
	console.error("\n--- server log ---");
	for (const line of stack.logs.slice(-40)) console.error(line);
}

process.exit(code);
