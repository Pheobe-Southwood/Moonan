# 发布产物只在 CI 里构建

`main` 上的每个提交由 GitHub Actions 跑类型检查、测试、Playwright e2e，然后构建并发布 npm 包。本地只跑 `pnpm dev`、`pnpm typecheck`、`pnpm test`，不产出可发布的 tarball。

这么做是为了让「发布出去的那份代码」和「CI 上验证过的那份代码」是同一个东西。本地手滑的 `pnpm build` 很容易带上未提交的改动，或者因为 Node 版本不同产出不一样的结果。

**Consequences**: 断网时无法验证构建；构建脚本的改动只能通过推分支看 CI 结果来确认。
