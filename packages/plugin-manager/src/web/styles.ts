/** Scoped under `.pm-root`; rendered by the panel component, which owns the DOM effect. */
export const PLUGIN_MANAGER_CSS = `
.pm-root {
	--pm-fg: #1d2330;
	--pm-muted: #667085;
	--pm-line: #e3e7ef;
	--pm-bg: #ffffff;
	--pm-soft: #f6f8fc;
	--pm-accent: #3b6cf6;
	--pm-danger: #c43232;
	--pm-warn: #8a5a00;
	color: var(--pm-fg);
	padding: 24px;
	max-width: 1040px;
	margin: 0 auto;
	font-size: 14px;
	line-height: 1.5;
}
.pm-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 16px; }
.pm-header h2 { margin: 0 0 4px; font-size: 20px; }
.pm-sub { margin: 0; color: var(--pm-muted); }
.pm-header-actions { display: flex; gap: 8px; flex-shrink: 0; }
.pm-btn {
	appearance: none; border: 1px solid var(--pm-line); background: var(--pm-bg); color: var(--pm-fg);
	border-radius: 8px; padding: 6px 12px; font: inherit; cursor: pointer;
}
.pm-btn:hover:not(:disabled) { border-color: var(--pm-accent); color: var(--pm-accent); }
.pm-btn:disabled { opacity: 0.45; cursor: not-allowed; }
.pm-btn-primary { background: var(--pm-accent); border-color: var(--pm-accent); color: #fff; }
.pm-btn-primary:hover:not(:disabled) { color: #fff; filter: brightness(1.05); }
.pm-btn-danger { color: var(--pm-danger); border-color: #f0c9c9; }
.pm-btn-danger:hover:not(:disabled) { border-color: var(--pm-danger); color: var(--pm-danger); }
.pm-note { border: 1px solid var(--pm-line); border-radius: 10px; padding: 10px 14px; margin: 12px 0; background: var(--pm-soft); }
.pm-note-ok { border-color: #b7e0c2; background: #f0faf3; }
.pm-note-warn { border-color: #f0dcae; background: #fffaf0; color: var(--pm-warn); }
.pm-note-error { border-color: #f0c9c9; background: #fff5f5; color: var(--pm-danger); }
.pm-detail { margin-top: 6px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; word-break: break-all; }
.pm-install { display: flex; gap: 10px; align-items: center; margin: 18px 0 6px; flex-wrap: wrap; }
.pm-install input[type="text"] {
	flex: 1 1 320px; min-width: 240px; padding: 8px 10px; border: 1px solid var(--pm-line);
	border-radius: 8px; font: inherit;
}
.pm-check { display: inline-flex; align-items: center; gap: 6px; color: var(--pm-muted); }
.pm-hint { color: var(--pm-muted); font-size: 12px; margin: 0 0 18px; }
.pm-hint code, .pm-note code { background: var(--pm-soft); border: 1px solid var(--pm-line); border-radius: 4px; padding: 0 4px; }
.pm-list { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 10px; }
.pm-row {
	display: flex; justify-content: space-between; gap: 16px; align-items: flex-start;
	border: 1px solid var(--pm-line); border-radius: 12px; padding: 14px 16px; background: var(--pm-bg);
}
.pm-row[data-enabled="false"] { background: var(--pm-soft); }
.pm-row[data-error="true"] { border-color: #f0c9c9; }
.pm-row-main { min-width: 0; flex: 1; }
.pm-row-title { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.pm-version { color: var(--pm-muted); font-size: 12px; }
.pm-row-ref { margin-top: 4px; color: var(--pm-muted); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; word-break: break-all; }
.pm-row-error { margin-top: 6px; color: var(--pm-danger); font-size: 12px; word-break: break-word; }
.pm-row-meta { margin-top: 6px; display: flex; flex-wrap: wrap; gap: 12px; color: var(--pm-muted); font-size: 12px; }
.pm-row-meta a { color: var(--pm-accent); text-decoration: none; }
.pm-row-actions { display: flex; gap: 8px; flex-shrink: 0; }
.pm-badges { display: inline-flex; gap: 4px; flex-wrap: wrap; }
.pm-badge { font-size: 11px; padding: 1px 7px; border-radius: 999px; border: 1px solid var(--pm-line); color: var(--pm-muted); }
.pm-badge-builtin { border-color: #c9d6f7; color: #3357b5; background: #f3f6ff; }
.pm-badge-locked { border-color: #d8c9f0; color: #6a3fb5; background: #f8f3ff; }
.pm-badge-ephemeral { border-color: #d6dde8; color: #55627a; }
.pm-badge-off { border-color: #d6dde8; color: #55627a; background: #f2f4f8; }
.pm-badge-warn { border-color: #f0dcae; color: var(--pm-warn); background: #fffaf0; }
.pm-badge-error { border-color: #f0c9c9; color: var(--pm-danger); background: #fff5f5; }
.pm-badge-skipped { border-color: #f0dcae; color: var(--pm-warn); background: #fffaf0; }
.pm-empty { border: 1px dashed var(--pm-line); border-radius: 12px; padding: 24px; text-align: center; color: var(--pm-muted); }
.pm-paths { margin-top: 18px; color: var(--pm-muted); font-size: 12px; }
.pm-paths summary { cursor: pointer; }
.pm-paths dl { display: grid; grid-template-columns: max-content 1fr; gap: 4px 12px; margin: 10px 0 0; }
.pm-paths dt { color: var(--pm-muted); }
.pm-paths dd { margin: 0; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; word-break: break-all; }
@media (max-width: 720px) {
	.pm-root { padding: 14px; }
	.pm-row { flex-direction: column; }
	.pm-row-actions { width: 100%; }
	.pm-row-actions .pm-btn { flex: 1; }
}
`;
