/**
 * Sensitive request values: what may leave the server, and how a write from the browser
 * finds its way back to the stored value.
 *
 * The gateway stores provider/model configuration in the platform's data file and shows it
 * in a browser panel. `apiKey` never leaves the server (only `hasKey` and a hint do); the
 * same has to hold for credential-like headers and environment variables (an
 * `Authorization` header, `AWS_SECRET_ACCESS_KEY`, …), and for the default export, which is
 * meant to be portable. The contract schemas are unchanged: only values are replaced.
 */

type SecretMap = Record<string, string | null>;

/**
 * The sentinel a browser view or a redacted export carries in place of a sensitive value.
 * A write that echoes it back means "unchanged"; the server restores the stored value.
 *
 * Because the restore is value-based, a stored value that literally equals the sentinel
 * cannot be told apart from a mask and is treated as unchanged. The string is deliberately
 * unusual; the alternative would be a separate changed/unchanged channel in the contract.
 */
export const REDACTED = "moonan:redacted";

/**
 * Names whose values are treated as credentials. Deliberately broad: a false positive only
 * hides a value from the browser, while a false negative leaks one. `key` and `auth`
 * substrings cover AWS_ACCESS_KEY_ID, x-functions-key, Ocp-Apim-Subscription-Key,
 * *_PRIVATE_KEY, x-auth and friends without enumerating every vendor.
 */
const SENSITIVE_NAME =
	/(authorization|authentication|auth|key|token|secret|password|credential|cookie|signature)/i;

export function isSensitiveName(name: string): boolean {
	return SENSITIVE_NAME.test(name);
}

/**
 * Copy `map` with sensitive string values replaced by {@link REDACTED}. `null` (the
 * "delete this header" marker) and non-sensitive entries stay as they are.
 */
export function maskSensitiveMap<T extends SecretMap>(map: T | undefined): T | undefined {
	if (map === undefined) return undefined;
	const masked: SecretMap = {};
	for (const [name, value] of Object.entries(map)) {
		masked[name] = value !== null && isSensitiveName(name) ? REDACTED : value;
	}
	return masked as T;
}

/**
 * The inverse for a write that came back from the browser or from a redacted export: a
 * `REDACTED` value means "unchanged", so take the current value. When there is no current
 * value, drop the key instead of storing the sentinel.
 *
 * A value the caller typed (anything but the sentinel) wins, so replacing a sensitive
 * header works the same way it does for a new `apiKey`.
 */
export function restoreSensitiveMap<T extends SecretMap>(
	incoming: T | undefined,
	current: T | undefined,
): T | undefined {
	if (incoming === undefined) return undefined;
	const restored: SecretMap = {};
	for (const [name, value] of Object.entries(incoming)) {
		if (value !== REDACTED) {
			restored[name] = value;
			continue;
		}
		const kept = current?.[name];
		if (kept !== undefined && kept !== null && kept !== REDACTED) restored[name] = kept;
	}
	return restored as T;
}
