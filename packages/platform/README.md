# @moonan_ai/moonan

Moonan 平台：建一个 Chord 宿主、开一个端口、把插件目录/包解析成切面模块 URL、把 HTTP 交给插件的
`Routes` 注册表、发布 `WebFacetCatalog` 告诉浏览器该加载哪些切面，并维护一个统一的 `moonan:data` 文件。
它不含任何功能语义——面板、模型、对话都是插件。

```bash
npx @moonan_ai/moonan --plugin @moonan_ai/ai-gateway
# 或长期使用
npm i -g @moonan_ai/moonan @moonan_ai/ai-gateway
moonan --plugin @moonan_ai/ai-gateway
```

打开 <http://127.0.0.1:21315>。平台自己不带面板：不传 `--plugin` 时是一个没有标签页的空壳。

> 插件要和平台装在**同一棵树**里（同一项目或同一全局前缀）。插件按自己的位置解析
> `@earendil-works/chord`，两处安装会得到两份 chord，切面装不上。

## 参数

| 参数 | 作用 |
|---|---|
| `-p, --port <n>` | 监听端口（默认 `21315`） |
| `-H, --hostname <addr>` | 绑定地址（默认 `127.0.0.1`） |
| `--plugins-dir <dir>` | 扫描插件目录（默认 `~/.moonan/plugins`） |
| `--data-file <path>` | 统一数据文件（默认 `~/.moonan/data.json`） |
| `-P, --plugin <ref>` | 追加一个插件：包名或目录，可重复 |
| `--dev` | 校验每次 cell 写入与暴露状态（Chord dev 模式） |
| `--allow-origin <o>` | 同源之外额外放行一个浏览器 origin，可重复 |
| `--max-calls <n>` | 每条 WebSocket 链路的并发调用上限 |
| `--web-dist <dir>` | 用自己构建的 shell 替换内置的那份 |
| `-v, --version` | 打印版本 |

## 边界

- **没有账号鉴权。** 同源校验与 `--allow-origin` 只拒绝跨源浏览器，不是安全边界。绑定非回环地址时，
  能访问端口的人就能驱动全部插件。
- **平台只落一个统一数据文件。** `moonan:data` 维护 `~/.moonan/data.json`；插件注册 `DataCodecs` 后，其 namespace 才能被统一导出/导入。
- **单宿主、启动即定。** 一个服务端切面在 `setup` 里抛错会让整次启动失败。
- **重载粒度是切面。** `POST /api/plugins/reload` 把全部服务端切面放进一次 `host.reload`。

## 配套包

| 包 | 作用 |
|---|---|
| `@moonan_ai/sdk` | 写插件用的契约、`DataCodecs`/`ModelProviders` 注册表与浏览器钩子 |
| `@moonan_ai/ai-gateway` | 「模型」面板：配置 pi-ai 的提供商与模型 |

文档：<https://github.com/Pheobe-Southwood/Moonan#readme>

## 许可

MIT
