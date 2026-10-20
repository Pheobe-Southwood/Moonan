# 0006：持久化用 Node 内置的 node:sqlite

- 状态：接受
- 日期：rc1

## 背景

选择：`node:sqlite`（Node 22.5+ 内置）／`better-sqlite3`（原生模块，需编译）／JSONL 文件／pi-durable 的存储层。

`node:sqlite` 在 Node 22 里仍标记为实验特性，启动会打印 `ExperimentalWarning`。

## 决定

用 `node:sqlite` 的 `DatabaseSync`，开启 WAL、`synchronous = NORMAL`、`busy_timeout = 5000`。
schema 由 `PRAGMA user_version` 驱动的顺序迁移维护，rc1 是 v1。

## 理由

- 零第三方原生依赖：`pnpm install` 不需要编译工具链，也不会因 Node 版本不同重新编译。
- 需要的能力它都有：同步 API（够用，单进程）、事务、WAL、`PRAGMA`。
- 与 pi-durable 的 SQLite 后端用法一致（它也是走 `DatabaseSync`），将来若要换成它的存储层，schema 容易对应。

## 后果

- 好：安装即用；`sqlite3` CLI 可直接查看。
- 差：实验特性，Node 升级可能出现行为变化；启动时的警告要在 README 里解释，避免被当成错误。
- 差：同步 API 会在重查询时阻塞事件循环——rc1 的查询都是小分页，可接受；若将来要跑分析型查询，需要换异步驱动。
