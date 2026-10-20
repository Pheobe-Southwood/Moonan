import { definePlugin } from '@moonan/plugin-sdk';

/**
 * 日志窗。
 *
 * 展示任意 Agent 的**完整原始上下文**：按时间从上往下排列，每条标注
 * system / user / assistant / tool，思维链与工具详情默认折叠，并跟随实时流式输出。
 *
 * 数据来源全部是宿主服务 `moonan.transcripts`：
 * - 历史：`page()` 分页（向上滚动加载）+ `delta()` 补齐断线；
 * - 实况：`events` 这个 replicated state 里的环形缓冲（刷新页面后仍在）。
 *
 * 本插件刻意**不**直接读数据库：它验证的是「插件只能通过服务拿到东西」这条边界。
 */
export const logWindowPlugin = definePlugin({
  id: '@moonan/plugin-log-window',
  setup(_env, services) {
    // 服务访问只能发生在激活期（见 packages/plugin-sdk/src/plugin.ts 的说明）。
    services.onReady(async (ctx) => {
      await ctx.ui.contribute(
        { tab: { tab: 'logs', componentId: 'log-window' } },
      );
      const active = await ctx.transcripts.active();
      ctx.log.info(`日志窗已装载：${active.length} 个会话可查看`);
    });
  },
});
