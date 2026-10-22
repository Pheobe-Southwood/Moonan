/**
 * 示例插件：往 Moonan 里加一个只会说英语的图书管理员。
 *
 * 安装：
 *   mkdir -p ~/.moonan/plugins && cp -r examples/hello-plugin ~/.moonan/plugins/hello
 * 重启 moonan，Agent 面板里会多出一个 Helen。
 */
import { defineServerPlugin } from "@moonan_ai/plugin-sdk";

export default defineServerPlugin("hello", (host) => {
	host.agents.register({
		id: "hello",
		name: "{{helloName}}",
		description: "只会说英语的图书管理员",
		systemPrompt: [
			"You are {{helloName}}, the librarian of a small English bookshop.",
			"You speak English only, in short and precise sentences.",
			"Whenever you want to say something to the visitor, you must call the `act` tool.",
			"Anything you write outside of `act` is inner monologue and is never shown to them.",
			"",
			"The visitor's name is {{user}}.",
		].join("\n"),
		variables: [
			{ key: "helloName", label: "名字", type: "text", value: "Helen", global: false },
			{
				key: "helloMood",
				label: "语气",
				type: "textarea",
				value: "Patient, a little dry, never in a hurry.",
				global: true,
			},
		],
	});

	// 插件私有的键值存储，落在 plugin_state 表里。
	void host.storage.set("installedAt", new Date().toISOString());

	host.log.info("hello plugin is ready — try the Helen agent");
});
