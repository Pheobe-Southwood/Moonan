# @moonan_ai/moonan

Moonan 平台：建一个 Chord 宿主、开一个端口、把插件目录/包解析成切面模块 URL、把 HTTP 交给插件的
`Routes` 注册表、发布 `WebFacetCatalog` 告诉浏览器该加载哪些切面，管理账户与会话，并维护按账户隔离的
`moonan:data` 数据存储（内嵌 SQLite 数据库 `~/.moonan/data.db`）与一份插件注册表（「装哪些插件」）。
它不含任何功能语义——面板、模型、对话都是插件。

```bash
npx @moonan_ai/moonan
# 或长期使用
npm i -g @moonan_ai/moonan
moonan
```

平台通过 `optionalDependencies` 带上两个官方插件（`ai-gateway` 的「模型」页、`plugin-manager` 的
「插件」「用户」页），不需要再传 `--plugin`；`--no-official` 则不加载它们。

打开 <http://127.0.0.1:21315>。第一次启动会要求创建**第一个管理员**（用户名 + 密码），之后用它登录；
没有自助注册，也没有免登录模式。普通账户由管理员在「用户」页创建和管理。第三方插件用 `--plugin`
临时加载，或在「插件」页里添加/启用；插件要和平台装在**同一棵树**里（同一项目或同一个全局前缀），
免得 `@earendil-works/chord` 解析出两套。

## 账户 · Accounts

- **登录是强制的。** 登录页/初始化页公开（账户库为空时初始化页对能访问端口的人开放，请在可信网络完成第一次设置）；其余 `/api/*`、`/facets/*` 未登录返回 401 `unauthorized`，
  `/ws` 没有有效会话 cookie 直接拒绝。会话 cookie `moonan_session` 是 HttpOnly + SameSite=Lax、30 天；
  部署在 HTTPS 反向代理后时加 `--secure-cookies`。
- **角色只有两个**：`admin` 与 `user`。插件管理（`/api/plugins*`、`/api/v1/plugins*`）与账户管理
  （`/api/v1/users*`）只接受管理员：未登录 401 `unauthorized`，普通用户 403 `admin_required`。
  「普通用户看不到管理员面板」只是界面过滤，服务端会再校验。
- **账户库是独立文件。** 用户、密码散列（scrypt）与会话在 `~/.moonan/auth.db`（`--auth-db` 或
  `MOONAN_AUTH_DB` 可改；schema v1；文件 `0600`、目录 `0700`）。它不在 `/api/data/export` 里；库损坏时
  启动失败，不会静默清空账户。
- **登录限流**：同一「来源地址 + 用户名」15 分钟内失败 5 次后返回 429（带 `retryAfter`）；这是内存减速带，
  进程重启即清空。
- **最后一个管理员**不能被降级或删除；删除普通账户会吊销其会话并清掉它的插件数据（清理失败只回 warning）。
  登出、改密码、改角色、删账户都会让对应的 Chord 对象与链路失效，浏览器回到登录页。

## 参数

| 参数 | 作用 |
|---|---|
| `-p, --port <n>` | 监听端口（默认 `21315`） |
| `-H, --hostname <addr>` | 绑定地址（默认 `127.0.0.1`） |
| `--plugins-dir <dir>` | 启动时扫描插件目录（默认 `~/.moonan/plugins`） |
| `--plugins-file <path>` | 插件注册表（默认 `~/.moonan/plugins.json`） |
| `--data-db <path>` | 插件数据数据库路径（SQLite，默认 `~/.moonan/data.db`；也可 `MOONAN_DATA_DB`） |
| `--auth-db <path>` | 账户数据库路径（SQLite，默认 `~/.moonan/auth.db`；也可 `MOONAN_AUTH_DB`） |
| `-P, --plugin <ref>` | 只对本次进程追加一个插件：包名或目录，可重复 |
| `--no-official` | 不加载内置官方插件 |
| `--safe-mode` | 只加载锁定的官方插件（恢复用） |
| `--secure-cookies` | 给会话 cookie 加 `Secure`（HTTPS 反向代理后使用） |
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

子命令直接编辑 `plugins.json`，不启动服务器，是坏插件导致启动失败时的恢复通道（不需要登录：能运行 CLI
的人本来就有本机代码执行权限）。服务器运行时则用 `/api/v1/plugins`：`GET` 快照，`POST /enable`、
`/disable`、`/install`、`/remove`、`/reload`，全部要求管理员会话。启停只把新增/移除的切面放进一次
`host.reload`（未列出的切面继续运行）；失败时旧切面继续服务。

`/api/plugins` 与 `/api/plugins/reload` 是兼容拼写，现在也要求管理员：前者是插件解析诊断视图，后者重载
服务端切面。没有 `--allow-management`，也没有「管理接口关闭时降级为只读列表」的路径。

## 数据 · Data

- 可导出的插件数据在内嵌 SQLite 数据库 `~/.moonan/data.db`（`--data-db` / `MOONAN_DATA_DB` 可改；WAL +
  事务，文件 `0600`、目录 `0700`）。数据集按 **owner + namespace** 分区：owner 是 `user:<账户 uuid>`；
  `DataStore` 契约 v3、数据库 schema 2，旧版 schema 1 数据在升级时丢弃、不迁移。
- `/api/data/status` 返回全库聚合信息（路径、revision、dataset 总数），任何登录用户都能看；`/api/data/export`
  与 `/api/data/import` **只作用于当前登录账户**，管理员也没有跨账户导出接口。`?includeSecrets=1` 才导出明文密钥。
- 账户库 `auth.db` 与插件数据 `data.db` 各自独立：前者不参与导出，损坏时启动失败；后者损坏时隔离为
  `data.corrupt-<ts>.db` 并从空库开始。
- 插件选择在引擎配置 `~/.moonan/plugins.json`（仍是 JSON），不参与数据导出/导入（导入一份数据 bundle 不能改变
  启动时加载谁）。备份要覆盖 `data.db`、`auth.db` 与 `plugins.json` 三处。

## 边界

- **没有免登录模式。** 同源校验与 `--allow-origin` 只拒绝跨源浏览器，不是认证；鉴权之后才谈角色。命中的插件路由
  会拒绝浏览器跨站请求（`Sec-Fetch-Site: cross-site`），显式 `--allow-origin` 放行的 origin 除外；非浏览器客户端
  不受影响。绑定非回环地址时密码经明文 HTTP 传输，优先用 tailnet 或 HTTPS 反代，不要把端口转发到公网。
- **管理接口是管理员专属。** 插件管理能改变进程加载的代码，账户管理能创建/删除账户；两者都要求管理员会话，
  并校验同源/跨站。
- **单宿主，启动失败会降级。** 一个切面在 `setup` 里抛错时，平台先整体启动失败，再自动用「只加载锁定插件」
  重试一次（注册表不改动）；`--safe-mode` 直接走这条路径。账户库打不开时不降级：没有认证就没有可用平台。
- **重载粒度是切面。** 启停只把新增/移除的切面放进一次 `host.reload`（未列出的切面继续运行），然后
  `await host.ready()`；手动 `/reload` 重读全部启用的服务端切面，零服务端切面时仍提交空批次（revision +1）。

## 配套包

| 包 | 作用 |
|---|---|
| `@moonan_ai/sdk` | 写插件用的通用契约、主体辅助、`DataCodecs` 与浏览器钩子 |
| `@moonan_ai/ai-gateway` | 「模型」面板：按账户配置 pi-ai 的提供商与模型 |
| `@moonan_ai/plugin-manager` | 「插件」「用户」面板：管理插件与账户（仅管理员） |

文档：<https://github.com/Pheobe-Southwood/Moonan#readme>

## 许可

MIT
