import { defineService } from '@earendil-works/chord';
import { definePlugin } from '@moonan/plugin-sdk';

/**
 * Act 装载标记：其他插件/宿主可据此判断 Act 是否在场。
 *
 * 本插件**没有 UI**。它的产物是「插件注册 action → 模型可调用」这条通路，
 * 以及主 Agent 上下文里那段可调用动作列表。工具本体的构建在
 * `runtime/tools.ts`，ActBlock 的摘挂在 `runtime/actblock.ts`（由宿主提供，
 * 保证任何 Agent 都遵循同一套不变式，见 docs/adr/0004）。
 */
export interface ActPresence {
  /** 恒为 true；存在本身即表示 Act 已装载。 */
  readonly present: true;
  readonly toolName: string;
}

/** chord 要求服务实现是对象，所以这里用一个带标记的小对象而不是裸 boolean。 */
export const ACT_TOKEN = defineService<ActPresence>('moonan.act', { local: true });

export const actPlugin = definePlugin({
  id: '@moonan/plugin-act',
  setup(env, services) {
    // setup 阶段只能 provide，不能解析别人的服务。
    env.provide(ACT_TOKEN, { present: true, toolName: 'act' });
    services.onReady((ctx) => {
      ctx.log.info('Act 已装载：act 工具与 ActBlock 机制生效');
    });
  },
});
