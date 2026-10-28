import {
	useEffect,
	useId,
	useRef,
	useState,
	type ChangeEvent,
	type CSSProperties,
	type ReactNode,
} from "react";
import { AlertIcon, CloseIcon, PlusIcon, TrashIcon } from "./icons.js";
import { parseJsonValue } from "./format.js";

export function classes(...values: (string | false | null | undefined)[]): string {
	return values.filter(Boolean).join(" ");
}

export function Button({
	children,
	variant = "default",
	small = false,
	disabled = false,
	type = "button",
	onClick,
	title,
	style,
}: {
	children: ReactNode;
	variant?: "default" | "primary" | "signal" | "ghost" | "danger";
	small?: boolean;
	disabled?: boolean;
	type?: "button" | "submit";
	onClick?: () => void;
	title?: string;
	style?: CSSProperties;
}) {
	return (
		<button
			type={type}
			className="gw-btn"
			data-variant={variant === "default" ? undefined : variant}
			data-small={small ? "true" : undefined}
			disabled={disabled}
			onClick={onClick}
			title={title}
			style={style}
		>
			{children}
		</button>
	);
}

export function IconButton({
	children,
	label,
	onClick,
	tone,
	disabled,
}: {
	children: ReactNode;
	label: string;
	onClick?: () => void;
	tone?: "danger";
	disabled?: boolean;
}) {
	return (
		<button
			type="button"
			className="gw-icon-btn"
			data-tone={tone}
			aria-label={label}
			title={label}
			onClick={onClick}
			disabled={disabled}
		>
			{children}
		</button>
	);
}

export function Field({
	label,
	htmlFor,
	help,
	error,
	hint,
	children,
}: {
	label: string;
	htmlFor?: string;
	help?: ReactNode;
	error?: string;
	hint?: ReactNode;
	children: ReactNode;
}) {
	return (
		<div className="gw-field">
			<label className="gw-label" htmlFor={htmlFor}>
				<span>{label}</span>
				{hint ? <span>{hint}</span> : null}
			</label>
			{children}
			{help ? <div className="gw-help">{help}</div> : null}
			{error ? <div className="gw-error">{error}</div> : null}
		</div>
	);
}

export function TextInput({
	value,
	onChange,
	placeholder,
	mono,
	type = "text",
	id,
	autoFocus,
	invalid,
	disabled,
	autoComplete,
	list,
}: {
	value: string;
	onChange: (value: string) => void;
	placeholder?: string;
	mono?: boolean;
	type?: "text" | "password" | "url" | "number";
	id?: string;
	autoFocus?: boolean;
	invalid?: boolean;
	disabled?: boolean;
	autoComplete?: string;
	list?: string;
}) {
	return (
		<input
			id={id}
			className="gw-input"
			data-mono={mono ? "true" : undefined}
			data-invalid={invalid ? "true" : undefined}
			type={type}
			value={value}
			placeholder={placeholder}
			autoFocus={autoFocus}
			disabled={disabled}
			autoComplete={autoComplete}
			list={list}
			onChange={(event: ChangeEvent<HTMLInputElement>) => onChange(event.target.value)}
		/>
	);
}

export function TextArea({
	value,
	onChange,
	placeholder,
	rows = 4,
	mono,
	id,
	invalid,
	className,
}: {
	value: string;
	onChange: (value: string) => void;
	placeholder?: string;
	rows?: number;
	mono?: boolean;
	id?: string;
	invalid?: boolean;
	className?: string;
}) {
	return (
		<textarea
			id={id}
			className={classes("gw-textarea", className)}
			data-mono={mono ? "true" : undefined}
			data-invalid={invalid ? "true" : undefined}
			rows={rows}
			value={value}
			placeholder={placeholder}
			onChange={(event: ChangeEvent<HTMLTextAreaElement>) => onChange(event.target.value)}
		/>
	);
}

export function Select({
	value,
	onChange,
	options,
	id,
	disabled,
}: {
	value: string;
	onChange: (value: string) => void;
	options: readonly { value: string; label: string }[];
	id?: string;
	disabled?: boolean;
}) {
	return (
		<select
			id={id}
			className="gw-select"
			value={value}
			disabled={disabled}
			onChange={(event: ChangeEvent<HTMLSelectElement>) => onChange(event.target.value)}
		>
			{options.map((option) => (
				<option key={option.value} value={option.value}>
					{option.label}
				</option>
			))}
		</select>
	);
}

export function Toggle({
	checked,
	onChange,
	label,
}: {
	checked: boolean;
	onChange: (value: boolean) => void;
	label: string;
}) {
	return (
		<label className="gw-toggle">
			<input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
			<span className="gw-toggle-track" />
			<span>{label}</span>
		</label>
	);
}

export function Checkbox({
	checked,
	onChange,
	label,
	disabled,
}: {
	checked: boolean;
	onChange: (value: boolean) => void;
	label: string;
	disabled?: boolean;
}) {
	return (
		<label className="gw-check">
			<input
				type="checkbox"
				checked={checked}
				disabled={disabled}
				onChange={(event) => onChange(event.target.checked)}
			/>
			<span>{label}</span>
		</label>
	);
}

export function Section({
	title,
	note,
	lede,
	children,
}: {
	title: string;
	note?: ReactNode;
	lede?: ReactNode;
	children: ReactNode;
}) {
	return (
		<section className="gw-section">
			<div className="gw-section-head">
				<h3>{title}</h3>
				{note ? <div className="gw-section-note">{note}</div> : null}
			</div>
			{lede ? <p className="gw-section-lede">{lede}</p> : null}
			{children}
		</section>
	);
}

export function Notice({
	tone = "warning",
	children,
}: {
	tone?: "warning" | "error" | "info";
	children: ReactNode;
}) {
	return (
		<div className="gw-notice" data-tone={tone === "warning" ? undefined : tone} role={tone === "error" ? "alert" : undefined}>
			<AlertIcon size={13} />
			<div>{children}</div>
		</div>
	);
}

export function KeyValueEditor({
	value,
	onChange,
	keyPlaceholder = "名称",
	valuePlaceholder = "值",
	addLabel = "添加一项",
}: {
	value: Record<string, string>;
	onChange: (value: Record<string, string>) => void;
	keyPlaceholder?: string;
	valuePlaceholder?: string;
	addLabel?: string;
}) {
	const [rows, setRows] = useState<{ key: string; value: string }[]>(() =>
		Object.entries(value).map(([key, entry]) => ({ key, value: entry })),
	);
	const commit = (next: { key: string; value: string }[]) => {
		setRows(next);
		const record: Record<string, string> = {};
		for (const row of next) {
			if (row.key.trim().length > 0) record[row.key.trim()] = row.value;
		}
		onChange(record);
	};
	return (
		<div className="gw-kv">
			{rows.map((row, index) => (
				<div className="gw-kv-row" key={index}>
					<input
						className="gw-input"
						data-mono="true"
						value={row.key}
						placeholder={keyPlaceholder}
						onChange={(event) => {
							const next = rows.slice();
							next[index] = { ...row, key: event.target.value };
							commit(next);
						}}
					/>
					<input
						className="gw-input"
						value={row.value}
						placeholder={valuePlaceholder}
						onChange={(event) => {
							const next = rows.slice();
							next[index] = { ...row, value: event.target.value };
							commit(next);
						}}
					/>
					<button
						type="button"
						className="gw-mini-btn"
						aria-label="删除这一项"
						onClick={() => commit(rows.filter((_, cursor) => cursor !== index))}
					>
						<TrashIcon size={12} />
					</button>
				</div>
			))}
			<button
				type="button"
				className="gw-btn"
				data-variant="ghost"
				data-small="true"
				onClick={() => commit([...rows, { key: "", value: "" }])}
				style={{ alignSelf: "flex-start" }}
			>
				<PlusIcon size={11} /> {addLabel}
			</button>
		</div>
	);
}

export function JsonField({
	value,
	onChange,
	onValidity,
	rows = 4,
	placeholder,
	label,
}: {
	value: unknown;
	onChange: (value: unknown) => void;
	onValidity?: (valid: boolean) => void;
	rows?: number;
	placeholder?: string;
	label?: string;
}) {
	const [text, setText] = useState(() => (value === undefined ? "" : JSON.stringify(value, null, 2)));
	const [error, setError] = useState<string>();
	return (
		<div className="gw-field">
			{label ? (
				<div className="gw-label">
					<span>{label}</span>
					<code>JSON</code>
				</div>
			) : null}
			<textarea
				className="gw-textarea gw-json"
				rows={rows}
				value={text}
				placeholder={placeholder ?? "{}"}
				data-invalid={error ? "true" : undefined}
				onChange={(event) => {
					const next = event.target.value;
					setText(next);
					const parsed = parseJsonValue(next);
					if (parsed.ok) {
						setError(undefined);
						onValidity?.(true);
						onChange(parsed.value);
					} else {
						setError(parsed.error);
						onValidity?.(false);
					}
				}}
				onBlur={() => {
					const parsed = parseJsonValue(text);
					if (parsed.ok && parsed.value !== undefined) {
						setText(JSON.stringify(parsed.value, null, 2));
					}
				}}
			/>
			{error ? <div className="gw-error">{error}</div> : <div className="gw-help">留空即不使用。</div>}
		</div>
	);
}

export function Backdrop({ onClose }: { onClose: () => void }) {
	return <div className="gw-backdrop" onClick={onClose} aria-hidden="true" />;
}

function useDialogFocus(open: boolean, onClose: () => void) {
	const ref = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (!open) return;
		const previous = document.activeElement as HTMLElement | null;
		const dialog = ref.current;
		const focusable = dialog?.querySelector<HTMLElement>(
			'button, input, select, textarea, [href], [tabindex]:not([tabindex="-1"])',
		);
		focusable?.focus();
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				event.stopPropagation();
				onClose();
				return;
			}
			if (event.key !== "Tab" || !dialog) return;
			const focusable = [...dialog.querySelectorAll<HTMLElement>(
				'button, input, select, textarea, [href], [tabindex]:not([tabindex="-1"])',
			)].filter((element) => !element.hasAttribute("disabled") && element.getClientRects().length > 0);
			if (focusable.length === 0) return;
			const first = focusable[0]!;
			const last = focusable[focusable.length - 1]!;
			if (event.shiftKey && document.activeElement === first) {
				event.preventDefault();
				last.focus();
			} else if (!event.shiftKey && document.activeElement === last) {
				event.preventDefault();
				first.focus();
			}
		};
		document.addEventListener("keydown", onKey);
		return () => {
			document.removeEventListener("keydown", onKey);
			previous?.focus?.();
		};
	}, [open, onClose]);
	return ref;
}

export function Drawer({
	open,
	onClose,
	kicker,
	title,
	subtitle,
	footer,
	children,
	width,
}: {
	open: boolean;
	onClose: () => void;
	kicker?: string;
	title: string;
	subtitle?: ReactNode;
	footer?: ReactNode;
	children: ReactNode;
	width?: number;
}) {
	const ref = useDialogFocus(open, onClose);
	const id = useId();
	if (!open) return null;
	return (
		<>
			<Backdrop onClose={onClose} />
			<div
				className="gw-sheet"
				role="dialog"
				aria-modal="true"
				aria-labelledby={id}
				ref={ref}
				style={width ? { width: `min(${width}px, 94vw)` } : undefined}
			>
				<div className="gw-sheet-head">
					<div>
						{kicker ? <div className="gw-sheet-kicker">{kicker}</div> : null}
						<h2 className="gw-sheet-title" id={id}>
							{title}
						</h2>
						{subtitle ? <div className="gw-sheet-sub">{subtitle}</div> : null}
					</div>
					<button type="button" className="gw-icon-btn" aria-label="关闭" onClick={onClose}>
						<CloseIcon />
					</button>
				</div>
				<div className="gw-sheet-body">{children}</div>
				{footer ? <div className="gw-sheet-foot">{footer}</div> : null}
			</div>
		</>
	);
}

export function Modal({
	open,
	onClose,
	title,
	subtitle,
	footer,
	children,
	width,
}: {
	open: boolean;
	onClose: () => void;
	title: string;
	subtitle?: ReactNode;
	footer?: ReactNode;
	children: ReactNode;
	width?: number;
}) {
	const ref = useDialogFocus(open, onClose);
	const id = useId();
	if (!open) return null;
	return (
		<>
			<Backdrop onClose={onClose} />
			<div
				className="gw-modal"
				role="dialog"
				aria-modal="true"
				aria-labelledby={id}
				ref={ref}
				style={width ? { width: `min(${width}px, 94vw)` } : undefined}
			>
				<div className="gw-modal-head">
					<div>
						<h2 className="gw-modal-title" id={id}>
							{title}
						</h2>
						{subtitle ? <div className="gw-modal-sub">{subtitle}</div> : null}
					</div>
					<button type="button" className="gw-icon-btn" aria-label="关闭" onClick={onClose}>
						<CloseIcon />
					</button>
				</div>
				<div className="gw-modal-body">{children}</div>
				{footer ? <div className="gw-modal-foot">{footer}</div> : null}
			</div>
		</>
	);
}

export function Toast({
	message,
	tone,
	onClose,
}: {
	message: { title: string; detail?: string } | null;
	tone: "success" | "error" | "info";
	onClose: () => void;
}) {
	useEffect(() => {
		if (!message) return;
		const timer = window.setTimeout(onClose, 4_500);
		return () => window.clearTimeout(timer);
	}, [message, onClose]);
	if (!message) return null;
	return (
		<div className="gw-toast" data-tone={tone} role="status" aria-live="polite">
			<strong>{message.title}</strong>
			{message.detail ? <span>{message.detail}</span> : null}
		</div>
	);
}

export function EmptyMark() {
	const heights = [12, 20, 16, 26, 22, 30, 18, 24];
	return (
		<div className="gw-empty-mark" aria-hidden="true">
			{heights.map((height, index) => (
				<i key={index} style={{ "--h": `${height}px`, "--o": 0.3 + index * 0.07 } as CSSProperties} />
			))}
		</div>
	);
}
