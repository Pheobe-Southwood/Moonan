# @moonan_ai/moonan

Moonan 平台：建一个 Chord 宿主、开一个端口、把插件目录/包解析成切面模块 URL、把 HTTP 交给插件的
`Routes` 注册表、发布 `WebFacetCatalog` 告诉浏览器该加载哪些切面，并维护统一的 `moonan:data` 文件
与一份插件注册表（「装哪些插件」）。它不含任何功能语义——面板、模型、对话都是插件。

```bash
npx @moonan_ai/moonan
# 或长期使用
npm i -g @moonan_ai/moonan
moonan
```

平台通过 `optionalDependencies` 带上两个官方插件（`ai-gateway` 的「模型」页、`plugin-manager` 的
「插件」页），不需要再传 `--plugin`；`--no-official` 则不加载它们。

打开 <http://127.0.0.1:21315>。第三方插件用 `--plugin` 临时加载，或在「插件」页里添加/启用；
插件要和平台装在**同一棵树**里（同一项目或同一个全局前缀），免得 `@earendil-works/chord` 解析出
两套。

## 参数

| 参数 | 作用 |
|---|---|
| `-p, --port <n>` | 监听端口（默认 `21315`） |
| `-H, --hostname <addr>` | 绑定地址（默认 `127.0.0.1`） |
| `--plugins-dir <dir>` | 启动时扫描插件目录（默认 `~/.moonan/plugins`） |
| `--plugins-file <path>` | 插件注册表（默认 `~/.moonan/plugins.json`） |
| `--data-file <path>` | 统一数据文件（默认 `~/.moonan/data.json`） |
| `-P, --plugin <ref>` | 只对本次进程追加一个插件：包名或目录，可重复 |
| `--no-official` | 不加载内置官方插件 |
| `--safe-mode` | 只加载锁定的官方插件（恢复用） |
| `--allow-management` | 非回环绑定也开启插件管理接口 |
| `--dev` | 校验每次 cell 写入与暴露状态（Chord dev 模式） |
| `--allow-origin <o>` | 同源之外额外放行一个浏览器 origin，可重复 |
| `--max-calls <n>` | 每条 WebSocket 链路的并发调用上限 |
| `--web-dist <dir>` | 用自己构建的 shell 替换内置的那份 |
| `-v, --version` | 打印版本 |

## 插件管理

```bash
moonan plugins list [--json]
moonan plugins add <ref> [--disabled]
moonan plugins enable <ref> | disable <ref>
moonan plugins remove <ref>
```

子命令直接编辑 `plugins.json`，不启动服务器，是坏插件导致启动失败时的恢复通道。服务器运行时则用
`/api/v1/plugins`：`GET` 快照，`POST /enable`、`/disable`、`/install`、`/remove`、`/reload`。启停只把
新增/移除的切面放进一次 `host.reload`（未列出的切面继续运行）；失败时旧切面继续服务。

## 边界

- **没有账号鉴权。** 同源校验与 `--allow-origin` 只拒绝跨源浏览器，不是安全边界。绑定非回环地址时，
  能访问端口的人就能驱动全部插件。命中的插件路由会拒绝浏览器跨站请求（`Sec-Fetch-Site: cross-site`），
  显式 `--allow-origin` 放行的 origin 除外；非浏览器客户端不受影响。
- **插件管理接口默认只在本机可用。** 非回环绑定时返回 403，除非 `--allow-management`；管理接口能改变
  进程加载的代码，必须显式开启。
- **两类持久化。** 可导出的插件数据在 `~/.moonan/data.json`；插件选择在 `~/.moonan/plugins.json`，
  不参与数据导出/导入（导入一个数据文件不能改变启动时加载谁）。
- **单宿主，启动失败会降级。** 一个切面在 `setup` 里抛错时，平台先整体启动失败，再自动用「只加载
  锁定插件」重试一次（注册表不改动）；`--safe-mode` 直接走这条路径。
- **重载粒度是切面。** 启停只把新增/移除的切面放进一次 `host.reload`（未列出的切面继续运行），然后
  `await host.ready()`；手动 `/reload` 重读全部启用的服务端切面，零服务端切面时仍提交空批次
  （revision +1）。

## 配套包

| 包 | 作用 |
|---|---|
| `@moonan_ai/sdk` | 写插件用的通用契约、`DataCodecs` 与浏览器钩子 |
| `@moonan_ai/ai-gateway` | 「模型」面板：配置 pi-ai 的提供商与模型 |
| `@moonan_ai/plugin-manager` | 「插件」面板：启用、停用、添加、移除插件 |

文档：<https://github.com/Pheobe-Southwood/Moonan#readme>

## 许可

MIT
