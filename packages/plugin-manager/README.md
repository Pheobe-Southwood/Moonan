# plugin-manager

Moonan 的官方管理插件：提供两个**只有管理员可见**的面板。

- 「插件」：列出所有插件，并提供启用、停用、添加（登记已安装的包或本地目录）、移除与重新加载。
- 「用户」：列出账户（用户名、角色、创建/更新时间），提供创建账户、重置密码、切换角色、删除账户，
  并标出当前登录的管理员。

它是纯浏览器插件（只有 `"./web"` 导出），通过平台的 `/api/v1/plugins` 与 `/api/v1/users` 控制面工作。
两个面板都标记 `adminOnly`：普通用户登录后看不到标签页；服务端接口也只接受管理员（未登录 401
`unauthorized`，普通用户 403 `admin_required`）。平台在 `moonan.officialPlugins` 里把它标记为
`locked`：不能在界面里把管理页自己停用或移除；需要时用 `moonan plugins` 或 `--safe-mode` 从命令行恢复。

```bash
npm i -g @moonan_ai/moonan   # 平台通过 optionalDependencies 带上本插件
moonan
```

第一次启动先在浏览器里创建管理员并登录，然后打开 <http://127.0.0.1:21315/#/plugins> 或
<http://127.0.0.1:21315/#/users>。

## 能做什么

### 插件面板

- **启用 / 停用**：立即生效。服务端切面走一次 Chord `host.reload`，浏览器切面随 `WebFacetCatalog`
  自动上下线；状态写进 `~/.moonan/plugins.json`，重启后保持。
- **添加**：输入包名（已安装在平台所在安装树或当前工作目录）或绝对/相对目录。平台**不会联网下载**；
  包不存在时给出可直接复制的 `npm i` 命令。添加后默认立即启用，也可以先停用。
- **移除**：只从加载清单移除，不卸载 npm 包、不删除目录。内置插件不能移除（但可以停用）。
- **重新加载**：重新解析入口并重载全部启用的服务端切面（等价于 `POST /api/plugins/reload`）。
- **诊断**：解析错误、启动隔离（降级启动留下的插件）、`plugins.json` 损坏恢复提示、插件数据与账户数据库路径。

### 用户面板

- **创建账户**：用户名 + 密码 + 角色（`admin` / `user`）；用户名唯一且不区分大小写，密码 8–200 字符。
- **重置密码**：管理员直接设置新密码（不需要旧密码）；该账户的全部会话会被吊销，需要重新登录。
- **切换角色**：管理员 ↔ 普通用户；最后一个管理员不能被降级。
- **删除账户**：最后一个管理员不能删除；删除后该账户的会话失效，平台会同时清掉该账户的插件数据
  （例如 ai-gateway 的配置与密钥）。清理失败时面板显示警告——账户已经删除，残余数据不可再访问。
- **当前账户**：列表里标出「我」，避免管理员误删/误改自己。

## 边界

- **只有管理员能用。** 面板靠 `adminOnly` 不渲染给普通用户；接口在服务端再校验角色，普通用户直接发 HTTP
  请求也会得到 403。没有「管理接口不可用时回退到只读 `/api/plugins` 列表」的路径了。
- **账户管理会吊销会话。** 重置密码、改角色、删除账户都会让目标账户的 Chord 对象失效并回到登录页；
  管理员改的是别人的会话，自己的会话不受影响（改自己时除外）。
- 页面不写 `localStorage`/`sessionStorage`/IndexedDB。
- 插件启停不会删除插件写过的数据；只有删除账户会清理该账户的数据集。

## 开发

```bash
pnpm install
pnpm --filter @moonan_ai/plugin-manager build
pnpm --filter @moonan_ai/plugin-manager test
```

浏览器切面由 `scripts/build-web.mjs` 打成单文件 `dist/web.js`；React、Chord 与 SDK 由外壳的 import map
提供，构建时保持 external。控制器代码（`src/web/api.ts`、`src/web/users-api.ts`）只依赖 SDK 导出的
`PluginAdmin*` 与 `UserAdmin*` 类型。
