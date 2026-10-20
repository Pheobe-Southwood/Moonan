import { definePlugin } from '@moonan/plugin-sdk';

/**
 * 提供商管理面板。
 *
 * 在「提供商」Tab 里：选择 pi-ai 的 provider、配置 API Key、添加自定义 provider。
 * OAuth 在 rc1 只是占位（按钮禁用并标注「尚未实现」），不实现登录流程。
 *
 * 数据面由宿主服务 `moonan.providers` 提供（明文凭据存储归它所有）；
 * 本插件负责把它暴露到 UI，并在配置变化后刷新 provider 列表。
 */
export const providerPanelPlugin = definePlugin({
  id: '@moonan/plugin-provider-panel',
  setup(_env, services) {
    // 服务访问只能发生在激活期（见 packages/plugin-sdk/src/plugin.ts 的说明）。
    services.onReady(async (ctx) => {
      await ctx.ui.contribute(
        { tab: { tab: 'providers', componentId: 'provider-panel' } },
      );
      const providers = await ctx.providers.list();
      ctx.log.info(`提供商面板就绪：${providers.length} 个 provider`);
    });
  },
});
