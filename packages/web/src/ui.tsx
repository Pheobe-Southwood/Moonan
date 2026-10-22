import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from "react";

export function Field({
	label,
	help,
	htmlFor,
	children,
}: {
	label: string;
	help?: string;
	htmlFor?: string;
	children: ReactNode;
}) {
	return (
		<div className="field">
			<label htmlFor={htmlFor}>{label}</label>
			{children}
			{help ? <span className="help">{help}</span> : null}
		</div>
	);
}

export function Button({
	variant = "solid",
	size,
	children,
	...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "solid" | "ghost" | "danger"; size?: "sm" }) {
	const className = ["btn", variant !== "solid" ? `btn--${variant}` : "", size ? `btn--${size}` : ""].filter(Boolean).join(" ");
	return (
		<button type="button" className={className} {...rest}>
			{children}
		</button>
	);
}

export function TextInput(props: InputHTMLAttributes<HTMLInputElement> & { mono?: boolean }) {
	const { mono, className, ...rest } = props;
	return <input className={["input", mono ? "input--mono" : "", className ?? ""].filter(Boolean).join(" ")} {...rest} />;
}

export function TextArea(props: TextareaHTMLAttributes<HTMLTextAreaElement> & { mono?: boolean }) {
	const { mono, className, ...rest } = props;
	return <textarea className={["textarea", mono ? "textarea--mono" : "", className ?? ""].filter(Boolean).join(" ")} {...rest} />;
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
	const { className, ...rest } = props;
	return <select className={["select", className ?? ""].filter(Boolean).join(" ")} {...rest} />;
}

export function Tag({ tone, children }: { tone?: "on" | "warn"; children: ReactNode }) {
	return (
		<span className="tag" data-tone={tone}>
			{children}
		</span>
	);
}

export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (next: boolean) => void; label: string }) {
	return (
		<label className="switch">
			<input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
			<span className="switch-track" />
			{label}
		</label>
	);
}

export function PageHead({
	eyebrow,
	title,
	lede,
	actions,
}: {
	eyebrow: string;
	title: string;
	lede?: string;
	actions?: ReactNode;
}) {
	return (
		<div className="page-head">
			<div>
				<p className="eyebrow">{eyebrow}</p>
				<h1>{title}</h1>
				{lede ? <p className="lede">{lede}</p> : null}
			</div>
			{actions ? <div className="inline">{actions}</div> : null}
		</div>
	);
}

export function Empty({ children }: { children: ReactNode }) {
	return <div className="empty">{children}</div>;
}

export function ErrorNote({ error }: { error: string | null | undefined }) {
	if (!error) return null;
	return <div className="banner">{error}</div>;
}

export function ConnDot({ state }: { state: string }) {
	return <span className="dot" data-state={state} />;
}
