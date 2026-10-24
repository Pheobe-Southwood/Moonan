/**
 * 示例插件 B：消费另一个插件的能力。
 *
 * 关键在于两点：
 *   1. `Clock` 的定义与 clock-plugin 里逐字相同 —— 指纹相同，于是是同一个契约；
 *   2. facet 声明了 `uses: [Clock]`，热重载时会重新绑定到新的提供方。
 */
import { defineFacet, local, method } from "@earendil-works/chord";
import { Type } from "typebox";

const Clock = local("example.clock", {
	version: 1,
	input: Type.Object({}),
	members: {
		now: method(Type.Object({}), Type.String()),
	},
});

const Greeting = local("example.greeting", {
	version: 1,
	input: Type.Object({}),
	members: {
		text: method(Type.Object({}), Type.String()),
	},
});

export default defineFacet(
	(api) => {
		api.serve(
			Greeting,
			(_input, _principal, self) => {
				// 拿到的就是 clock 插件 serve 出来的那个对象。
				const clock = self.get(Clock, {});
				// 契约方法的调用是异步的（哪怕提供方是本地对象）。
				return { text: async () => `你好，现在是 ${await clock.now()}` };
			},
			{ lifetime: "host" },
		);
	},
	{ uses: [Clock] },
);
