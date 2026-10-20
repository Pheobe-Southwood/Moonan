/**
 * 构建 WebUI 并把产物放进本包的 dist/web。
 *
 * 单独一步（而不是让 tsc 管）：UI 是 Vite 打包的浏览器产物，node 侧只管托管它。
 */
import { chmodSync, cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, '..');
const repoRoot = resolve(appRoot, '../..');
const uiRoot = resolve(repoRoot, 'packages/ui');
const target = resolve(appRoot, 'dist/web');

// tsc 的产物没有可执行位，但 package.json 的 `bin` 指向 dist/cli.js：
// 无论是直接执行还是被 npm 全局链接，都要先 +x。放在跳过 UI 的分支之前，两条路径都覆盖。
const cli = resolve(appRoot, 'dist/cli.js');
if (existsSync(cli)) {
  chmodSync(cli, 0o755);
  console.log(`已设置可执行位：${cli}`);
}

if (process.env['MOONAN_SKIP_UI'] === '1') {
  console.log('跳过 WebUI 构建（MOONAN_SKIP_UI=1）');
  process.exit(0);
}

const result = spawnSync('npx', ['vite', 'build'], { cwd: uiRoot, stdio: 'inherit', shell: false });
if (result.status !== 0) {
  console.error('WebUI 构建失败');
  process.exit(result.status ?? 1);
}

const source = resolve(uiRoot, 'dist/web');
if (!existsSync(source)) {
  console.error(`找不到 WebUI 产物：${source}`);
  process.exit(1);
}
rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
cpSync(source, target, { recursive: true });
console.log(`WebUI 产物已放到 ${target}`);
