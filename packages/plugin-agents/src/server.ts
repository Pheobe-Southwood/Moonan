import { defineFacet, local, method } from "@earendil-works/chord";
import { Type } from "typebox";
import { AgentDefinitions, type AgentDefinition } from "@moonan_ai/contracts";

/**
 * The director prompt. Users edit it in Agent 管理 → 高级; this is the shipped
 * text, with `{Bot名字}` / `{SOUL}` migrated to `{{...}}`.
 */
export const MAIN_SYSTEM_PROMPT = `你是一个角色扮演场景的导演，你精通心理学，尤其是人格心理学；你擅长研究人格特质如何与情境交互，从而预测人的行为。
现在这个场景的主角是{{botname}}，其人设为{{soul}}，外界信息会在后续给出；
你需要根据{{botname}}的人设、记忆、与他人的关系以及外界信息等，控制{{botname}}做出符合人设的行为；你只能控制{{botname}}这一个角色，不可擅自补充其他角色的行为；使用send_message控制其行为，而其心理描写直接以文本形式输出；
在你的思考过程（ thinking标签内）中，请遵守以下规则：
1. 禁止使用圆括号包裹内心独白，例如"（心想：……）"或"(内心OS：……)"，所有分析内容直接陈述即可
2. 禁止以角色第一人称描写内心活动，例如"我心想""我觉得""我暗自"等，请用分析性语言替代
3. 思考内容应聚焦于剧情走向分析和回复内容规划，不要在思考中进行角色扮演式的内心戏表演
`;

export const MAIN_AGENT_ID = "main";

/**
 * A registries-only facet: the object it serves exists solely so that this plugin has
 * a `lifetime: "host"` object to register the agent definition from.
 */
const Root = local("moonan.agents.root", {
	version: 1,
	input: Type.Object({}),
	members: { noop: method() },
});

const definition: AgentDefinition = {
	id: MAIN_AGENT_ID,
	pluginId: "agents",
	name: "{{botname}}",
	description: "在这里配置角色的人设",
	systemPrompt: MAIN_SYSTEM_PROMPT,
	variables: [
		{ key: "botname", label: "角色名字", type: "text", value: "月见", global: true },
		{
			key: "soul",
			label: "角色人设",
			type: "textarea",
			value: "",
			global: true,
			placeholder: "她是谁、经历过什么、说话方式如何、有什么秘密……",
		},
	],
};

/**
 * Registers the one built-in agent. Everything else about it is edited by the user.
 * The panel lives in `./web.tsx`: a plugin's browser half is a facet of its own.
 */
export default defineFacet((api) => {
	api.serve(
		Root,
		(_input, _principal, self) => {
			self.register(AgentDefinitions, { [MAIN_AGENT_ID]: definition });
			return { noop: () => undefined };
		},
		{ lifetime: "host" },
	);
});
