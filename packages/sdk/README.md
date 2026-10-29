# @moonan_ai/sdk

Moonan 插件 SDK：契约、注册表与浏览器钩子。写 Moonan 插件只需要这一个包——Chord 的原语
（`remote`、`local`、`method`、`hostNamed`、`defineFacet`、`defineRegistry`）由它再导出。

Moonan 是一个本地运行的插件工作台：平台只提供宿主、端口、插件发现与切面装载，所有功能——包括
AI 对话——都是插件。

```bash
npm i @moonan_ai/sdk
```

## 两个入口

| 入口 | 给谁用 |
|---|---|
| `@moonan_ai/sdk` | 服务端切面、以及需要契约/注册表的浏览器代码 |
| `@moonan_ai/sdk/web` | 浏览器切面：`Panels`、`useRemote`、`useReadable`、`useRefStatus` |

浏览器切面不要自行打包 React、Chord 或本包：外壳的 import map 已经提供了它们，而且只有一份。

## 服务端切面

```js
import { Type, defineFacet, hostNamed, method, remote } from "@moonan_ai/sdk";

const Counter = remote("example.counter", {
	version: 1,
	input: Type.Object({}),
	host: hostNamed("moonan"),
	variants: { v1: { state: { n: Type.Number() }, methods: { bump: method() } } },
});

export default defineFacet((api) => {
	api.serve(Counter, (_input, _principal, self) => {
		const n = self.state("n", Type.Number(), 0);
		return { variant: "v1", n, bump: (ctx) => n.change(ctx, (value) => value + 1) };
	});
});
```

## 浏览器切面

```js
import { Panels } from "@moonan_ai/sdk/web";
import { Type, defineFacet, local, method } from "@moonan_ai/sdk";
import { createElement as h } from "react";

const Root = local("example.counter.web", { version: 1, input: Type.Object({}), members: { noop: method() } });

export default defineFacet((api) => {
	api.serve(Root, (_input, _p, self) => {
		self.register(Panels, { counter: { id: "counter", title: "Counter", order: 10, component: () => h("div") } });
		return { noop: () => undefined };
	}, { lifetime: "host" });
});
```

## 约定

- 契约在两端**各写一份**：Chord 认指纹（名字、版本、成员、类型住在哪个宿主），不认模块实例。
- 注册表贡献（`Routes`、`Panels`、`DataCodecs`、`ModelProviders`）必须来自 `{ lifetime: "host" }` 的对象。
- 需要统一导出/导入的数据放 `DataStore`，并注册 `DataCodecs`；需要给其他插件用模型时注册 `ModelProviders`。
- 服务端宿主名固定为 `"moonan"`；写别的名字，`api.serve` 会当场拒绝。
- 浏览器切面是**单个 ESM 文件**：浏览器没有模块 hook，重载只换入口。

## 统一数据与模型

```js
import { DataCodecs, DataStore, ModelProviders } from "@moonan_ai/sdk";
```

- `DataStore` 是平台唯一的统一数据文件（local、host-lifetime）；`read` 返回 `{ value, version }`，`update` 是串行读改写，`exportAll`/`importAll` 由平台 HTTP 表面调用。
- `DataCodecs` 是插件贡献的导出/导入 codec 注册表；没有 codec 的 namespace 不会进入统一导出。
- `ModelProviders` 是服务端模型提供商注册表；`list()` 是 key-free 目录，`runtime()` 是 server-only 运行时，不能给浏览器。

完整写法：<https://github.com/Pheobe-Southwood/Moonan/blob/main/docs/plugins.md> ·
词汇表：<https://github.com/Pheobe-Southwood/Moonan/blob/main/CONTEXT.md>

## 许可

MIT
