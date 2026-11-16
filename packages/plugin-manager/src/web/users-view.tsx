import { useState } from "react";
import type { MoonanRole, UserAdminSnapshot, UserAdminUser } from "@moonan_ai/sdk";

/** The account list has no read-only fallback: it is loading, ready, or showing an error. */
export type UsersViewStatus = "loading" | "ready" | "error";

export interface CreateUserInput {
	username: string;
	password: string;
	role: MoonanRole;
}

export interface UsersPanelViewProps {
	status: UsersViewStatus;
	snapshot?: UserAdminSnapshot;
	/** The last failure, already translated for humans. */
	error?: string;
	notice?: string;
	/** A deletion succeeded, but the account's plugin datasets could not be purged. */
	warning?: string;
	/** The action currently in flight; every control is disabled while one is. */
	busy?: string;
	onCreate: (input: CreateUserInput) => void;
	onResetPassword: (user: UserAdminUser) => void;
	onSetRole: (user: UserAdminUser, role: MoonanRole) => void;
	onRemove: (user: UserAdminUser) => void;
	onRefresh: () => void;
}

export function roleLabel(role: MoonanRole): string {
	return role === "admin" ? "管理员" : "用户";
}

/**
 * The server sends ISO timestamps. Show a stable `YYYY-MM-DD HH:mm` (UTC) instead of a
 * locale-formatted string, so the panel renders identically in every browser.
 */
export function formatTimestamp(value: string): string {
	const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(value);
	return match ? `${match[1]} ${match[2]}` : value;
}

function RoleBadge({ role }: { role: MoonanRole }) {
	return <span className={`pm-badge pm-badge-${role}`}>{roleLabel(role)}</span>;
}

function UserRow({
	user,
	self,
	busy,
	onResetPassword,
	onSetRole,
	onRemove,
}: {
	user: UserAdminUser;
	self: boolean;
	busy: boolean;
	onResetPassword: (user: UserAdminUser) => void;
	onSetRole: (user: UserAdminUser, role: MoonanRole) => void;
	onRemove: (user: UserAdminUser) => void;
}) {
	const nextRole: MoonanRole = user.role === "admin" ? "user" : "admin";
	return (
		<li className="pm-row pm-user-row" data-self={self} data-role={user.role}>
			<div className="pm-row-main">
				<div className="pm-row-title">
					<strong>{user.username}</strong>
					<RoleBadge role={user.role} />
					{self ? <span className="pm-badge pm-badge-me">我</span> : null}
				</div>
				<div className="pm-row-meta">
					<span title={user.createdAt}>创建于 {formatTimestamp(user.createdAt)}</span>
					<span title={user.updatedAt}>更新于 {formatTimestamp(user.updatedAt)}</span>
				</div>
			</div>
			<div className="pm-row-actions">
				<button type="button" className="pm-btn" disabled={busy} onClick={() => onResetPassword(user)}>
					重置密码
				</button>
				<button type="button" className="pm-btn" disabled={busy} onClick={() => onSetRole(user, nextRole)}>
					{nextRole === "admin" ? "设为管理员" : "设为用户"}
				</button>
				<button
					type="button"
					className="pm-btn pm-btn-danger"
					disabled={busy}
					title="同时清除该账户的插件数据，无法恢复"
					onClick={() => onRemove(user)}
				>
					删除
				</button>
			</div>
		</li>
	);
}

/**
 * The pure account-management view. It performs no request and knows no password: the
 * panel supplies the client, `window.prompt`/`window.confirm` and the reload policy.
 */
export function UsersPanelView(props: UsersPanelViewProps) {
	const [username, setUsername] = useState("");
	const [password, setPassword] = useState("");
	const [role, setRole] = useState<MoonanRole>("user");
	const snapshot = props.snapshot;
	const busy = props.busy !== undefined;
	const canCreate = username.trim().length > 0 && password.length > 0 && !busy;

	return (
		<div className="pm-root">
			<header className="pm-header">
				<div>
					<h2>用户管理</h2>
					<p className="pm-sub">
						{snapshot ? `${snapshot.users.length} 个账户 · 仅管理员可见` : "创建账户、重置密码、调整角色或删除账户"}
					</p>
				</div>
				<div className="pm-header-actions">
					<button type="button" className="pm-btn" onClick={props.onRefresh} disabled={busy}>
						刷新
					</button>
				</div>
			</header>

			{props.status === "loading" ? <div className="pm-note">读取账户列表…</div> : null}
			{props.notice ? <div className="pm-note pm-note-ok">{props.notice}</div> : null}
			{props.warning ? <div className="pm-note pm-note-warn">{props.warning}</div> : null}
			{props.error ? <div className="pm-note pm-note-error">{props.error}</div> : null}

			{snapshot ? (
				<>
					<form
						className="pm-user-create"
						onSubmit={(event) => {
							event.preventDefault();
							if (!canCreate) return;
							props.onCreate({ username: username.trim(), password, role });
							setUsername("");
							setPassword("");
							setRole("user");
						}}
					>
						<input
							type="text"
							value={username}
							placeholder="用户名"
							aria-label="用户名"
							autoComplete="off"
							onChange={(event) => setUsername(event.target.value)}
						/>
						<input
							type="password"
							value={password}
							placeholder="密码（8–200 个字符）"
							aria-label="密码"
							autoComplete="new-password"
							onChange={(event) => setPassword(event.target.value)}
						/>
						<select
							className="pm-select"
							value={role}
							aria-label="角色"
							onChange={(event) => setRole(event.target.value === "admin" ? "admin" : "user")}
						>
							<option value="user">用户</option>
							<option value="admin">管理员</option>
						</select>
						<button type="submit" className="pm-btn pm-btn-primary" disabled={!canCreate}>
							创建账户
						</button>
					</form>
					<p className="pm-hint">
						用户名需为 1–64 个字符（字母、数字、点、下划线和短横线，以字母或数字开头）；密码 8–200 个字符。
						密码只会提交给平台，保存后无法再次查看。
					</p>

					<ul className="pm-list">
						{snapshot.users.length === 0 ? (
							<li className="pm-empty">还没有账户。</li>
						) : (
							snapshot.users.map((user) => (
								<UserRow
									key={user.id}
									user={user}
									self={user.id === snapshot.currentUserId}
									busy={busy}
									onResetPassword={props.onResetPassword}
									onSetRole={props.onSetRole}
									onRemove={props.onRemove}
								/>
							))
						)}
					</ul>
				</>
			) : null}

			<p className="pm-hint">
				重置密码或调整角色会让该账户的现有会话立即失效；最后一个管理员不能被降级或删除。删除账户会同时清除其插件数据，且无法恢复。
			</p>
		</div>
	);
}
