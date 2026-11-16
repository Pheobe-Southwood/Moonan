import { isChordError, type Host } from "@earendil-works/chord";
import { WebFacetCatalog, type FacetSetEntry, type MoonanRole } from "@moonan_ai/sdk";
import { useReadable, useRefStatus, useRemote, type PanelContribution } from "@moonan_ai/sdk/web";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import {
	AuthRequestError,
	authErrorMessage,
	changePassword,
	fetchAuthStatus,
	login,
	logout,
	setup,
	type AuthStatus,
	type AuthUser,
} from "./auth.js";
import { ConnectionProvider, useConnection } from "./chord/connection.js";
import { useFacetBatches } from "./chord/facets.js";
import { usePanels } from "./chord/panels.js";
import { reloadOnce } from "./chord/reload.js";

/**
 * The shell knows no panel and holds no application state.
 *
 * Every tab is registered by a plugin's browser facet into this host's `Panels`
 * registry, and the list of facets to load comes from the platform's `WebFacetCatalog`. Adding
 * a feature means shipping a plugin, never editing this file.
 *
 * What the shell does own is the account gate: the platform authenticates a session before it
 * accepts a Chord link, so nothing about a signed-in account (no host, no facets, no panel)
 * may mount before `/api/auth/status` reports one.
 */

/** The account gate's view of the page. `anonymous` covers both login and first-run setup. */
type AuthState =
	| { readonly status: "loading" }
	| { readonly status: "error"; readonly error: string }
	| {
			readonly status: "anonymous";
			readonly setupRequired: boolean;
			readonly version: string;
			readonly notice?: string;
	  }
	| { readonly status: "authenticated"; readonly user: AuthUser; readonly version: string };

/** Fold a fresh status response into the gate's state, keeping a one-shot notice across re-checks. */
function applyStatus(current: AuthState, status: AuthStatus): AuthState {
	if (status.authenticated && status.user) {
		return { status: "authenticated", user: status.user, version: status.version };
	}
	const notice = current.status === "anonymous" ? current.notice : undefined;
	return {
		status: "anonymous",
		setupRequired: status.setupRequired,
		version: status.version,
		...(notice === undefined ? {} : { notice }),
	};
}

/**
 * The panels a role may see.
 *
 * Presentation only: a hidden panel's routes are still enforced by the server (see
 * `PanelContribution.adminOnly`), so this is not an authorization boundary.
 */
export function visiblePanels(panels: readonly PanelContribution[], role: MoonanRole): PanelContribution[] {
	return panels.filter((panel) => panel.adminOnly !== true || role === "admin");
}

function currentRoute(panels: readonly PanelContribution[]): string {
	const hash = location.hash.replace(/^#\/?/, "");
	return panels.some((panel) => panel.id === hash) ? hash : (panels[0]?.id ?? "");
}

function Recovery({ title, detail }: { title: string; detail?: string }) {
	return (
		<section className="empty">
			<h2>{title}</h2>
			{detail ? <p>{detail}</p> : null}
			<p>
				<button type="button" onClick={() => location.reload()}>
					刷新页面 · Reload
				</button>
			</p>
		</section>
	);
}

/** The full-page frame the anonymous account pages share. */
function AuthPage({ version, title, children }: { version: string; title: string; children: ReactNode }) {
	return (
		<div className="auth-screen">
			<div className="auth-card">
				<div className="auth-brand">Moonan</div>
				<h1>{title}</h1>
				{children}
				<footer className="auth-version">{version.length > 0 ? `v${version}` : ""}</footer>
			</div>
		</div>
	);
}

/** The account gate could not reach the platform; the shell cannot know who is asking. */
function AuthFailure({ detail, onRetry }: { detail: string; onRetry: () => void }) {
	return (
		<div className="auth-screen">
			<div className="auth-card">
				<div className="auth-brand">Moonan</div>
				<h2>无法连接 Moonan</h2>
				<p className="auth-text">{detail}</p>
				<button type="button" className="button-primary" onClick={onRetry}>
					重试 · Retry
				</button>
			</div>
		</div>
	);
}

interface AccountPageProps {
	readonly version: string;
	readonly onAuthenticated: (user: AuthUser) => void;
}

/**
 * First-run page: there is no account yet, so the browser creates the first administrator.
 * The button is the only account-creating form the shell offers; later accounts are created
 * from the administrator panel.
 */
function SetupPage({
	version,
	onAuthenticated,
	onStale,
}: AccountPageProps & { readonly onStale: () => void }) {
	const [username, setUsername] = useState("");
	const [password, setPassword] = useState("");
	const [confirm, setConfirm] = useState("");
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const submit = async (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		if (pending) return;
		if (password.length < 8 || password.length > 200) {
			setError("密码长度需为 8–200 个字符");
			return;
		}
		if (password !== confirm) {
			setError("两次输入的密码不一致");
			return;
		}
		setPending(true);
		setError(null);
		try {
			onAuthenticated(await setup(username.trim(), password));
		} catch (failure) {
			// Another tab may have created the administrator while this page was open; the
			// status endpoint is the authority on what this page should show.
			if (failure instanceof AuthRequestError && failure.code === "setup_complete") {
				onStale();
				return;
			}
			setError(authErrorMessage(failure));
			setPending(false);
		}
	};

	return (
		<AuthPage version={version} title="创建第一个管理员">
			<p className="auth-text">首次启动需要创建一个管理员账户。之后由管理员创建其他账户。</p>
			<form className="auth-form" onSubmit={(event) => void submit(event)}>
				<label className="field">
					<span>管理员账户</span>
					<input
						name="username"
						autoComplete="username"
						value={username}
						onChange={(event) => setUsername(event.target.value)}
						required
						autoFocus
					/>
				</label>
				<label className="field">
					<span>密码</span>
					<input
						name="password"
						type="password"
						autoComplete="new-password"
						value={password}
						onChange={(event) => setPassword(event.target.value)}
						required
						minLength={8}
						maxLength={200}
					/>
				</label>
				<label className="field">
					<span>确认密码</span>
					<input
						name="confirm"
						type="password"
						autoComplete="new-password"
						value={confirm}
						onChange={(event) => setConfirm(event.target.value)}
						required
						minLength={8}
						maxLength={200}
					/>
				</label>
				{error ? (
					<p className="auth-error" role="alert">
						{error}
					</p>
				) : null}
				<button type="submit" className="button-primary" disabled={pending}>
					{pending ? "创建中…" : "创建管理员"}
				</button>
			</form>
		</AuthPage>
	);
}

/** The ordinary login page: an account the administrator created. */
function LoginPage({
	version,
	notice,
	onAuthenticated,
}: AccountPageProps & { readonly notice?: string | undefined }) {
	const [username, setUsername] = useState("");
	const [password, setPassword] = useState("");
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const submit = async (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		if (pending) return;
		setPending(true);
		setError(null);
		try {
			onAuthenticated(await login(username.trim(), password));
		} catch (failure) {
			setError(authErrorMessage(failure));
			setPending(false);
		}
	};

	return (
		<AuthPage version={version} title="登录 Moonan">
			<p className="auth-text">使用管理员创建的账户登录。</p>
			{notice ? (
				<p className="auth-notice" role="status">
					{notice}
				</p>
			) : null}
			<form className="auth-form" onSubmit={(event) => void submit(event)}>
				<label className="field">
					<span>账户</span>
					<input
						name="username"
						autoComplete="username"
						value={username}
						onChange={(event) => setUsername(event.target.value)}
						required
						autoFocus
					/>
				</label>
				<label className="field">
					<span>密码</span>
					<input
						name="password"
						type="password"
						autoComplete="current-password"
						value={password}
						onChange={(event) => setPassword(event.target.value)}
						required
					/>
				</label>
				{error ? (
					<p className="auth-error" role="alert">
						{error}
					</p>
				) : null}
				<button type="submit" className="button-primary" disabled={pending}>
					{pending ? "登录中…" : "登录"}
				</button>
			</form>
		</AuthPage>
	);
}

/**
 * Self-service password change. The platform revokes every session of the account after a
 * successful change and clears the cookie, so this never "keeps working": the shell returns
 * to the login page once the call succeeds.
 */
function PasswordDialog({ onClose, onChanged }: { onClose: () => void; onChanged: () => void }) {
	const [currentPassword, setCurrentPassword] = useState("");
	const [newPassword, setNewPassword] = useState("");
	const [confirm, setConfirm] = useState("");
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const submit = async (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		if (pending) return;
		if (newPassword.length < 8 || newPassword.length > 200) {
			setError("新密码长度需为 8–200 个字符");
			return;
		}
		if (newPassword !== confirm) {
			setError("两次输入的新密码不一致");
			return;
		}
		setPending(true);
		setError(null);
		try {
			await changePassword(currentPassword, newPassword);
			onChanged();
		} catch (failure) {
			setError(authErrorMessage(failure));
			setPending(false);
		}
	};

	return (
		<div className="modal-backdrop" role="presentation" onClick={onClose}>
			<form
				className="modal"
				role="dialog"
				aria-modal="true"
				aria-labelledby="password-title"
				onClick={(event) => event.stopPropagation()}
				onSubmit={(event) => void submit(event)}
			>
				<h2 id="password-title">修改密码</h2>
				<p className="modal-hint">修改成功后所有登录会话都会失效，需要重新登录。</p>
				<label className="field">
					<span>当前密码</span>
					<input
						type="password"
						autoComplete="current-password"
						value={currentPassword}
						onChange={(event) => setCurrentPassword(event.target.value)}
						required
						autoFocus
					/>
				</label>
				<label className="field">
					<span>新密码</span>
					<input
						type="password"
						autoComplete="new-password"
						value={newPassword}
						onChange={(event) => setNewPassword(event.target.value)}
						required
						minLength={8}
						maxLength={200}
					/>
				</label>
				<label className="field">
					<span>确认新密码</span>
					<input
						type="password"
						autoComplete="new-password"
						value={confirm}
						onChange={(event) => setConfirm(event.target.value)}
						required
						minLength={8}
						maxLength={200}
					/>
				</label>
				{error ? (
					<p className="auth-error" role="alert">
						{error}
					</p>
				) : null}
				<div className="modal-actions">
					<button type="button" className="button-quiet" onClick={onClose} disabled={pending}>
						取消
					</button>
					<button type="submit" className="button-primary" disabled={pending}>
						{pending ? "提交中…" : "确认修改"}
					</button>
				</div>
			</form>
		</div>
	);
}

interface SessionProps {
	readonly user: AuthUser;
	readonly onSignOut: () => void;
	readonly onPasswordChanged: () => void;
}

function Shell({
	host,
	version,
	panels: contributed,
	user,
	onSignOut,
	onPasswordChanged,
}: SessionProps & { host: Host<unknown>; version: string; panels: PanelContribution[] }) {
	const { status } = useConnection();
	// Filter before routing: the current route must always name a panel this role may see.
	const panels = useMemo(() => visiblePanels(contributed, user.role), [contributed, user.role]);
	const [route, setRoute] = useState(() => currentRoute(panels));
	const [passwordOpen, setPasswordOpen] = useState(false);
	const active = panels.find((panel) => panel.id === route) ?? panels[0];
	const activeId = active?.id ?? "";

	useEffect(() => {
		const onHash = () => setRoute(currentRoute(panels));
		window.addEventListener("hashchange", onHash);
		return () => window.removeEventListener("hashchange", onHash);
	}, [panels]);

	useEffect(() => {
		if (!active && panels.length > 0) setRoute(panels[0]?.id ?? "");
	}, [active, panels]);

	const Active = active?.component;

	return (
		<div className="shell">
			<header className="topbar">
				<div className="brand">
					Moonan
					<small>{version}</small>
				</div>
				<nav className="tabs" aria-label="Primary">
					{panels.map((panel) => (
						<button
							key={panel.id}
							type="button"
							className="tab"
							data-active={panel.id === activeId}
							onClick={() => {
								location.hash = `#/${panel.id}`;
								setRoute(panel.id);
							}}
						>
							{panel.title}
						</button>
					))}
				</nav>
				<div className="topmeta">
					<span className="conn" data-state={status}>
						<i />
						{status}
					</span>
					<div className="account">
						<span className="role-badge" data-role={user.role}>
							{user.role === "admin" ? "管理员" : "用户"}
						</span>
						<span className="account-name" title={user.username}>
							{user.username}
						</span>
						<button type="button" className="topmeta-action" onClick={() => setPasswordOpen(true)}>
							修改密码
						</button>
						<button type="button" className="topmeta-action" onClick={onSignOut}>
							退出登录
						</button>
					</div>
				</div>
			</header>
			<main className="main">
				{Active ? (
					<Active host={host} />
				) : (
					<div className="empty">
						<h2>没有可用的面板</h2>
						<p>{user.role === "admin" ? "平台已在运行，但没有任何插件注册面板。" : "当前账户没有可用的面板，请联系管理员。"}</p>
						{user.role === "admin" ? <code>moonan --plugin &lt;包名或目录&gt;</code> : null}
					</div>
				)}
			</main>
			{passwordOpen ? (
				<PasswordDialog onClose={() => setPasswordOpen(false)} onChanged={onPasswordChanged} />
			) : null}
		</div>
	);
}

function Bootstrapped({ user, onSignOut, onPasswordChanged }: SessionProps) {
	const { host, error } = useConnection();
	const [catalogFatal, setCatalogFatal] = useState<unknown>(null);
	const catalog = useRemote(host, WebFacetCatalog, {}, { onFatal: setCatalogFatal });
	const catalogStatus = useRefStatus(catalog);
	const version = useReadable<string>(catalog?.version, "");
	const facets = useReadable<FacetSetEntry[]>(catalog?.facets, []);
	const panels = usePanels(host);

	const live = catalogStatus === "live";
	// Chord owns the facet transaction; the hook owns only the shell's ledger of what is
	// installed (see facets.ts for the commit-vs-ready rules).
	const { signature: installedSignature, failures, batchFailure } = useFacetBatches(host, live, facets);

	// Hydration gates the shell; a reconnect does not. A dropped link puts the reference back
	// to `loading` while its last values stay readable, and unmounting the panels for that
	// would release every reference the drop was supposed to preserve.
	const [everLive, setEverLive] = useState(false);
	useEffect(() => {
		if (live) setEverLive(true);
	}, [live]);

	// A WebFacetCatalog that cannot bind will never become useful: the page needs the build that
	// knows the provider contract. `useRemote` reports only after its bounded retries, and
	// contract errors do not retry at all.
	useEffect(() => {
		if (!catalogFatal) return;
		if (
			isChordError(catalogFatal, "contract_mismatch") ||
			isChordError(catalogFatal, "upgrade_required")
		) {
			reloadOnce("web facet catalog contract mismatch");
		}
	}, [catalogFatal]);

	if (error) {
		// The shell that would know the user's language is exactly what failed to negotiate.
		return <Recovery title="界面版本不匹配 · UI version mismatch" detail="服务端已经更新，请刷新页面。 Reload the page to continue." />;
	}

	if (catalogFatal) {
		return (
			<Recovery
				title="界面需要刷新 · Reload required"
				detail={catalogFatal instanceof Error ? catalogFatal.message : String(catalogFatal)}
			/>
		);
	}

	if (batchFailure) {
		return <Recovery title="浏览器切面加载失败 · Facet batch failed" detail={batchFailure} />;
	}

	if (!host || !(live || everLive)) {
		return <div className="loading">Moonan / 连接中</div>;
	}

	// Only the first install gates the shell; a later revision swaps facets in place.
	if (!installedSignature) {
		return <div className="loading">Moonan …</div>;
	}

	const reported = facets.filter((facet) => facet.error);

	return (
		<>
			{failures.length > 0 || reported.length > 0 ? (
				<div className="banner">
					{[...reported.map((facet) => `${facet.name}: ${facet.error}`), ...failures].map((line) => (
						<div key={line}>{line}</div>
					))}
				</div>
			) : null}
			<Shell
				host={host}
				version={version}
				panels={panels}
				user={user}
				onSignOut={onSignOut}
				onPasswordChanged={onPasswordChanged}
			/>
		</>
	);
}

/**
 * The account gate.
 *
 * loading → setup page (no accounts yet) → login page → the Chord shell. The
 * `ConnectionProvider` only mounts in the last branch: the platform authenticates a WebSocket
 * by the session cookie, so a link created before login would be refused anyway. When a link
 * drops because the session ended (logout elsewhere, password/role change, removed account)
 * the provider reports it here and the gate returns to login.
 */
export function AuthGate() {
	const [state, setState] = useState<AuthState>({ status: "loading" });
	// Only the answer of the latest status request may reach the state; two quick re-auths
	// (a lost link and an explicit action) must not settle out of order.
	const generation = useRef(0);

	const load = useCallback(async () => {
		const id = (generation.current += 1);
		try {
			const status = await fetchAuthStatus();
			if (generation.current !== id) return;
			setState((current) => applyStatus(current, status));
		} catch (failure) {
			if (generation.current !== id) return;
			// A failure to ask must not tear down a shell that is already usable.
			setState((current) =>
				current.status === "authenticated" ? current : { status: "error", error: authErrorMessage(failure) },
			);
		}
	}, []);

	useEffect(() => {
		void load();
	}, [load]);

	/** The platform says the session is gone (the provider checked); no re-request is needed. */
	const signedOut = useCallback(() => {
		setState((current) =>
			current.status === "authenticated"
				? { status: "anonymous", setupRequired: false, version: current.version }
				: current,
		);
	}, []);

	const signOut = useCallback(async () => {
		try {
			await logout();
		} catch (failure) {
			console.warn("[moonan] logout failed", failure);
			// The cookie may or may not be gone; the status endpoint decides which page is safe.
			await load();
			return;
		}
		signedOut();
	}, [load, signedOut]);

	/** The server cleared the cookie and revoked every session; the login page explains why. */
	const passwordChanged = useCallback(() => {
		setState((current) =>
			current.status === "authenticated"
				? {
						status: "anonymous",
						setupRequired: false,
						version: current.version,
						notice: "密码已修改，请重新登录",
					}
				: current,
		);
	}, []);

	if (state.status === "loading") {
		return (
			<div className="auth-screen">
				<div className="loading">Moonan / 正在检查登录状态</div>
			</div>
		);
	}

	if (state.status === "error") {
		return <AuthFailure detail={state.error} onRetry={() => void load()} />;
	}

	if (state.status === "anonymous") {
		const authenticated = (user: AuthUser) =>
			setState({ status: "authenticated", user, version: state.version });
		return state.setupRequired ? (
			<SetupPage version={state.version} onAuthenticated={authenticated} onStale={() => void load()} />
		) : (
			<LoginPage version={state.version} notice={state.notice} onAuthenticated={authenticated} />
		);
	}

	return (
		<ConnectionProvider onAuthLost={signedOut}>
			<Bootstrapped user={state.user} onSignOut={signOut} onPasswordChanged={passwordChanged} />
		</ConnectionProvider>
	);
}

export function App() {
	return <AuthGate />;
}
