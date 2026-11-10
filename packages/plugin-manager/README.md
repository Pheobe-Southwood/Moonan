# plugin-manager

Moonan 的官方「插件」面板：列出所有插件，并提供启用、停用、添加（登记已安装的包或本地目录）、
移除与重新加载。

它是纯浏览器插件（只有 `"./web"` 导出），通过平台的 `/api/v1/plugins` 控制面工作。平台在
`moonan.officialPlugins` 里把它标记为 `locked`：不能在界面里把管理页自己停用或移除；需要时用
`moonan plugins` 或 `--safe-mode` 从命令行恢复。

```bash
npm i -g @moonan_ai/moonan   # 平台通过 optionalDependencies 带上本插件
moonan
```

打开 <http://127.0.0.1:21315/#/plugins>。

## 能做什么

- **启用 / 停用**：立即生效。服务端切面走一次 Chord `host.reload`，浏览器切面随 `WebFacetCatalog`
  自动上下线；状态写进 `~/.moonan/plugins.json`，重启后保持。
- **添加**：输入包名（已安装在平台所在安装树或当前工作目录）或绝对/相对目录。平台**不会联网下载**；
  包不存在时给出可直接复制的 `npm i` 命令。添加后默认立即启用，也可以先停用。
- **移除**：只从加载清单移除，不卸载 npm 包、不删除目录。内置插件不能移除（但可以停用）。
- **重新加载**：重新解析入口并重载全部启用的服务端切面（等价于 `POST /api/plugins/reload`）。
- **诊断**：解析错误、启动隔离（降级启动留下的插件）、`plugins.json` 损坏恢复提示、注册表/数据文件路径。

## 边界

- 管理接口默认只允许回环地址；绑定局域网/Tailnet 时需显式 `--allow-management`。
- 管理接口没有账号鉴权，只有同源/跨站校验；它等价于本机代码执行入口。
- 页面不写 `localStorage`/`sessionStorage`/IndexedDB。
- 管理接口不可用时，面板回退到只读的 `GET /api/plugins` 列表。

## 开发

```bash
pnpm install
pnpm --filter @moonan_ai/plugin-manager build
pnpm --filter @moonan_ai/plugin-manager test
```

浏览器切面由 `scripts/build-web.mjs` 打成单文件 `dist/web.js`；React、Chord 与 SDK 由外壳的 import map
提供，构建时保持 external。
