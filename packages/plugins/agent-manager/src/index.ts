import { definePlugin, type AgentDefinition } from '@moonan/plugin-sdk';

/**
 * Agent 管理。
 *
 * 在「Agent」Tab 里注册与配置 Agent：名字、说明、SYSTEM PROMPT（模板）、变量、模型。
 * 内置注册「主 Agent」——角色扮演场景的导演。
 *
 * 注意：这里的 SYSTEM PROMPT **逐字**是产品要求的原文，用户可在「高级」里编辑；
 * 其中的 `{{botname}}` / `{{soul}}` 是变量占位符，每次请求前由宿主渲染。
 */
export const MAIN_AGENT_ID = 'main';

export const MAIN_AGENT_SYSTEM_PROMPT = `你是一个角色扮演场景的导演，你精通心理学，尤其是人格心理学；你擅长研究人格特质如何与情境交互，从而预测人的行为。
现在这个场景的主角是{{botname}},其人设为{{soul}}，外界信息会在后续给出；
你需要根据{{botname}}的人设、记忆、与他人的关系以及外界信息等，控制{{botname}}做出符合人设的行为；你只能控制{{botname}}这一个角色，不可擅自补充其他角色的行为；使用act控制其行为，而其心理描写直接以文本形式输出；
在你的思考过程（<think>标签内）中，请遵守以下规则：
1. 禁止使用圆括号包裹内心独白，例如"（心想：……）"或"(内心OS：……)"，所有分析内容直接陈述即可
2. 禁止以角色第一人称描写内心活动，例如"我心想""我觉得""我暗自"等，请用分析性语言替代
3. 思考内容应聚焦于剧情走向分析和回复内容规划，不要在思考中进行角色扮演式的内心戏表演`;

export const MAIN_AGENT_DEFINITION: AgentDefinition = {
  id: MAIN_AGENT_ID,
  name: '{{botname}}',
  description: '在这里配置角色的人设',
  systemPrompt: MAIN_AGENT_SYSTEM_PROMPT,
  variables: { botname: 'Bot', soul: '' },
  scope: 'persisted',
  ui: { dialog: true, icon: '◆' },
  tools: { pluginTools: true, act: true },
  owner: '@moonan/plugin-agent-manager',
};

export const agentManagerPlugin = definePlugin({
  id: '@moonan/plugin-agent-manager',
  setup(_env, services) {
    // 服务访问只能发生在激活期（见 packages/plugin-sdk/src/plugin.ts 的说明）。
    services.onReady(async (ctx) => {
      // 只有当存储里还没有主 Agent 时才写入默认值，避免覆盖用户编辑。
      const existing = await ctx.agents.list();
      const hasMain = existing.some((agent) => agent.id === MAIN_AGENT_ID);
      if (!hasMain) {
        await ctx.agents.spawn(
          { definition: { ...MAIN_AGENT_DEFINITION, owner: '@moonan/plugin-agent-manager' } },
          );
      }
      await ctx.ui.contribute(
        { tab: { tab: 'agents', componentId: 'agent-manager' } },
      );
      ctx.log.info(`Agent 管理就绪：${(await ctx.agents.list()).length} 个 Agent`);
    });
  },
});
