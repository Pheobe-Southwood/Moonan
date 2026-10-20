import { Type } from 'typebox';
import { definePlugin } from '@moonan/plugin-sdk';

/**
 * 对话窗。
 *
 * - 每个 Agent 在「对话」Tab 里各有一个入口；点哪个就给哪个发消息（UI 侧实现）。
 * - 注册 `conversation.send_message`：角色通过它往对话框里发消息（左侧）。
 *   它只写历史、不触发下一轮生成——语义上等价于一次 tool 调用的产物。
 * - 「通过 webui 打开了对话窗口」的排队通知由 UI 侧在切换入口时发出（steer 等级）。
 */
export const SEND_MESSAGE_ACTION = 'conversation.send_message';
export const CONVERSATION_OWNER = '@moonan/plugin-conversation';

export const sendMessageParameters = Type.Object({
  text: Type.String({ minLength: 1, description: '要发送到对话框的消息内容' }),
});

export const conversationPlugin = definePlugin({
  id: CONVERSATION_OWNER,
  setup(_env, services) {
    // 服务访问只能发生在激活期，因此注册 action 也放在 onReady 里。
    services.onReady(async (ctx) => {
      ctx.define.action({
        id: SEND_MESSAGE_ACTION,
        title: '发送对话消息',
        description: '把一个动作、一句话或一段心理描写发到 WebUI 的对话框中，用户会在左侧看到。',
        parameters: sendMessageParameters,
        available: () => true,
        run: async (args: { text: string }, api) => {
          const text = String(args.text ?? '').trim();
          if (text.length === 0) {
            return { ok: false, text: '消息内容不能为空。' };
          }
          await api.writeSidebar({ kind: 'character', text });
          return { ok: true, text: `已发送到对话框：${text}` };
        },
      });

      await ctx.ui.contribute({ tab: { tab: 'conversation', componentId: 'conversation' } });
      ctx.log.info('对话窗已装载');
    });
  },
});
