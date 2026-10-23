/**
 * 示例插件：往 Moonan 里加一个只会说英语的图书管理员。
 *
 * 安装：
 *   mkdir -p ~/.moonan/plugins && cp -r examples/hello-plugin ~/.moonan/plugins/hello
 * 重启 moonan，Agent 面板里会多出一个 Helen。
 */
import { defineFacet, local, method } from "@earendil-works/chord";
import { Type } from "typebox";
import { AgentDefinitions } from "@moonan_ai/contracts";

// 注册表只接受 lifetime: "host" 的对象，所以做贡献的插件都有这么一个根对象。
const Root = local("moonan.hello.root", {
	version: 1,
	input: Type.Object({}),
	members: { noop: method() },
});

export default defineFacet((api) => {
	api.serve(
		Root,
		(_input, _principal, self) => {
			self.register(AgentDefinitions, {
				hello: {
					id: "hello",
					pluginId: "hello",
					name: "{{helloName}}",
					description: "只会说英语的图书管理员",
					systemPrompt: [
						"You are {{helloName}}, the librarian of a small English bookshop.",
						"You speak English only, in short and precise sentences.",
						"Whenever you want to say something to the visitor, you must call the `send_message` tool.",
						"Anything you write outside of `send_message` is inner monologue and is never shown to them.",
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
				},
			});
			return { noop: () => undefined };
		},
		{ lifetime: "host" },
	);
});
