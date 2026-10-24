# 写一个插件

一个插件是一个目录或一个 npm 包，最多三个文件：

```text
my-plugin/
├── plugin.json     # 只对目录插件必要
├── server.mjs      # 服务端切面
└── web.js          # 浏览器切面
```

两个切面都是 `defineFacet` 的返回值，都由基座用 `host.load([url])` 装进去。**只有一个的插件也是完整插件**——纯后端插件没有 `web.js`，纯前端插件没有 `server.mjs`。

## 两种来源

| 来源 | 怎么被找到 | 入口怎么定 |
|---|---|---|
| 目录 | `--plugin ./my-plugin`，或放进 `--plugins-dir` 的任一子目录 | `plugin.json` 的 `server` / `web`，缺省 `server.mjs` 和 `web.js` |
| 包 | `--plugin my-plugin` | 包自己的 `exports`：`"."` 是服务端切面，`"./web"` 是浏览器切面 |

基座对两者做同一件事：拿到模块 URL，交给 Chord 的 `nodeLoader`。区别只在 URL 从哪来。

`plugin.json`：

```json
{
	"id": "clock",
	"name": "时钟 · Clock",
	"version": "0.0.2-alpha1",
	"server": "server.mjs",
	"web": "web.js"
}
```

一条规则值得记住：目录里的 `.js` 服务端入口，如果同目录没有 `{"type":"module"}` 的 `package.json`，Node 会当 CommonJS 加载，`export default` 直接失败。基座会给出明确错误并跳过这个插件。要么写 `.mjs`，要么加上 `"type": "module"`。

## 服务端切面

```js
import { Routes, Type, defineFacet, hostNamed, local, method, remote } from "@moonan_ai/sdk";

const Clock = remote("moonan.clock", {
	version: 1,
	input: Type.Object({}),
	host: hostNamed("moonan"),
	variants: {
		v1: {
			state: { at: Type.Number() },
			methods: { tick: method() },
		},
	},
});

export default defineFacet((api) => {
	api.serve(Clock, (_input, _principal, self) => {
		const at = self.state("at", Type.Number(), Date.now());
		return { variant: "v1", at, tick: (ctx) => at.change(ctx, () => Date.now()) };
	});
});
```

几个必须知道的事：

- **`hostNamed("moonan")`**：服务端只有一个宿主，名字就是这个。写别的名字，浏览器会得到一个「该类型不在这个宿主上」的错误。
- **生命周期**：默认的对象只活到最后一个引用被释放。想让它常驻，用 `{ lifetime: "host" }`——但只有 `local` 契约、且 `input` 接受 `{}` 的对象可以这样。
- **任务**：`self.task(async (ctx) => {…})` 里用 `ctx.signal` 退出。对象释放时任务跟着停——别在插件里起一个基座关不掉的后台循环。
- **注册表贡献**必须来自 `lifetime: "host"` 对象。这也是为什么例子末尾有一个空的 `Root` 对象。

## 契约要在两边各写一份

浏览器切面拿不到服务端的模块（它是另一个进程、另一套打包），所以契约写两遍。两份不需要共享模块——Chord 认的是**指纹**：名字、版本、成员结构，以及这个类型住在哪个宿主（`host: hostNamed(...)` 也在指纹里，移动类型是破坏性改动）。写了不一致的 schema，浏览器会得到 `contract_mismatch`。

这是刻意的取舍：它换来的是插件可以零构建。有构建的插件当然可以把契约抽成第三个文件、两边 import 同一份；基座对两种写法一视同仁。

## 声明你消费的契约

服务端切面如果消费另一个插件的类型，用 `defineFacet` 的第二个参数把它列出来：

```js
export default defineFacet((api) => {
	api.serve(Consumer, (_input, _p, self) => {
		const shared = self.get(Shared, {});
		return { ping: (ctx) => shared.ping(ctx) };
	}, { lifetime: "host" });
}, { uses: [Shared] });
```

reload 时 chord 会用它检查新的提供者是否仍覆盖你手里的那份契约；不覆盖就拒绝这次 reload，而不是让一个半坏的插件继续跑。

**只在同一个宿主里生效。** `uses` 检查的是「这次 reload 改到的、由本宿主提供的类型」。所以你写在服务端切面里是有效的（都在 `moonan` 宿主上）；浏览器切面消费服务端类型**不属于此列**——那个类型不在浏览器宿主上，这一条会被跳过，跨宿主的契约靠版本与 `contract_mismatch` 兜底。

`uses` 认的也是指纹，所以不需要共享模块：把契约再写一份丢进去即可。

## 浏览器切面

```js
import { Panels, useReadable, useRemote } from "@moonan_ai/sdk/web";
import { defineFacet, local, method, Type } from "@moonan_ai/sdk";
import { createElement as h } from "react";

function Panel({ host }) {
	const clock = useRemote(host, Clock, {});
	const at = useReadable(clock?.at, 0);
	return h("div", null, new Date(at).toLocaleTimeString());
}

const Root = local("moonan.clock.web", { version: 1, input: Type.Object({}), members: { noop: method() } });

export default defineFacet((api) => {
	api.serve(Root, (_input, _p, self) => {
		self.register(Panels, { clock: { id: "clock", title: "时钟", order: 10, component: Panel } });
		return { noop: () => undefined };
	}, { lifetime: "host" });
});
```

- 组件收到的 props **只有 `host`**。外壳不传状态、不传语言、不传用户——它没有这些东西。
- `useRemote` 走的是 Chord 的 `host.hold`：引用**同步**返回，可能仍是 `loading`。它返回 chord 的 `Ref<C>`，所以成员是有类型的：单 variant 契约直接 `clock.at`；**多 variant 契约要先按 `ref.variant` 收窄**，否则 TypeScript 不知道该 variant 有哪些成员。
- `useRefStatus` 读它的 `status` 决定渲染过渡态；`loading` 时状态成员会抛 `not_ready`，`useReadable` 的 fallback 只是占位，不是数据。（`not_ready` / `not_in_variant` 会安静地降级为 fallback；其他错误会被打成 `console.error`，不会被 fallback 掩盖。）
- `useReadable` 接受任何 chord `Readable<T>`——cell、derivation、别人对象的 state 成员都行，不限于本插件自己的契约。
- 浏览器切面应当是一个**单个 ESM 文件**。浏览器没有模块 hook，重载时只有入口 URL 的缓存参数会变，相对 import 的子文件仍命中缓存——把切面拆成多文件，热重载就只换掉入口。
- `title` 是纯字符串，外壳原样显示。面板自己决定写什么语言。
- `order` 决定标签顺序，同值保持注册顺序。
- 你不需要打包。`import "react"`、`import "@moonan_ai/sdk/web"` 由外壳的 import map 指到 `/runtime/*.js`：整个页面只有一份 React、一份 Chord。多一份 React 会让 hooks 报错——而且表现为「面板不出现」，不是一条明确的报错。

## 直接用 Chord

`@moonan_ai/sdk` 把 Chord 的原语原样再导出了：`remote`、`local`、`method`、`hostNamed`、`defineFacet`、`defineRegistry`、`Type`……插件不直接依赖 Chord 也能写完整功能。想用更深的 API，装 `@earendil-works/chord` 即可，版本对齐 `1.4.0`。

## 持久化

基座不提供数据库，也不给数据目录。插件自己决定存哪、存什么：

```js
import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync("/path/to/your-own.db");
```

这是零数据基座的直接后果：卸载插件 = 删掉它的包和它自己的文件，基座侧没有残留要清理。想跟着 Moonan 一起启动，就把数据文件放进插件自己的目录或环境变量指定的位置。

## 检查插件有没有装上

```bash
curl http://127.0.0.1:21315/api/plugins
```

返回里每个插件带 `error`（如果有）、`web`（浏览器切面路径）。加载失败的插件不会消失——它就停在这个列表里，理由写在一起，页面上会显示一条横幅。
