import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MoonanRole, UserAdminSnapshot, UserAdminUser } from "@moonan_ai/sdk";
import type { PanelProps } from "@moonan_ai/sdk/web";
import {
	createUserAdminClient,
	UserAdminRequestError,
	type UserAdminClient,
} from "./users-api.js";
import { roleLabel, UsersPanelView, type CreateUserInput, type UsersViewStatus } from "./users-view.js";

function messageOf(error: unknown): string {
	if (error instanceof UserAdminRequestError) return error.message;
	return error instanceof Error ? error.message : String(error);
}

/** What one successful mutation wants the view to announce, plus the notices the platform returns. */
interface MutationOutcome {
	notice: string;
	warning?: string;
}

export interface UsersPanelProps extends PanelProps {
	/** Tests inject a client; the shell passes none and the panel talks to `fetch`. */
	client?: UserAdminClient;
}

/**
 * The 用户 tab. It reads `/api/v1/users` and asks the platform for each change; the rows are
 * fetched again after every mutation because the server may have changed more than the one
 * account (role changes revoke sessions, deletions purge datasets).
 */
export function UsersPanel(props: UsersPanelProps) {
	const client = useMemo(() => props.client ?? createUserAdminClient(), [props.client]);
	const [status, setStatus] = useState<UsersViewStatus>("loading");
	const [snapshot, setSnapshot] = useState<UserAdminSnapshot | undefined>();
	const [error, setError] = useState<string | undefined>();
	const [notice, setNotice] = useState<string | undefined>();
	const [warning, setWarning] = useState<string | undefined>();
	const [busy, setBusy] = useState<string | undefined>();
	const mounted = useRef(true);

	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);

	const load = useCallback(async () => {
		try {
			const next = await client.snapshot();
			if (!mounted.current) return;
			setSnapshot(next);
			setStatus("ready");
			setError(undefined);
		} catch (failure) {
			if (!mounted.current) return;
			setStatus("error");
			setError(messageOf(failure));
		}
	}, [client]);

	useEffect(() => {
		void load();
	}, [load]);

	const run = useCallback(
		async (key: string, action: () => Promise<MutationOutcome>) => {
			setBusy(key);
			setError(undefined);
			setNotice(undefined);
			setWarning(undefined);
			try {
				const result = await action();
				if (!mounted.current) return;
				setNotice(result.notice);
				if (result.warning !== undefined) setWarning(result.warning);
				// Re-read even after a failure-free mutation: the platform may have revoked sessions
				// or changed a role the row had not shown yet.
				await load();
			} catch (failure) {
				if (mounted.current) setError(messageOf(failure));
			} finally {
				if (mounted.current) setBusy(undefined);
			}
		},
		[load],
	);

	const currentUserId = snapshot?.currentUserId;

	const create = (input: CreateUserInput): void => {
		void run("create", async () => {
			const mutation = await client.create(input);
			const name = mutation.user?.username ?? input.username;
			return { notice: `已创建账户 ${name}（${roleLabel(mutation.user?.role ?? input.role)}）。` };
		});
	};

	const resetPassword = (user: UserAdminUser): void => {
		const password = window.prompt(`为 ${user.username} 设置新密码（8–200 个字符）`);
		if (password === null) return;
		if (password.length < 8 || password.length > 200) {
			setNotice(undefined);
			setError("密码长度需为 8–200 个字符。");
			return;
		}
		if (user.id === currentUserId && !window.confirm("重置你自己的密码会立即退出登录。确定继续？")) {
			return;
		}
		void run(`password:${user.id}`, async () => {
			await client.setPassword(user.id, password);
			return { notice: `已重置 ${user.username} 的密码，该账户需要重新登录。` };
		});
	};

	const setRole = (user: UserAdminUser, role: MoonanRole): void => {
		if (user.id === currentUserId && !window.confirm("修改你自己的角色会立即退出登录。确定继续？")) {
			return;
		}
		void run(`role:${user.id}`, async () => {
			await client.setRole(user.id, role);
			return { notice: `已将 ${user.username} 设为${roleLabel(role)}，该账户需要重新登录。` };
		});
	};

	const remove = (user: UserAdminUser): void => {
		const self = user.id === currentUserId;
		const question = self
			? `删除当前登录的账户 ${user.username}？\n\n账户及其插件数据会被永久删除，你会立即退出，且无法恢复。`
			: `删除账户 ${user.username}？\n\n账户及其插件数据会被永久删除，且无法恢复。`;
		if (!window.confirm(question)) return;
		void run(`remove:${user.id}`, async () => {
			const mutation = await client.remove(user.id);
			return {
				notice: `已删除账户 ${user.username}。`,
				...(mutation.warning === undefined ? {} : { warning: mutation.warning }),
			};
		});
	};

	return (
		<UsersPanelView
			status={status}
			{...(snapshot ? { snapshot } : {})}
			{...(error === undefined ? {} : { error })}
			{...(notice === undefined ? {} : { notice })}
			{...(warning === undefined ? {} : { warning })}
			{...(busy === undefined ? {} : { busy })}
			onCreate={create}
			onResetPassword={resetPassword}
			onSetRole={setRole}
			onRemove={remove}
			onRefresh={() => void load()}
		/>
	);
}
