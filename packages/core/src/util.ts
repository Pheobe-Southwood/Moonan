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

const VARIABLE_PATTERN = /\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g;

export interface RenderResult {
	text: string;
	missing: string[];
}

/** Replaces `{{name}}` with values. Unknown names are left intact and reported. */
export function renderTemplate(template: string, variables: Record<string, string>): RenderResult {
	const missing = new Set<string>();
	const text = template.replace(VARIABLE_PATTERN, (match, name: string) => {
		const value = variables[name];
		if (value === undefined) {
			missing.add(name);
			return match;
		}
		return value;
	});
	return { text, missing: [...missing] };
}

export function templateVariables(template: string): string[] {
	const names = new Set<string>();
	for (const match of template.matchAll(VARIABLE_PATTERN)) {
		if (match[1]) names.add(match[1]);
	}
	return [...names];
}
