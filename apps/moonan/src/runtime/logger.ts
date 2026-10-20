import type { Logger } from '@moonan/plugin-sdk';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LoggerOptions {
  readonly namespace: string;
  readonly level?: LogLevel;
  readonly sink?: (line: string) => void;
}

/** 极简结构化日志：`[namespace] message {detail}`。 */
export function createLogger(options: LoggerOptions): Logger {
  const threshold = LEVELS[options.level ?? 'info'];
  const sink = options.sink ?? ((line: string) => process.stdout.write(`${line}\n`));

  const write = (level: LogLevel, message: string, detail?: unknown): void => {
    if (LEVELS[level] < threshold) return;
    const stamp = new Date().toISOString();
    let line = `${stamp} ${level.toUpperCase().padEnd(5)} [${options.namespace}] ${message}`;
    if (detail !== undefined) {
      line += ` ${safeStringify(detail)}`;
    }
    sink(line);
  };

  return {
    debug: (message, detail) => write('debug', message, detail),
    info: (message, detail) => write('info', message, detail),
    warn: (message, detail) => write('warn', message, detail),
    error: (message, detail) => write('error', message, detail),
  };
}

function safeStringify(value: unknown): string {
  if (value instanceof Error) {
    return `${value.name}: ${value.message}`;
  }
  try {
    const json = JSON.stringify(value);
    return json === undefined ? String(value) : json;
  } catch {
    return String(value);
  }
}
