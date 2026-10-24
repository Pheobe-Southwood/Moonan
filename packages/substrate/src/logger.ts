export type LogLevel = "info" | "warn" | "error";

export interface Logger {
	info(message: string, ...args: unknown[]): void;
	warn(message: string, ...args: unknown[]): void;
	error(message: string, ...args: unknown[]): void;
	child(scope: string): Logger;
}

function emit(level: LogLevel, scope: string | undefined, message: string, args: unknown[]): void {
	const prefix = scope ? `[moonan:${scope}]` : "[moonan]";
	const line = `${prefix} ${message}`;
	if (level === "error") console.error(line, ...args);
	else if (level === "warn") console.warn(line, ...args);
	else console.log(line, ...args);
}

export function createLogger(scope?: string): Logger {
	return {
		info: (message, ...args) => emit("info", scope, message, args),
		warn: (message, ...args) => emit("warn", scope, message, args),
		error: (message, ...args) => emit("error", scope, message, args),
		child: (next) => createLogger(scope ? `${scope}:${next}` : next),
	};
}

export const silentLogger: Logger = {
	info: () => {},
	warn: () => {},
	error: () => {},
	child: () => silentLogger,
};
