/**
 * 示例插件 A：只提供能力，不注册任何东西。
 *
 * 它导出的 `example.clock` 就是公开接口：别的插件用 `self.get(Clock, {})` 使用它。
 * 契约的指纹由「名字 + 版本 + 输入 schema + 成员」算出，所以消费方不必 import
 * 这个文件，只要写出逐字相同的定义即可（见 greeter-plugin）。
 */
import { defineFacet, local, method } from "@earendil-works/chord";
import { Type } from "typebox";

export const Clock = local("example.clock", {
	version: 1,
	input: Type.Object({}),
	members: {
		now: method(Type.Object({}), Type.String()),
	},
});

const startedAt = new Date().toISOString();

export default defineFacet((api) => {
	// lifetime: "host" 表示这份实现跟着进程活：热重载别的插件时它不会被重启。
	api.serve(Clock, () => ({ now: () => startedAt }), { lifetime: "host" });
});
