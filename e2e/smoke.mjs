import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright-core";

const url = process.env.MOONAN_URL ?? "http://127.0.0.1:21315";
const fakeOpenAI = process.env.FAKE_OPENAI_URL ?? "";
const fakeMcp = process.env.FAKE_MCP_PATH ?? "";
const shotDir = process.env.MOONAN_SCREENSHOTS ?? "";

const OUT_SELECTOR = '.entry[data-kind="out"]';

const PERSONA =
	"月见，二十七岁，在街角开一家只卖旧书的店。话很少，记得每个客人上次买过什么。下雨天不开门，但会留一盏灯。";

const log = (message) => console.log(`  ${message}`);

async function shot(page, name) {
	if (!shotDir) return;
	await mkdir(shotDir, { recursive: true });
	await page.screenshot({ path: join(shotDir, `${name}.png`) });
	log(`screenshot ${name}.png`);
}

async function main() {
	const browser = await chromium.launch({ headless: process.env.PW_HEADLESS !== "false" });
	const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 1.5 });
	const errors = [];
	page.on("console", (message) => {
		if (message.type() === "error") errors.push(message.text());
	});
	page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
	const sockets = [];
	page.on("websocket", (socket) => {
		sockets.push(`open ${socket.url()}`);
		socket.on("close", () => sockets.push(`close ${socket.url()}`));
		socket.on("socketerror", (error) => sockets.push(`error ${socket.url()} ${error}`));
	});

	try {
		const tab = (name) => page.locator("nav.tabs").getByRole("button", { name });

		await page.goto(url, { waitUntil: "domcontentloaded" });
		await page.getByText("已连接").first().waitFor({ timeout: 20_000 });
		log("connected");

		// --- agent ---------------------------------------------------------
		await tab("Agent").click();
		await page.getByLabel("角色人设").fill(PERSONA);
		await page.getByRole("button", { name: "保存" }).click();
		await page.getByText("月见").first().waitFor();

		// --- provider ------------------------------------------------------
		await tab("提供商").click();
		await page.getByRole("button", { name: "添加自定义提供商" }).click();
		await page.getByLabel("ID", { exact: true }).fill("local");
		await page.getByLabel("名称", { exact: true }).fill("本地模型");
		await page.getByLabel("Base URL").fill(fakeOpenAI);
		await page.getByLabel("模型列表").fill("月见模型=fake-model");
		await page.getByRole("button", { name: "添加", exact: true }).click();
		await page.getByLabel("API 密钥").fill("test-key");
		await page.getByRole("button", { name: "保存密钥" }).click();
		await page.locator(".tag", { hasText: "已配置" }).first().waitFor();

		// --- model ---------------------------------------------------------
		await tab("Agent").click();
		await page.locator('#agent-provider option[value="local"]').waitFor({ state: "attached" });
		await page.getByLabel("提供商", { exact: true }).selectOption("local");
		// The model list is fetched per provider, so wait for the option before selecting.
		await page.locator('#agent-model option[value="fake-model"]').waitFor({ state: "attached", timeout: 20_000 });
		await page.getByLabel("模型", { exact: true }).selectOption("fake-model");
		await page.getByRole("button", { name: "保存" }).click();
		await page.getByText("local/fake-model").first().waitFor();

		// --- conversation --------------------------------------------------
		await tab("对话").click();
		const input = page.getByRole("textbox", { name: "说点什么…" });
		const bubbles = page.locator(OUT_SELECTOR);
		// Replies are distinct, so wait for the words rather than for a count: a
		// count can be satisfied by the previous turn's bubble if it lands late.
		const turns = [
			{ message: "晚上好。", reply: "外面很冷吧" },
			{ message: "你还记得我常喝什么吗？", reply: "黑咖啡" },
			{ message: "今天下雨了，店还开吗？", reply: "下雨天不开门" },
		];
		for (const [index, turn] of turns.entries()) {
			await input.fill(turn.message);
			await input.press("Enter");
			await bubbles.filter({ hasText: turn.reply }).first().waitFor({ timeout: 60_000 });
			log(`turn ${index + 1} answered`);
		}
		await page.waitForTimeout(500);
		assert.equal(await bubbles.count(), 3, "expected three character bubbles");
		await shot(page, "chat");

		// --- logs ----------------------------------------------------------
		await tab("日志").click();
		await page.locator(".entry").nth(3).waitFor({ timeout: 20_000 });
		await page.waitForTimeout(400);
		assert.ok((await page.locator(".entry").count()) >= 4, "expected transcript entries");
		await shot(page, "logs");

		// --- agents --------------------------------------------------------
		await tab("Agent").click();
		await page.getByLabel("角色人设").waitFor();
		await shot(page, "agents");

		// --- providers -----------------------------------------------------
		await tab("提供商").click();
		await page.locator(".list-item", { hasText: "本地模型" }).click();
		await page.getByText("个模型").waitFor();
		await page.mouse.wheel(0, -100000);
		await page.waitForTimeout(300);
		await shot(page, "providers");

		// --- mcp -----------------------------------------------------------
		await tab("MCP").click();
		await page.getByRole("button", { name: "添加服务" }).click();
		await page.getByLabel("名称", { exact: true }).fill("记忆");
		await page.getByLabel("命令").fill(process.env.FAKE_MCP_NODE ?? process.execPath);
		await page.getByLabel("参数").fill(fakeMcp);
		await page.getByRole("button", { name: "添加", exact: true }).click();
		await page.locator(".tag", { hasText: "已连接" }).first().waitFor({ timeout: 30_000 });
		await page.getByText("recall_memory").waitFor();
		assert.ok((await page.locator(".switch").count()) >= 2, "expected MCP tool switches");
		await shot(page, "mcp");

		assert.deepEqual(errors, [], `console errors: ${errors.join(" | ")}`);
		log("no console errors");
	} catch (error) {
		if (shotDir) {
			await mkdir(shotDir, { recursive: true });
			await page.screenshot({ path: join(shotDir, "failure.png") }).catch(() => undefined);
		}
		console.error("--- diagnostics ---");
		console.error("sockets:", sockets);
		console.error("console errors:", errors);
		console.error("body:", (await page.locator("body").innerText().catch(() => "")).slice(0, 800));
		throw error;
	} finally {
		await browser.close();
	}
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
