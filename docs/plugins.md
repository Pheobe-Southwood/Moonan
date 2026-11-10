# 写一个插件

一个插件是一个目录或一个 npm 包，提供最多两个切面：

```text
my-plugin/
├── package.json   # 可选：name / version / type / 依赖
├── server.mjs     # 服务端切面
└── web.js         # 浏览器切面
```

两个切面都是 `defineFacet` 的返回值：服务端交给 chord 的 `nodeLoader`，浏览器交给 Moonan 自己的 loader（chord 只提供 Node 那个）。**只有一个切面的插件也是完整插件**——纯后端插件没有 `web.js`，纯前端插件没有 `server.mjs`。

没有 `plugin.json`，也没有插件 ID。目录名或包名只是**显示名**；切面的模块 URL 才是运行时的身份，也是平台装载与重载的单位。

## 两种来源

| 来源 | 怎么被找到 | 入口怎么定 |
|---|---|---|
| 目录 | `--plugin ./my-plugin`，或放进 `--plugins-dir` 的任一子目录 | `server.mjs` / `server.js` 与 `web.js` / `web.mjs`，各自可选 |
| 包 | `--plugin my-plugin` | 包自己的 `exports`：`"."` 是服务端切面，`"./web"` 是浏览器切面，各自可选 |

平台对两者做同一件事：拿到切面模块 URL，交给 Chord。区别只在 URL 从哪来。一个包可以只导出 `"./web"`，一个目录可以只有 `web.js`——平台照样启动，只是没有服务端切面。纯前端插件的启停不触发 chord 提交，但平台会重算它的 web hash；改完 `web.js` 后 `POST /api/plugins/reload`（需管理接口开启）就能让浏览器换上新模块——手动 reload 即使没有服务端切面也会提交一个空批次，revision 照常 +1。

### 依赖从哪来

服务端切面由 Node 按它**自己的位置**解析依赖，平台不接管这一步。这也是 Chord 的规矩：`nodeLoader` 只换掉切面目录里的模块副本，裸说明符（`@earendil-works/chord`、`@earendil-works/pi-schema`、`@moonan_ai/sdk`）仍交给 Node。

所以一个插件目录要么自带 `node_modules`（`npm i @earendil-works/chord @moonan_ai/sdk`，要直接 import `@earendil-works/pi-schema` 的 `lit`/`map` 时再加它），要么放在一个能向上找到这些依赖的目录里。同版本经 Node 的 realpath 去重后仍是**同一个模块实例**，因此「一个进程一份 Chord」不需要平台做任何事；解析不到的插件带着 `error` 停下来，`/api/plugins` 能看到，启动日志 warn 一句。

这是发布形态下最容易踩的一条：平台与插件装在同一棵树里（同一项目或同一全局前缀），npm/pnpm 才会把 `@earendil-works/chord` 去重成一份；装在两个前缀里就是两份。

### 目录插件的 `package.json`

目录插件不要求有 `package.json`；有的话，平台只读 `version` 与 `type`：

```json
{
	"type": "module",
	"dependencies": {
		"@earendil-works/chord": "1.5.0",
		"@moonan_ai/sdk": "workspace:*"
	}
}
```

一条规则值得记住：目录里的 `.js` 服务端入口，如果最近的 `package.json` 没有 `{"type":"module"}`，Node 会当 CommonJS 加载，`export default` 直接失败。平台沿 package scope 查找，所以插件目录的父目录声明 `"type":"module"` 也可以。平台会给出明确错误并跳过这个服务端切面；同目录的 `web.js` 仍可作为浏览器切面出现在 Web 切面目录里。要么写 `.mjs`，要么在目录或父目录加上 `"type": "module"`。

## 服务端切面

```js
import { Routes, defineFacet, hostNamed, local, method, remote, num, obj } from "@moonan_ai/sdk";

const Clock = remote("moonan.clock", {
	version: 1,
	input: obj({}, { open: true }),
	host: hostNamed("moonan"),
	variants: {
		v1: {
			state: { at: num() },
			methods: { tick: method() },
		},
	},
});

export default defineFacet((api) => {
	api.serve(Clock, (_input, _principal, self) => {
		const at = self.state("at", num(), Date.now());
		return { variant: "v1", at, tick: (ctx) => at.change(ctx, () => Date.now()) };
	});
});
```

几个必须知道的事：

- **`hostNamed("moonan")`**：服务端只有一个宿主，名字就是这个。写别的名字，`serve` 会当场拒绝（`"… is declared for host X, but moonan serves it"`），启动直接失败——错误停在服务端，浏览器根本看不到这个类型。
- **生命周期**：默认的对象只活到最后一个引用被释放。想让它常驻，用 `{ lifetime: "host" }`——但只有 `local` 契约、且 `input` 接受 `{}` 的对象可以这样。
- **任务**：`self.task(async (ctx) => {…})` 里用 `ctx.signal` 退出。对象释放时任务跟着停——别在插件里起一个平台关不掉的后台循环。
- **注册表贡献**必须来自 `lifetime: "host"` 对象。这也是为什么例子末尾有一个空的 `Root` 对象。

## 契约要在两边各写一份

浏览器切面拿不到服务端的模块（它是另一个进程、另一套打包），所以契约写两遍。两份不需要共享模块——Chord 认的是**指纹**：名字、版本、成员结构，以及这个类型住在哪个宿主（`host: hostNamed(...)` 也在指纹里，移动类型是破坏性改动）。写了不一致的 schema，浏览器会得到 `upgrade_required`（chord 对 client 的映射；宿主之间的消费者才是 `contract_mismatch`）。

这是刻意的取舍：它换来的是插件可以零构建。有构建的插件当然可以把契约抽成第三个文件、两边 import 同一份；平台对两种写法一视同仁。

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

**只在同一个宿主里生效。** `uses` 检查的是「这次 reload 改到的、由本宿主提供的类型」。所以你写在服务端切面里是有效的（都在 `moonan` 宿主上）；浏览器切面消费服务端类型**不属于此列**——那个类型不在浏览器宿主上，这一条会被跳过，跨宿主的契约靠版本与 `upgrade_required`/`contract_mismatch` 兜底。提供者被整个移除时，chord 对已不存在的 service 跳过这条检查；消费方的引用随移除变 `gone`，不会被一次 `contract_mismatch` 卡住。

`uses` 认的也是指纹，所以不需要共享模块：把契约再写一份丢进去即可。

## 浏览器切面

```js
import { Panels, useReadable, useRemote } from "@moonan_ai/sdk/web";
import { defineFacet, local, method, obj } from "@moonan_ai/sdk";
import { createElement as h } from "react";

function Panel({ host }) {
	const clock = useRemote(host, Clock, {});
	const at = useReadable(clock?.at, 0);
	return h("div", null, new Date(at).toLocaleTimeString());
}

const Root = local("moonan.clock.web", { version: 1, input: obj({}, { open: true }), members: { noop: method() } });

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
- **不要用 `isFatalContractError` 把插件契约失配升级成整页刷新。** 官方的补救是重载 web 切面：外壳在 WebFacetCatalog 报告 `web.hash` 变化时会做，面板只负责显示过期状态。若切面没变而 `upgrade_required` 持续出现，说明插件的 web 代码与契约不同步——重载同一文件或刷新整页都修不了，改插件才是修法。
- `useReadable` 接受任何 chord `Readable<T>`——cell、derivation、别人对象的 state 成员都行，不限于本插件自己的契约。
- 浏览器切面应当是一个**单个 ESM 文件**。浏览器没有模块 hook，重载时只有入口 URL 的缓存参数会变，相对 import 的子文件仍命中缓存——把切面拆成多文件，热重载就只换掉入口。
- `title` 是纯字符串，外壳原样显示。面板自己决定写什么语言。
- `order` 决定标签顺序，同值保持注册顺序。
- 你不需要打包。`import "react"`、`import "@moonan_ai/sdk/web"`、`import "@earendil-works/pi-schema"` 由外壳的 import map 指到 `/runtime/*.js`：整个页面只有一份 React、一份 Chord、一份 pi-schema。多一份 React 会让 hooks 报错——而且表现为「面板不出现」，不是一条明确的报错。

## 直接用 Chord

`@moonan_ai/sdk` 把 Chord 的原语再导出了：`remote`、`local`、`method`、`hostNamed`、`defineFacet`、`defineRegistry`，以及 `forbidden`、`invalid`、`isChordError`、`BACKGROUND_CONTEXT`、`Context` 等错误/上下文入口。契约 schema 的构建器也在这里：`obj`、`str`、`num`、`int`、`bool`、`nul`、`unknown`、`arr`、`union`、`opt`、`literal`、`record`、`compile`，以及类型 `Schema`、`Static`（都是 `@earendil-works/pi-schema` 的再导出；`literal`、`record` 是 SDK 补的两个指纹稳定形式，写契约时用它俩而不是 `lit`/`map`）。插件不直接依赖 Chord 也能写完整功能。想用更深的 API（`track`、`applyImmutable` 等），装 `@earendil-works/chord` 即可，版本对齐 `1.5.0`；浏览器切面还可以直接 `import "@earendil-works/chord/context"` 或 `/delta`，import map 已提供这两个入口。

## 统一数据

平台提供一个统一数据文件：默认 `~/.moonan/data.json`，可用 `MOONAN_DATA_FILE` 或
`--data-file` 改。插件通过 `DataStore`（local、host-lifetime）读写自己的 namespace；要让
数据参与统一导出/导入，再向 `DataCodecs` 注册一个 codec。

```js
import { DataCodecs, DataStore, defineFacet, local, obj, str } from "@moonan_ai/sdk";

const Root = local("example.data-root", {
	version: 1,
	input: obj({}, { open: true }),
	members: {},
});

export default defineFacet((api) => {
	api.serve(Root, (_input, _p, self) => {
		const data = self.get(DataStore, {});
		const value = self.state("value", str(), {
			init: async (ctx) => {
				const stored = await data.read({ namespace: "example/config" }, ctx);
				return stored === undefined ? "empty" : String(stored.value);
			},
		});

		self.register(DataCodecs, {
			"example/config": {
				namespace: "example/config",
				version: 1,
				migrate: (stored, from) => String(stored),
				export: (stored) => stored,
				import: (stored, from, current) => String(stored),
			},
		});

		// 导入或外部 reload 后，把权威数据同步回投影 cell。
		self.on("data", data.revision, async (_revision, ctx) => {
			const stored = await data.read({ namespace: "example/config" }, ctx);
			const next = stored === undefined ? "empty" : String(stored.value);
			if (next !== value.value) value.replace(ctx, next);
		});

		return { value };
	}, { lifetime: "host" });
}, { uses: [DataStore] });
```

- `read` 返回 `{ value, version } | undefined`，不查 codec；插件自己校验/迁移第一个值。
- `update` 是推荐的读改写入口：它和 `importAll` 在同一个串行队列里，不会丢更新。它的 `update` 回调只在同一进程内有效——`DataStore` 是 `local` 契约，回调没有线上表示；平台会在运行时拒绝非函数，也不要把 `DataStore` 改成 `remote` 类型。
- `write` 只做整值替换。
- `exportAll` 只导出有 codec 的 namespace；`importAll` 要求每个 dataset 都有 codec，任一失败不写文件。
- `includeSecrets` 默认 `false`；codec 的 `export` 负责脱敏，`import` 负责从 `current` 合并回被省略/脱敏的密钥与敏感值。
- 数据文件损坏时先试 `.bak`；再不行保留 `data.corrupt-<timestamp>.json` 并从空数据开始。

不想参与统一导出/导入的缓存或二进制资产，仍可由插件自己开文件；它们不在 `/api/data/export` 里。

## 模型注册表

其他服务端插件如果要使用 ai-gateway 配置好的模型，不直接 import ai-gateway 的内部模块，而是查
`ModelProviders` 注册表：

```js
import { defineFacet, invalid, local, obj } from "@moonan_ai/sdk";
import {
	AI_GATEWAY_PROVIDER_ID,
	ModelProviders,
	isAiGatewayModelProvider,
} from "@moonan_ai/ai-gateway/model-provider";

const Root = local("example.chat-root", { version: 1, input: obj({}, { open: true }), members: {} });

export default defineFacet((api) => {
	const providers = api.registry(ModelProviders);
	api.serve(Root, (_input, _p, self) => {
		// 在方法里用 ctx 查表，旧根看旧代码版本的表：
		return {
			ask: async (args, ctx) => {
				const current = providers.get(AI_GATEWAY_PROVIDER_ID, ctx);
				if (!isAiGatewayModelProvider(current)) throw invalid("args", "ai-gateway is not installed");
				const runtime = current.runtime();
				const model = runtime.models.getModel(args.provider, args.model);
				// 用 pi-ai 的 Models API 发起请求
			},
		};
	}, { lifetime: "host" });
});
```

- 注册表值来自 host-lifetime 对象的 `self.register(ModelProviders, ...)`；表随代码版本替换。
- `list()` 是 key-free 的模型目录；`runtime()` 是 server-only 的 `MutableModels`，含凭据，绝不能给浏览器。
- 在同一个配置 revision 内，`runtime()` 返回同一个 `MutableModels` 实例；配置变化（新增/删除 provider 或模型、改凭据）会重建它。不要对它 `setProvider` / `deleteProvider`，那会改到别的消费者手里的实例；持有旧 handle 的一方看到的是旧模型集合，按 `runtime().revision` 判断是否需要重新获取。
- `runtime().models.stream/complete` 是进程内调用，不是 Chord 调用：长请求放进 `self.task` 或短根，并把 `ctx.signal` 传进 pi-ai 的 options，取消才会跟着根走。
- 消费者不需要 `uses`（注册表不是契约）；如果还直接消费 `DataStore` 等契约，再写 `uses`。
- ai-gateway 未安装时 `get` 返回 `undefined`，消费者自行降级。

## 插件管理（启用 / 停用 / 安装 / 移除）

平台把「装哪些插件」放在 `~/.moonan/plugins.json`（`--plugins-file` / `MOONAN_PLUGINS_FILE` 可改），
与统一数据文件分开：平台必须在建 Chord 宿主之前就知道加载谁，而 `moonan:data` 是宿主里的一个切面；
另外，数据导入不应该能改变下次启动加载哪些插件。

```json
{
  "format": 1,
  "updatedAt": "2026-11-10T00:00:00.000Z",
  "plugins": [
    { "ref": "@moonan_ai/ai-gateway", "enabled": true },
    { "ref": "/Users/me/plugins/my-plugin", "enabled": false }
  ]
}
```

- `ref` 是分发地址：包名，或目录的绝对路径（添加时规范化）。
- `builtin`/`locked` 不落盘：来自平台 `package.json` 的 `moonan.officialPlugins`。官方插件同时出现在
  `optionalDependencies` 里，所以装平台时自动带上。
- 首启时官方默认自动合并进来；`--plugin` 与 `--plugins-dir` 扫描到的条目是 **ephemeral**（只对本次进程
  有效）。在管理页里对 ephemeral 条目做启用/停用/添加，会把它「收养」成注册表条目；对已经启用的
  ephemeral 条目再点一次「启用」同样会收养并落盘。
- 文件损坏时先试 `.bak`；再不行保留 `plugins.corrupt-<timestamp>.json` 并从官方默认开始。权限 `0600`，目录 `0700`。

### HTTP 接口

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/api/v1/plugins` | 快照：条目（含停用）、`enabled`/`server`/`loaded`/`startupSkipped`、`error`、版本、revision、路径、降级启动信息 |
| POST | `/api/v1/plugins/enable` | `{ "id": "<ref>" }` |
| POST | `/api/v1/plugins/disable` | `{ "id": "<ref>" }` |
| POST | `/api/v1/plugins/install` | `{ "ref": "<包名或目录>", "enable": true }`（`enable` 可省，默认 true） |
| POST | `/api/v1/plugins/remove` | `{ "id": "<ref>" }` |
| POST | `/api/v1/plugins/reload` | 重新解析并重载**当前全部**服务端切面（零服务端切面时仍提交空批次） |
| GET | `/api/plugins` | 兼容的只读诊断：解析结果 + 启停/ephemeral/skipped 标记。**不受管理开关限制**——管理接口关闭时「插件」页用它降级展示 |
| POST | `/api/plugins/reload` | 兼容旧拼写；与 `/api/v1/plugins/reload` 完全同一套管理策略 |

`id` 就是 `ref`。`install` **不下载**：它只解析并登记已安装的包/目录；包不存在时返回 `resolve_failed`，
附带 `plugin.error`。把 `enable` 设为 `true` 时会顺带执行一次启用事务；启用失败时条目保留为停用。

`loaded` 的准确含义：**这个插件提供的东西在本进程里全部就位**——有服务端切面的，切面已安装；纯 web 插件
没有服务端工作可等，已发布到浏览器即算 loaded。`server` 表示插件是否有服务端切面，UI 用它区分「未加载」
（有服务端切面但没装上）与「已发布（浏览器按需加载）」（纯 web）。

响应：成功 `{ ok, changed, reloadBrowser, revision, plugin? }`；失败 `{ error, code, reason?, chordCode?,
committed?, plugin? }`，状态码 `400/403/404/409/500`。`changed` 表示插件列表/启用状态/解析结果变了，
`reloadBrowser` 表示启用中的浏览器切面集合（`url#hash`）变了。对 `/reload`，`changed` 只是把 Chord 的
`ReloadReport` 归纳成布尔：是否有类型被重新 serve（`report.changed` 是 Chord 的类型名）——没有服务端切面的
空批次是 `false`；重新列出切面会换掉它们的 service 身份，所以只要切面提供类型就是 `true`（哪怕代码没变）。
**`revision` 才是「一次提交已发生」的信号**（每次提交 +1，空批次也算）。

**控制面走 HTTP，不走 Chord 远程对象。** 启停要提交一次 `host.reload`，而 reload 会等待根结束：gate/retire
各有默认 5 秒期限。超期时 Chord abort 的是**这次 reload**（`aborted/gate_deadline`，错误里列出阻塞的根），
retire 超期则 abort 旧代码版本的根（`superseded`）；驱动它的调用会收到这次 reload 的错误（若它自己正跑在
要退休的版本上，则是 `superseded`），不会永久自锁。所以管理动作留在 HTTP 处理路径、`host.root` 之外直接调用；
`/api/plugins/reload` 和 `/api/v1/plugins/reload` 都是这样。

### 启停语义

Chord 的 reload 接收「这次要（重新）加载的切面」和「这次要移除的切面」，**没列出的已安装切面继续运行**。
平台据此做增量提交：管理动作只重载它真正改动的部分。

- **启用/添加**：只把**新增**的服务端切面 URL 放进 `host.reload([...新增])`——Chord 加载新模块并安装切面；
  其他切面不重跑 `setup`、不丢对象/状态。
- **停用/移除**：`host.reload([], { remove: [...] })`。被移除类型的引用变 `gone`，`report.removed` 给出
  类型名。移除 provider 不会让 prepare 失败（Chord 对已移除 service 跳过 `uses` 检查），消费方的引用
  随之下线；消费方自己负责降级（例如 ai-gateway 未启用时 `ModelProviders.get(...)` 返回 `undefined`）。
- **同一次操作既新增又移除**：两者一起传进同一个 `host.reload(added, { remove })`，仍是一个批次。
- **只有 web 切面变化**（例如启停一个纯前端插件）：不产生 chord 提交；更新 `WebFacetCatalog`，浏览器按
  `url#hash` 换切面。手动 `/reload` 是例外：即使没有服务端切面它也提交一个空批次，revision 照常推进。
- **事务性**：先重新解析全部条目、算出 next/added/removed，再 `host.reload`；提交成功后才会替换已发布的
  插件列表并写 registry。reload 被拒绝时旧切面继续服务，列表不变。提交成功但 `host.ready()` 失败时，
  提交仍是既成事实：平台会发布已提交的列表并持久化，同时把这次请求报成失败（`committed: true`）。
- 同一个进程内所有 mutation 串行执行（Chord 自身也拒绝并发 reload）。
- `nodeLoader` 每次 import 模块且不 evict 旧副本（上游已知限制）。增量 reload 只在新增切面时 import，
  停用甚至不 import；内存增长不再按「每次启停 × 插件数量」放大。手动 reload 仍会重读全部启用的
  服务端切面。

### CLI

```bash
moonan plugins list [--json]
moonan plugins add <ref> [--disabled] [--plugins-file <path>]
moonan plugins enable <ref> | disable <ref>
moonan plugins remove <ref>
```

子命令不启动服务器，直接读写注册表，是启动失败时的恢复通道。内置插件不能 `remove`（它每次启动都会
被官方默认重新合并，停用才是正确操作）；锁定条目 `disable` 需要 `--force`。

### 安全与恢复

- 管理接口默认只在回环绑定可用；非回环绑定时返回 403 `management_disabled`，除非 `--allow-management`。
  它同样校验 `Origin` 与 `Sec-Fetch-Site`。没有账号鉴权：能改插件列表 = 能让进程加载任意代码。
- 启动失败时的降级：平台先记录错误，再以「只隔离全部非锁定条目」重试一次（registry 不改动），让「插件」页
  能打开并逐个启用定位；`--safe-mode` 直接只加载锁定的官方插件。若降级启动也失败，原始错误照常抛出。
- 移除不会删除 npm 包或目录；需要彻底卸载请自己 `npm uninstall` / 删目录。

## 检查平台解析到了什么

```bash
curl http://127.0.0.1:21315/api/plugins
```

返回里每项带 `name`、`version`、`source`、`web`（浏览器切面 `{ url, hash }`）和 `error`（如果有），
现在还附带 `enabled`/`builtin`/`locked`/`ephemeral`/`startupSkipped`；`serverInstalled` 只留在平台内部
记录里。解析失败的插件不会消失——它停在这个列表里，理由写在一起，页面上会显示一条横幅。

要管理插件（含停用条目与路径）用稳定接口：

```bash
curl http://127.0.0.1:21315/api/v1/plugins
```

`/api/plugins` 仍是只读诊断接口（`experimental: true`），且**不受管理开关限制**：管理接口关闭时「插件」页
就是靠它降级成一个只读列表。

## 热重载

```bash
curl -X POST http://127.0.0.1:21315/api/plugins/reload
# 等价的稳定接口（管理页用）：
curl -X POST http://127.0.0.1:21315/api/v1/plugins/reload
```

两个路径都是管理接口：默认只在回环绑定可用，非回环且没开 `--allow-management` 时返回 403
`management_disabled`；它们同样校验 `Origin` 与 `Sec-Fetch-Site`。

没有 body，也没有插件 ID：平台先重新解析所有已知 ref（删除/改名的入口因此变成 `remove` 的切面，web 文件
的内容 hash 也重算）。**手动 reload 是唯一会重读已安装模块的路径**：把**当前全部服务端切面**放进同一个
`host.reload` 批次（重新 import 磁盘上的模块），然后 `await host.ready()`。因此：

- breaking contract 的 provider 与 consumer 永远在同一批里，不会被拆开；
- 零服务端切面时仍提交一个空批次：revision 照常 +1，这是「reload 确实运行过」的可观测信号；
- 纯 web 变化只更新 Web 切面目录，不产生 chord 提交；
- 新宿主对象激活失败会变成一次失败请求，而不是「reload 成功但对象没起来」；提交本身已经生效，所以目录仍会发布已提交的切面集合；
- 旧代码在旧根跑完后退休，这是 Chord 自己的事务语义；
- web facet 的内容 hash 变化时，响应里的 `reloadBrowser` 为 true；只改服务端时它是 false；
- 删除或改名一个服务端入口会在下一次 reload 真正下线：chord 的 `remove` 让被移除类型的引用变 `gone`，`report.removed` 给出类型名；
- reload 被拒绝（prepare 失败）时不发布目录，旧切面继续服务；下一次 reload 会重试；
- 平台自身的 facet 代码或 `--plugins-dir` 扫描结果需要重启进程；插件的安装/启用/停用已经可以通过管理接口在运行时完成。

响应里的 `report` 是 Chord 的 `ReloadReport`：`report.changed`/`report.removed` 是 **Chord 类型名**
（契约类型，例如 `moonan.clock`），`report.prepared`/`report.gated` 是对象地址——它们都不是插件名，
也不是切面 URL。要对应回插件，用切面 URL（模块身份）或 `/api/v1/plugins` 的条目。

开发时加 `--dev`（`pnpm dev` 已经带上）：chord 会校验每次 cell 写入与暴露状态，把 schema 漂移提前暴露成一条 `invalid`，而不是等到远端消费者。

Chord 的 `nodeLoader` 每次 import 都会得到一份新的模块副本，且不会 evict 旧副本（上游已知限制）。手动
reload 会重读全部启用的服务端切面，所以频繁手动 reload 仍会让进程内存增长，长期运行的会话可以定期重启；
管理动作的增量 reload 只 import 新增的切面（停用/移除不 import），不再把这份开销乘以插件数量。

启动时如果某个服务端切面 `setup` 抛错，平台会关闭宿主并让这次启动失败——Chord 的 `install` 不是回滚事务，继续运行会留下半个插件。随后 `start` 会记录错误，并以「只隔离全部非锁定条目」再启动一次；仍失败才真正退出。被隔离的插件在 `GET /api/v1/plugins` 里是 `startupSkipped`，配置没有被改写：修好后可以在「插件」页重新启用，或重启进程再试，或用 `--safe-mode` 进恢复壳。
