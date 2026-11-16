import { forbidden } from "@earendil-works/chord";

/**
 * Who is calling, as Chord means it: an app-defined, JSON-serializable identity that a
 * link stamps at its accepting side. Moonan never lets a client name its own principal.
 *
 * There are exactly three kinds:
 * - `host`: the platform's own code, and the principal of every local type's object;
 * - `browser`: the browser host's own code (the server never sees this one);
 * - `user`: a signed-in account, stamped by the platform's WebSocket authenticator.
 */
export type MoonanRole = "admin" | "user";

/** The public, secret-free identity of an account. */
export interface MoonanUser {
	/** Stable account id (UUID). Data ownership is keyed by this, not by the username. */
	readonly id: string;
	readonly username: string;
	readonly role: MoonanRole;
}

export interface HostPrincipal {
	readonly kind: "host";
}

export interface BrowserPrincipal {
	readonly kind: "browser";
}

/**
 * A signed-in user.
 *
 * `session` is the server-side session id, not the cookie token. It is part of the object
 * key so a new login gets new server objects while two tabs of one login share them. The
 * password, token hash and any credential never appear in a principal.
 */
export interface UserPrincipal extends MoonanUser {
	readonly kind: "user";
	readonly session: string;
}

export type MoonanPrincipal = HostPrincipal | BrowserPrincipal | UserPrincipal;

export const HOST_PRINCIPAL: HostPrincipal = { kind: "host" };
export const BROWSER_PRINCIPAL: BrowserPrincipal = { kind: "browser" };

export function isUserPrincipal(principal: unknown): principal is UserPrincipal {
	if (typeof principal !== "object" || principal === null) return false;
	const value = principal as Partial<UserPrincipal>;
	return (
		value.kind === "user" &&
		typeof value.id === "string" &&
		typeof value.username === "string" &&
		(value.role === "admin" || value.role === "user") &&
		typeof value.session === "string"
	);
}

export function isAdminPrincipal(principal: unknown): principal is UserPrincipal {
	return isUserPrincipal(principal) && principal.role === "admin";
}

/** A factory or method that only makes sense for a signed-in account. */
export function requireUser(principal: unknown): UserPrincipal {
	if (!isUserPrincipal(principal)) throw forbidden("this operation requires a signed-in user");
	return principal;
}

/** Server-side administrator check. Never trust a client-supplied role. */
export function requireAdmin(principal: unknown): UserPrincipal {
	const user = requireUser(principal);
	if (user.role !== "admin") throw forbidden("this operation requires the administrator role");
	return user;
}

/**
 * Chord's object key.
 *
 * Objects are per principal key. The session is included so a re-login starts a fresh set
 * of objects; signing out invalidates the old set. Username and role are not in the key
 * because changing either invalidates the sessions explicitly.
 */
export function principalKey(principal: MoonanPrincipal): string {
	switch (principal.kind) {
		case "host":
			return "host";
		case "browser":
			return "browser";
		case "user":
			return `user:${principal.id}:session:${principal.session}`;
	}
}

/** The data-store owner for an account id. Stable across logins; never the username. */
export function userDataOwner(id: string): string {
	return `user:${id}`;
}

/** The data-store owner a signed-in user's plugin data belongs to. */
export function dataOwner(principal: MoonanPrincipal): string {
	const user = requireUser(principal);
	return userDataOwner(user.id);
}

/**
 * The owner of platform-wide data (not owned by an account).
 *
 * Built-in plugins should scope data to `dataOwner(principal)`. `host` exists for
 * platform bookkeeping and tests; it is not a shared user bucket.
 */
export const HOST_DATA_OWNER = "host";
