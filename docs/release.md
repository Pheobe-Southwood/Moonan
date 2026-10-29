# 发布

三个包上 npm：`@moonan_ai/sdk`、`@moonan_ai/moonan`、`@moonan_ai/ai-gateway`。
`@moonan_ai/web` **不发**（见文末）。

## 版本真源

`packages/platform/src/index.ts` 里的 `VERSION` 常量是唯一真源——`moonan --version` 打印的就是它。
四处必须一致，`packages/platform/test/packaging.test.ts` 会盯着：

| 位置 | 用途 |
|---|---|
| `packages/platform/src/index.ts` 的 `VERSION` | 运行时版本 |
| 根 `package.json` 的 `version` | 工作区版本 |
| `packages/{sdk,platform,ai-gateway,web}/package.json` 的 `version` | 发布出的版本 |
| git 标签 `v<version>` | 触发发布工作流 |

改版本时一起改，然后 `pnpm test`。

## 发布顺序

`sdk` → `moonan` → `ai-gateway`。顺序不能颠倒：pnpm 发布时会把 `@moonan_ai/sdk: workspace:*`
改写成**真实版本号**，`sdk` 不在注册表里时，后两个包装得上、用的人装不上。

## 手动发一次

```bash
pnpm install
pnpm typecheck && pnpm build && pnpm test     # dist/ 是构建产物，gitignore 的；不 build 就发个空包
pnpm -r --filter "./packages/*" exec npm pack --dry-run   # 看 tarball 里到底有什么

cd packages/sdk        && pnpm publish --tag alpha --access public --no-git-checks
cd ../platform         && pnpm publish --tag alpha --access public --no-git-checks
cd ../ai-gateway       && pnpm publish --tag alpha --access public --no-git-checks

npm dist-tag add @moonan_ai/sdk@<version> latest
npm dist-tag add @moonan_ai/moonan@<version> latest
npm dist-tag add @moonan_ai/ai-gateway@<version> latest
```

必须用 `pnpm publish`（不是 `npm publish`）：只有它会把 `workspace:*` 换成真实版本、并且不把工作区
独有字段带进 tarball。

## dist-tag 策略

版本号是预发布（`0.0.5-alpha3` 这种），但仍然同时占 `latest`：

- `alpha` 标签记这一代的历史；
- `latest` 决定 `npx @moonan_ai/moonan` 装到哪一版。注册表里的 `latest` 曾经停在 Chord 重写前的
  `0.0.1-alpha1`，一个真正的消费者用 `npx` 会拿到上一代产品——所以新的预发布版本也要顶到 `latest`。

要改这个策略，只需删掉工作流里 `Point latest at this version` 那一步。

## 自动发布（GitHub Actions）

`.github/workflows/publish.yml`：推 `v*` 标签或手动触发。

1. 仓库 secret 里要有 `NPM_TOKEN`（npm automation/publish 权限的 token）。缺它会在发布那一步 401。
2. 标签必须等于 `package.json` 里的版本，否则工作流在 build 之前就失败。
3. 工作流跑完整的 `typecheck` / `build` / `test` 再发布，顺序同上一节，带 `--provenance`
   （仓库是 public，`id-token: write` 已声明）。
4. **幂等**：每个包先查 `npm view <name>@<version>`，已经在 npm 上就跳过。所以同一个 commit 再打一次
   标签不会变成"重复发布"失败——手动发过的版本可以安全地补标签。

```bash
git tag v0.0.5-alpha3 && git push origin v0.0.5-alpha3
```

## 发布不是立刻可见的

第一次发布一个包名时，注册表会先回一个 `0.0.0-stage` 占位版本（"Temporary package placeholder for
staged publishing"），真正的版本在 npm 的审核/传播结束之后才出现。0.0.4-alpha2 这一版实测 1–3 分钟：

```bash
curl -s https://registry.npmjs.org/@moonan_ai%2fsdk | node -e '…versions, dist-tags…'
```

看到只有 `0.0.0-stage` 不代表发布失败，等一会儿再看。`0.0.0-stage` 会一直留在版本列表里，而它一开始
会占住 `latest`——这就是 `Point latest at this version` 那一步存在的第二个理由：发完必须把 `latest`
搬到真实版本上（这次 `moonan` 的 `latest` 还停在更旧的 `0.0.1-alpha1`，是手动搬的）。

如果版本进了 npm 的 Staged Packages 队列（账号开了 2FA 时可能发生），它不会自动上线，需要维护者用
2FA 批准：

```bash
npm stage list <包名>        # npm >= 11.15；列出待批准的 stage-id
npm stage approve <stage-id> # 提示输入 2FA
```

也可以在 npmjs.com 的 Staged Packages 标签页里点 Approve。批准之后再执行一次 `latest` 的 `dist-tag add`。
工作流的最后一步会轮询 10 分钟，等不到就会失败并打印这两条命令。

## 同版本不可重发

npm 上已经存在的版本无法覆盖，只能升版本号重发。发布失败后先看是哪一步断的：`sdk` 成功、`moonan`
失败时，重跑只需要后两个（用上面的命令，或让工作流跳过已有的那个）。**不要**为了重跑而改回旧版本号。

## 发布后验证

1. `npm view @moonan_ai/moonan dependencies dist-tags` —— `@moonan_ai/sdk` 是 `0.0.4-alpha2` 而不是
   `workspace:*`，`latest` 与 `alpha` 都指向新版本。
2. 干净项目：

   ```bash
   tmp=$(mktemp -d) && cd "$tmp" && npm init -y >/dev/null
   npm i @moonan_ai/moonan @moonan_ai/ai-gateway
   npx moonan --version
   npx moonan --port 21399 --plugin @moonan_ai/ai-gateway &
   curl -s 127.0.0.1:21399/api/plugins     # 两个切面，没有 error
   curl -s 127.0.0.1:21399/ | grep -c importmap
   ```

3. `ls node_modules/@earendil-works/chord` 只有一份。平台与插件必须共享同一个 chord 实例：插件按
   自己的位置解析依赖，装在两个前缀里就是两份，切面会装不上。这也是 README 里"两个包装在同一棵树"
   那句话的由来。

## 为什么要 deprecate 上一代

`@moonan_ai/moonan` 的 `0.0.1-alpha*`（含最初那个 `0.0.0-stage`）是 Chord 重写前的产品，
`plugin-sdk` / `web-api` / `plugin-{mcp,chat,logs,agents,providers}` 是那一代的插件。它们已经不可用，
deprecate 让 `npm i` 时能看到迁移提示：

> 注意区分：每个包上现在还有一个**新的** `0.0.0-stage`，那是 npm 在"包名第一次发布"时自己放的占位
> 版本，不是我们的代码，也已经标了 deprecate 的是旧的那个。

```bash
# 旧平台版本：显式列版本号，因为 semver 范围默认匹配不到预发布版本
for v in 0.0.0-stage 0.0.1-alpha1 0.0.1-alpha2 0.0.1-alpha3 0.0.1-alpha5; do
  npm deprecate "@moonan_ai/moonan@$v" "Moonan 已重写为 Chord 上的平台；这是 0.0.4 之前的产品，请用 0.0.4-alpha2 或更新版本。"
done

# 旧插件包：不带版本号，一次覆盖全部版本（含预发布）
for p in plugin-sdk web-api plugin-mcp plugin-chat plugin-logs plugin-agents plugin-providers; do
  npm deprecate "@moonan_ai/$p" "已被 0.0.4 的 Moonan 平台取代（@moonan_ai/sdk + @moonan_ai/moonan）。"
done
```

## `@moonan_ai/web` 为什么不发

`packages/web` 是浏览器外壳与共享运行时的打包器，`private: true`。`pnpm build` 会把它的 `dist/`
原样拷进 `packages/platform/dist/web/`（`packages/platform/scripts/copy-web.mjs`），也就是已经随
`@moonan_ai/moonan` 发过了。再单独发一份只是把同样的文件在注册表里放两遍，最终用户一个字节也用不上。

代价是明确的：平台发布物里的 `@moonan_ai/web` 是 `devDependencies` 中的 `workspace:*`，发布时会被
改写成 `0.0.4-alpha2`，而这个版本在 npm 上不存在。`npm i @moonan_ai/moonan` 不受影响（依赖包的
`devDependencies` 不会被安装），但"下载 tarball 后自己 `pnpm install && pnpm build`"这条路不可用。
真要开放这条路，就把 `packages/web` 改成可发布，并同步 `packaging.test.ts` 里的 `PRIVATE` 列表。
