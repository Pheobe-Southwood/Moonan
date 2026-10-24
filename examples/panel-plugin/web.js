/**
 * 示例插件 C 的浏览器半边。
 *
 * 这个文件**没有经过任何构建**：它就是浏览器直接 import 的 ESM。它 import 的
 * "react" / "@moonan_ai/web-api" / "@earendil-works/chord" / "typebox" 都由 shell 的
 * import map 指到同一份运行时，所以它和内置面板共享一个 React、一个 chord 实例。
 *
 * 因为没有 JSX 编译，这里用 createElement；真实插件用 TSX 构建成 ESM 即可。
 */
import { defineFacet, local, method } from "@earendil-works/chord";
import { Button, PageHead, Panels, useT } from "@moonan_ai/web-api";
import { createElement as h } from "react";
import { Type } from "typebox";

const messages = {
	zh: {
		"demo.eyebrow": "第三方插件",
		"demo.title": "这个面板不在 shell 里",
		"demo.lede": "它由 ~/.moonan/plugins 下的一个磁盘插件在运行时注册，shell 没有 import 过它。",
		"demo.button": "点我",
	},
	en: {
		"demo.eyebrow": "Third-party plugin",
		"demo.title": "This panel is not in the shell",
		"demo.lede": "A disk plugin under ~/.moonan/plugins registered it at runtime; the shell never imported it.",
		"demo.button": "Click me",
	},
};

function Panel({ user }) {
	const t = useT(messages);
	return h(
		"div",
		null,
		h(PageHead, { eyebrow: t("demo.eyebrow"), title: t("demo.title"), lede: t("demo.lede") }),
		h("p", { className: "muted" }, `${t("demo.lede")} — ${user}`),
		h(Button, { variant: "ghost", onClick: () => window.alert(t("demo.button")) }, t("demo.button")),
	);
}

const Root = local("example.panel.root", {
	version: 1,
	input: Type.Object({}),
	members: { noop: method() },
});

export default defineFacet((api) => {
	api.serve(
		Root,
		(_input, _principal, self) => {
			self.register(Panels, {
				"panel-demo": {
					id: "panel-demo",
					order: 60,
					title: { zh: "示例面板", en: "Demo" },
					component: Panel,
				},
			});
			return { noop: () => undefined };
		},
		{ lifetime: "host" },
	);
});
