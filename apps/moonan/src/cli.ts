#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
/** Moonan CLI。 */
// shebang 里的 `--disable-warning=ExperimentalWarning` 只是为了盖掉 `node:sqlite` 的实验性警告，
// 让全局安装后的 `moonan` 输出干净；`node dist/cli.js` 直跑时它不生效（仅是噪音，不影响行为）。
import { createApp, resolveHome } from './app.js';

interface CliOptions {
  readonly command: 'start' | 'help' | 'version';
  readonly port?: number;
  readonly host?: string;
  readonly home?: string;
  readonly logLevel?: 'debug' | 'info' | 'warn' | 'error';
}

const HELP = `Moonan — 实验性项目，让AI的角色扮演更沉浸，支持灵活的插件系统

用法：
  moonan [start] [选项]      启动 WebUI（默认 http://127.0.0.1:21315）
  moonan help                显示本帮助
  moonan version             显示版本

选项：
  --port <n>       监听端口（默认 21315，也可用 MOONAN_PORT）
  --host <addr>    监听地址（默认 127.0.0.1）
  --home <dir>     数据目录（默认 ~/.moonan，也可用 MOONAN_HOME）
  --log <level>    日志级别 debug|info|warn|error（默认 info）

数据都明文存放在数据目录里（moonan.db），请勿在共享机器上使用。
`;

function parseArgs(argv: readonly string[]): CliOptions {
  const args = [...argv];
  const first = args[0];
  let command: CliOptions['command'] = 'start';
  if (first === 'help' || first === '--help' || first === '-h') {
    command = 'help';
    args.shift();
  } else if (first === 'version' || first === '--version' || first === '-v') {
    command = 'version';
    args.shift();
  } else if (first === 'start') {
    args.shift();
  }

  const result: { command: CliOptions['command']; port?: number; host?: string; home?: string; logLevel?: CliOptions['logLevel'] } = { command };
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    const value = args[index + 1];
    switch (flag) {
      case '--port':
        if (!value) throw new Error('--port 需要一个数字');
        result.port = Number(value);
        index += 1;
        break;
      case '--host':
        if (!value) throw new Error('--host 需要一个地址');
        result.host = value;
        index += 1;
        break;
      case '--home':
        if (!value) throw new Error('--home 需要一个目录');
        result.home = value;
        index += 1;
        break;
      case '--log':
        if (!value) throw new Error('--log 需要一个级别');
        result.logLevel = value as CliOptions['logLevel'];
        index += 1;
        break;
      default:
        throw new Error(`未知的参数：${String(flag)}`);
    }
  }
  return result;
}

async function main(): Promise<void> {
  let options: CliOptions;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${HELP}`);
    process.exitCode = 2;
    return;
  }

  if (options.command === 'help') {
    process.stdout.write(HELP);
    return;
  }
  if (options.command === 'version') {
    process.stdout.write(`${process.env['MOONAN_VERSION'] ?? '0.0.1-rc.1'}\n`);
    return;
  }

  const app = await createApp({
    ...(options.port === undefined ? {} : { port: options.port }),
    ...(options.host === undefined ? {} : { host: options.host }),
    ...(options.home === undefined ? {} : { home: options.home }),
    ...(options.logLevel === undefined ? {} : { logLevel: options.logLevel }),
  });

  app.log.info(`数据目录：${resolveHome(options.home)}`);
  app.log.info(`插件：${app.plugins.map((entry) => entry.id).join(', ')}`);
  app.log.info(`打开 ${app.url} 开始使用（Ctrl+C 退出）`);

  let closing = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (closing) return;
    closing = true;
    app.log.info(`收到 ${signal}，正在退出…`);
    try {
      await app.close();
    } catch (error) {
      app.log.error('退出时出错', error);
      process.exitCode = 1;
    }
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

await main();
