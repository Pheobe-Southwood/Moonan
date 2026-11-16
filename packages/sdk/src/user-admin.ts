import type { MoonanRole, MoonanUser } from "./principal.js";

/**
 * The platform's account-management HTTP surface (`/api/v1/users`).
 *
 * Like the plugin-management API, this is not a Chord contract: account changes are
 * platform control-plane work that can invalidate links and purge data, so it runs outside
 * any host root. Every endpoint requires an administrator principal on the server; the
 * browser panel is only a client of this JSON shape.
 */
export const USER_ADMIN_API = 1 as const;

/** One account as the administrator sees it. Password hashes never cross this boundary. */
export interface UserAdminUser extends MoonanUser {
	readonly createdAt: string;
	readonly updatedAt: string;
}

export interface UserAdminSnapshot {
	api: typeof USER_ADMIN_API;
	readonly users: UserAdminUser[];
	/** The administrator making the request; the UI marks that row. */
	readonly currentUserId: string;
}

/** A successful account mutation. `user` is absent on removal. */
export interface UserAdminMutation {
	ok: true;
	user?: UserAdminUser;
	/** Set when the account was removed but its datasets could not be purged. */
	warning?: string;
}

export interface UserAdminError {
	error: string;
	/** `unauthorized`, `admin_required`, `username_taken`, `last_admin`, `unknown_user`, ... */
	code?: string;
}

export const USER_ADMIN_PATHS = [
	"/api/v1/users",
	"/api/v1/users/create",
	"/api/v1/users/password",
	"/api/v1/users/role",
	"/api/v1/users/remove",
] as const;

/** Roles a request may ask for; the server validates again. */
export const MOONAN_ROLES: readonly MoonanRole[] = ["admin", "user"];
