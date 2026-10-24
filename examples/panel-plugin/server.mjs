/**
 * 示例插件 C：服务端只是一个空壳。
 *
 * 面板完全在浏览器里：`web.js` 被 shell 在运行时 import 进来，注册到浏览器宿主自己的
 * `Panels` 注册表。服务端不需要知道这个面板存在。
 */
import { defineFacet } from "@earendil-works/chord";

export default defineFacet(() => {
	// 这个插件不提供任何服务端能力。
});
