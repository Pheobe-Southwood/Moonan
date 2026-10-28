/** Scoped styles for the gateway panel. Every selector lives under `.gw-root`. */
export const GATEWAY_CSS = String.raw`
.gw-root {
  --gw-ink: #071316;
  --gw-ink-2: #0a1a1d;
  --gw-surface: #0c2023;
  --gw-surface-2: #10292c;
  --gw-bone: #f2ead8;
  --gw-bone-dim: #d8d0bd;
  --gw-muted: #93aaa6;
  --gw-faint: #7e9490;
  --gw-line: rgba(242, 234, 216, 0.13);
  --gw-line-strong: rgba(242, 234, 216, 0.24);
  --gw-violet: #b6a4ff;
  --gw-coral: #ff7a59;
  --gw-jade: #6fe3c1;
  --gw-amber: #f4c56a;
  --gw-rose: #ff8fa3;
  --gw-sky: #8ac7ff;
  --gw-serif: "Noto Serif CJK SC", "Songti SC", "STSong", "SimSun", "Iowan Old Style", "Palatino Linotype", Georgia, serif;
  --gw-sans: "Noto Sans CJK SC", "Avenir Next", "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  --gw-mono: "DejaVu Sans Mono", "SFMono-Regular", "Cascadia Code", Menlo, monospace;
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background:
    radial-gradient(900px 460px at 92% -18%, rgba(182, 164, 255, 0.09), transparent 62%),
    radial-gradient(700px 420px at 0% 110%, rgba(111, 227, 193, 0.05), transparent 60%),
    var(--gw-ink);
  color: var(--gw-bone);
  font-family: var(--gw-sans);
  font-size: 14px;
  line-height: 1.55;
  color-scheme: dark;
  position: relative;
  isolation: isolate;
}
.gw-root *,
.gw-root *::before,
.gw-root *::after { box-sizing: border-box; }
.gw-root button,
.gw-root input,
.gw-root select,
.gw-root textarea { font: inherit; }
.gw-root h1,
.gw-root h2,
.gw-root h3,
.gw-root p { margin: 0; }
.gw-root a { color: var(--gw-violet); }
.gw-root ::selection { background: rgba(182, 164, 255, 0.3); color: var(--gw-bone); }
.gw-root :focus-visible { outline: 2px solid var(--gw-violet); outline-offset: 2px; }
.gw-root ::-webkit-scrollbar { width: 9px; height: 9px; }
.gw-root ::-webkit-scrollbar-track { background: transparent; }
.gw-root ::-webkit-scrollbar-thumb { background: rgba(242, 234, 216, 0.16); border-radius: 99px; border: 2px solid var(--gw-ink); }
.gw-root ::-webkit-scrollbar-thumb:hover { background: rgba(242, 234, 216, 0.28); }

.gw-head {
  position: relative;
  flex: 0 0 auto;
  display: grid;
  grid-template-columns: minmax(0, 1.08fr) minmax(340px, 0.92fr);
  gap: 34px;
  padding: 27px 34px 20px;
  border-bottom: 1px solid var(--gw-line);
  background:
    linear-gradient(180deg, rgba(12, 32, 35, 0.78), rgba(7, 19, 22, 0.2)),
    radial-gradient(760px 320px at 84% -30%, rgba(255, 122, 89, 0.07), transparent 70%);
}
.gw-head::before {
  content: "";
  position: absolute;
  inset: 0 0 auto;
  height: 1px;
  background: linear-gradient(90deg, transparent, rgba(182, 164, 255, 0.55), rgba(255, 122, 89, 0.25), transparent);
}
.gw-head-copy { min-width: 0; display: flex; flex-direction: column; justify-content: center; }
.gw-title {
  font-family: var(--gw-serif);
  font-size: clamp(42px, 4.2vw, 64px);
  font-weight: 500;
  line-height: 0.96;
  letter-spacing: -0.045em;
  color: var(--gw-bone);
  text-wrap: balance;
}
.gw-lede {
  margin-top: 12px;
  max-width: 54ch;
  color: var(--gw-muted);
  font-size: 13px;
  line-height: 1.65;
}
.gw-head-figures {
  display: flex;
  align-items: flex-end;
  flex-wrap: wrap;
  gap: 8px 26px;
  margin-top: 20px;
}
.gw-figure { min-width: 0; }
.gw-figure-value {
  font-family: var(--gw-serif);
  font-size: 24px;
  line-height: 1.05;
  font-variant-numeric: tabular-nums;
  letter-spacing: -0.02em;
  color: var(--gw-bone-dim);
}
.gw-figure-label {
  margin-top: 3px;
  color: var(--gw-faint);
  font-size: 10.5px;
  letter-spacing: 0.01em;
}
.gw-figure-value[data-tone="jade"] { color: var(--gw-jade); }
.gw-figure-value[data-tone="violet"] { color: var(--gw-violet); }

.gw-spectrum {
  align-self: stretch;
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  min-width: 0;
  border-left: 1px solid var(--gw-line);
  padding-left: 28px;
}
.gw-spectrum-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
.gw-spectrum-title { color: var(--gw-muted); font-size: 11px; }
.gw-spectrum-legend { display: flex; gap: 9px; align-items: center; min-width: 0; overflow: hidden; }
.gw-legend { display: inline-flex; gap: 5px; align-items: center; color: var(--gw-faint); font-size: 10px; white-space: nowrap; }
.gw-legend i { width: 5px; height: 5px; border-radius: 50%; background: var(--c); flex: none; }
.gw-bars {
  position: relative;
  display: flex;
  align-items: flex-end;
  gap: 2px;
  height: 92px;
  margin-top: 9px;
  padding-top: 4px;
  border-bottom: 1px solid var(--gw-line-strong);
  overflow: hidden;
}
.gw-bar {
  appearance: none;
  flex: 1 1 3px;
  min-width: 2px;
  max-width: 12px;
  padding: 0;
  border: 0;
  cursor: pointer;
  border-radius: 1.5px 1.5px 0 0;
  background: var(--c);
  opacity: var(--o, 0.82);
  transform-origin: bottom;
  animation: gw-rise 0.62s cubic-bezier(0.2, 0.8, 0.2, 1) both;
  animation-delay: calc(var(--i) * 5ms);
  transition: opacity 0.2s ease, filter 0.2s ease;
}
.gw-bar:hover { opacity: 1; filter: brightness(1.28); }
.gw-bars-empty {
  flex: 1;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--gw-faint);
  font-size: 11px;
  border-bottom: 1px dashed var(--gw-line);
}
.gw-spectrum-foot {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  margin-top: 6px;
  color: var(--gw-faint);
  font-size: 9.5px;
  font-variant-numeric: tabular-nums;
}

.gw-body { flex: 1 1 auto; min-height: 0; display: grid; grid-template-columns: 292px minmax(0, 1fr); }
.gw-rail {
  min-height: 0;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 20px 16px 20px;
  border-right: 1px solid var(--gw-line);
  background: linear-gradient(180deg, rgba(12, 32, 35, 0.35), rgba(7, 19, 22, 0.08));
}
.gw-rail-head { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; padding: 0 4px; }
.gw-rail-title { font-family: var(--gw-serif); font-size: 19px; letter-spacing: -0.02em; color: var(--gw-bone-dim); }
.gw-rail-count { color: var(--gw-faint); font-size: 10.5px; font-variant-numeric: tabular-nums; }
.gw-search { position: relative; }
.gw-search svg { position: absolute; left: 10px; top: 50%; transform: translateY(-50%); color: var(--gw-faint); pointer-events: none; }
.gw-search .gw-input { padding-left: 31px; height: 34px; background: rgba(6, 16, 18, 0.5); }
.gw-provider-list { display: flex; flex-direction: column; gap: 2px; }
.gw-provider {
  position: relative;
  display: grid;
  grid-template-columns: 9px minmax(0, 1fr) auto;
  gap: 10px;
  align-items: center;
  width: 100%;
  padding: 11px 9px 11px 11px;
  border: 0;
  border-left: 2px solid transparent;
  background: transparent;
  color: var(--gw-muted);
  text-align: left;
  cursor: pointer;
  transition: background 0.16s ease, color 0.16s ease;
}
.gw-provider:hover { background: rgba(242, 234, 216, 0.045); color: var(--gw-bone); }
.gw-provider[aria-current="true"] {
  background: linear-gradient(90deg, rgba(182, 164, 255, 0.14), rgba(182, 164, 255, 0.015) 78%, transparent);
  border-left-color: var(--gw-violet);
  color: var(--gw-bone);
}
.gw-provider[data-disabled="true"] .gw-provider-name { color: var(--gw-faint); }
.gw-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--c); box-shadow: 0 0 0 3px color-mix(in srgb, var(--c) 12%, transparent); }
.gw-dot[data-muted="true"] { background: transparent; border: 1px solid var(--gw-faint); box-shadow: none; }
.gw-provider-main { min-width: 0; }
.gw-provider-name { font-size: 13px; line-height: 1.25; color: inherit; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.gw-provider-meta { margin-top: 3px; display: flex; gap: 6px; align-items: center; min-width: 0; color: var(--gw-faint); font-family: var(--gw-mono); font-size: 9.5px; }
.gw-provider-meta span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gw-provider-count { color: var(--gw-faint); font-size: 10px; font-variant-numeric: tabular-nums; }
.gw-provider-alert { color: var(--gw-amber); font-size: 9.5px; }
.gw-rail-empty { padding: 18px 8px; color: var(--gw-faint); font-size: 11.5px; line-height: 1.6; }
.gw-rail-add {
  margin-top: auto;
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  padding: 10px;
  border: 1px dashed var(--gw-line-strong);
  background: transparent;
  color: var(--gw-muted);
  font-size: 12px;
  cursor: pointer;
  transition: border-color 0.16s ease, color 0.16s ease, background 0.16s ease;
}
.gw-rail-add:hover { border-color: var(--gw-violet); color: var(--gw-bone); background: rgba(182, 164, 255, 0.06); }
.gw-rail-note { margin-top: 12px; padding: 0 4px; color: var(--gw-faint); font-size: 10px; line-height: 1.55; display: flex; gap: 6px; align-items: flex-start; }
.gw-rail-note svg { flex: none; margin-top: 2px; color: var(--gw-jade); }

.gw-main { min-height: 0; overflow: auto; padding: 26px 32px 46px; }
.gw-main-inner { width: 100%; max-width: 1120px; margin: 0 auto; }
.gw-loading, .gw-gone { min-height: 240px; display: grid; place-items: center; color: var(--gw-muted); font-size: 12px; }
.gw-gone { text-align: center; gap: 8px; }
.gw-gone strong { font-family: var(--gw-serif); font-size: 24px; font-weight: 500; color: var(--gw-bone); }

.gw-masthead { display: flex; align-items: flex-start; justify-content: space-between; gap: 22px; }
.gw-masthead-copy { min-width: 0; }
.gw-masthead-name {
  font-family: var(--gw-serif);
  font-size: clamp(34px, 3.6vw, 50px);
  font-weight: 500;
  line-height: 1;
  letter-spacing: -0.04em;
  color: var(--gw-bone);
  overflow-wrap: anywhere;
}
.gw-badges { display: flex; flex-wrap: wrap; align-items: center; gap: 7px; margin-top: 11px; }
.gw-badge {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 2px 7px;
  border: 1px solid var(--gw-line);
  color: var(--gw-muted);
  font-size: 10px;
  line-height: 1.6;
  white-space: nowrap;
}
.gw-badge[data-tone="jade"] { color: var(--gw-jade); border-color: rgba(111, 227, 193, 0.3); }
.gw-badge[data-tone="amber"] { color: var(--gw-amber); border-color: rgba(244, 197, 106, 0.3); }
.gw-badge[data-tone="violet"] { color: var(--gw-violet); border-color: rgba(182, 164, 255, 0.3); }
.gw-badge[data-tone="rose"] { color: var(--gw-rose); border-color: rgba(255, 143, 163, 0.3); }
.gw-badge i { width: 5px; height: 5px; border-radius: 50%; background: currentColor; }
.gw-meta-grid { display: flex; flex-wrap: wrap; gap: 6px 24px; margin-top: 17px; color: var(--gw-muted); font-size: 11.5px; }
.gw-meta { display: flex; gap: 7px; align-items: baseline; min-width: 0; max-width: 100%; }
.gw-meta-label { color: var(--gw-faint); font-size: 10px; flex: none; }
.gw-meta code { font-family: var(--gw-mono); font-size: 10.5px; color: var(--gw-bone-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gw-actions { display: flex; align-items: center; gap: 7px; flex: none; padding-top: 4px; }
.gw-icon-btn {
  appearance: none;
  display: inline-grid;
  place-items: center;
  width: 31px;
  height: 31px;
  padding: 0;
  border: 1px solid var(--gw-line-strong);
  background: transparent;
  color: var(--gw-muted);
  cursor: pointer;
  transition: color 0.16s ease, border-color 0.16s ease, background 0.16s ease;
}
.gw-icon-btn:hover { color: var(--gw-bone); border-color: var(--gw-bone-dim); background: rgba(242, 234, 216, 0.06); }
.gw-icon-btn[data-tone="danger"]:hover { color: var(--gw-rose); border-color: rgba(255, 143, 163, 0.5); }

.gw-btn {
  appearance: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 7px 12px;
  border: 1px solid var(--gw-line-strong);
  background: transparent;
  color: var(--gw-bone);
  font-size: 11.5px;
  line-height: 1.4;
  cursor: pointer;
  white-space: nowrap;
  transition: background 0.16s ease, border-color 0.16s ease, color 0.16s ease, opacity 0.16s ease;
}
.gw-btn:hover { background: rgba(242, 234, 216, 0.07); }
.gw-btn[data-variant="primary"] { background: var(--gw-bone); border-color: var(--gw-bone); color: var(--gw-ink); }
.gw-btn[data-variant="primary"]:hover { background: #fff8e8; }
.gw-btn[data-variant="signal"] { background: var(--gw-coral); border-color: var(--gw-coral); color: #1a0b07; }
.gw-btn[data-variant="signal"]:hover { background: #ff9177; }
.gw-btn[data-variant="ghost"] { border-color: transparent; color: var(--gw-muted); }
.gw-btn[data-variant="ghost"]:hover { color: var(--gw-bone); background: rgba(242, 234, 216, 0.05); }
.gw-btn[data-variant="danger"] { color: var(--gw-rose); border-color: rgba(255, 143, 163, 0.35); }
.gw-btn[data-variant="danger"]:hover { background: rgba(255, 143, 163, 0.08); }
.gw-btn:disabled { opacity: 0.42; cursor: not-allowed; }
.gw-btn[data-variant="signal"]:disabled { background: rgba(255, 122, 89, 0.22); border-color: rgba(255, 122, 89, 0.22); color: rgba(26, 11, 7, 0.72); }
.gw-btn[data-small="true"] { padding: 4px 8px; font-size: 10.5px; }

.gw-figures {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  margin-top: 24px;
  border-top: 1px solid var(--gw-line);
  border-bottom: 1px solid var(--gw-line);
}
.gw-figure-cell { padding: 12px 16px 12px 0; border-right: 1px solid var(--gw-line); min-width: 0; }
.gw-figure-cell:last-child { border-right: 0; }
.gw-figure-cell .gw-figure-value { font-size: 20px; }
.gw-figure-cell .gw-figure-label { margin-top: 2px; }

.gw-tabs { display: flex; gap: 24px; margin-top: 22px; border-bottom: 1px solid var(--gw-line); }
.gw-tab {
  appearance: none;
  position: relative;
  padding: 10px 0 9px;
  margin-bottom: -1px;
  border: 0;
  border-bottom: 2px solid transparent;
  background: transparent;
  color: var(--gw-muted);
  font-size: 12.5px;
  cursor: pointer;
}
.gw-tab:hover { color: var(--gw-bone); }
.gw-tab[aria-selected="true"] { color: var(--gw-bone); border-bottom-color: var(--gw-coral); }
.gw-tab span { margin-left: 6px; color: var(--gw-faint); font-size: 10px; font-variant-numeric: tabular-nums; }

.gw-toolbar { display: flex; align-items: center; gap: 10px; padding: 16px 0 12px; }
.gw-toolbar .gw-search { flex: 1; max-width: 310px; }
.gw-toolbar .gw-search .gw-input { height: 31px; font-size: 12px; }
.gw-toolbar-count { margin-left: auto; color: var(--gw-faint); font-size: 10.5px; font-variant-numeric: tabular-nums; }
.gw-model-head, .gw-model {
  display: grid;
  grid-template-columns: minmax(0, 1.55fr) 76px 84px 84px 116px 62px;
  gap: 10px;
  align-items: center;
}
.gw-model-head { padding: 0 10px 7px; color: var(--gw-faint); font-size: 10px; border-bottom: 1px solid var(--gw-line); }
.gw-model {
  position: relative;
  padding: 11px 10px;
  border-bottom: 1px solid var(--gw-line);
  cursor: pointer;
  transition: background 0.14s ease;
}
.gw-model:hover { background: rgba(242, 234, 216, 0.035); }
.gw-model[data-selected="true"] { background: rgba(182, 164, 255, 0.06); }
.gw-model::before {
  content: "";
  position: absolute;
  left: 0;
  top: 9px;
  bottom: 9px;
  width: 2px;
  background: transparent;
}
.gw-model[data-selected="true"]::before { background: var(--gw-violet); }
.gw-model-main { min-width: 0; }
.gw-model-name { color: var(--gw-bone); font-size: 12.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.gw-model-id { margin-top: 2px; color: var(--gw-faint); font-family: var(--gw-mono); font-size: 9.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.gw-model-cell { min-width: 0; color: var(--gw-muted); font-size: 10.5px; font-variant-numeric: tabular-nums; }
.gw-model-cell[data-mono="true"] { font-family: var(--gw-mono); font-size: 9.5px; }
.gw-price { color: var(--gw-bone-dim); }
.gw-price small { color: var(--gw-faint); font-size: 9px; }
.gw-model-actions { display: flex; justify-content: flex-end; gap: 2px; opacity: 0.25; transition: opacity 0.14s ease; }
.gw-model:hover .gw-model-actions, .gw-model:focus-within .gw-model-actions { opacity: 1; }
.gw-mini-btn {
  appearance: none;
  display: inline-grid;
  place-items: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--gw-muted);
  cursor: pointer;
}
.gw-mini-btn:hover { color: var(--gw-bone); background: rgba(242, 234, 216, 0.07); }
.gw-mini-btn[data-tone="danger"]:hover { color: var(--gw-rose); }
.gw-tag {
  display: inline-flex;
  align-items: center;
  border: 1px solid var(--gw-line);
  color: var(--gw-faint);
  font-size: 10px;
  line-height: 1.45;
  padding: 1px 5px;
  white-space: nowrap;
}
.gw-tag[data-tone="violet"] { color: var(--gw-violet); border-color: rgba(182, 164, 255, 0.28); }
.gw-tag[data-tone="jade"] { color: var(--gw-jade); border-color: rgba(111, 227, 193, 0.28); }
.gw-tag[data-tone="amber"] { color: var(--gw-amber); border-color: rgba(244, 197, 106, 0.28); }
.gw-tags { display: flex; gap: 3px; flex-wrap: wrap; }

.gw-empty {
  position: relative;
  margin-top: 6px;
  padding: 44px 24px 40px;
  border: 1px solid var(--gw-line);
  background:
    radial-gradient(500px 180px at 50% 0%, rgba(182, 164, 255, 0.08), transparent 70%),
    rgba(12, 32, 35, 0.35);
  text-align: center;
  overflow: hidden;
}
.gw-empty::before {
  content: "";
  position: absolute;
  left: 12%;
  right: 12%;
  top: 18px;
  height: 1px;
  background: linear-gradient(90deg, transparent, var(--gw-line-strong), transparent);
}
.gw-empty-mark { margin: 0 auto 14px; width: 72px; height: 28px; display: flex; align-items: flex-end; justify-content: center; gap: 4px; opacity: 0.8; }
.gw-empty-mark i { display: block; width: 4px; background: var(--gw-violet); height: var(--h); opacity: var(--o); }
.gw-empty h3 { font-family: var(--gw-serif); font-size: 27px; font-weight: 500; letter-spacing: -0.03em; color: var(--gw-bone); }
.gw-empty p { max-width: 46ch; margin: 8px auto 18px; color: var(--gw-muted); font-size: 12px; line-height: 1.65; }
.gw-empty .gw-actions { justify-content: center; }

.gw-section { border-top: 1px solid var(--gw-line); padding-top: 20px; margin-top: 22px; }
.gw-section:first-child { border-top: 0; padding-top: 0; margin-top: 0; }
.gw-section-head { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; margin-bottom: 14px; }
.gw-section h3 { font-family: var(--gw-serif); font-size: 22px; font-weight: 500; letter-spacing: -0.025em; color: var(--gw-bone-dim); }
.gw-section-note { color: var(--gw-faint); font-size: 10.5px; text-align: right; }
.gw-section-lede { margin: -6px 0 16px; color: var(--gw-faint); font-size: 11.5px; line-height: 1.6; max-width: 72ch; }

.gw-grid { display: grid; gap: 0 18px; }
.gw-grid[data-cols="2"] { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.gw-grid[data-cols="3"] { grid-template-columns: repeat(3, minmax(0, 1fr)); }
.gw-grid[data-cols="4"] { grid-template-columns: repeat(4, minmax(0, 1fr)); }
.gw-field { display: flex; flex-direction: column; gap: 5px; margin-bottom: 15px; min-width: 0; }
.gw-label { color: var(--gw-muted); font-size: 10.5px; display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.gw-label code { font-family: var(--gw-mono); color: var(--gw-faint); font-size: 9.5px; }
.gw-help { color: var(--gw-faint); font-size: 10px; line-height: 1.5; }
.gw-error { color: var(--gw-rose); font-size: 10.5px; line-height: 1.5; }
.gw-input, .gw-select, .gw-textarea {
  width: 100%;
  min-width: 0;
  padding: 7px 9px;
  border: 1px solid var(--gw-line-strong);
  border-radius: 2px;
  background: rgba(6, 16, 18, 0.72);
  color: var(--gw-bone);
  font-size: 12px;
  line-height: 1.45;
  outline: none;
  transition: border-color 0.16s ease, box-shadow 0.16s ease;
}
.gw-input::placeholder, .gw-textarea::placeholder { color: #536965; }
.gw-input:focus, .gw-select:focus, .gw-textarea:focus { border-color: var(--gw-violet); box-shadow: 0 0 0 2px rgba(182, 164, 255, 0.14); }
.gw-input[data-mono="true"], .gw-textarea[data-mono="true"] { font-family: var(--gw-mono); font-size: 11px; }
.gw-input[type="password"] { letter-spacing: 0.08em; }
.gw-input[type="number"] { -moz-appearance: textfield; appearance: textfield; }
.gw-input[type="number"]::-webkit-inner-spin-button,
.gw-input[type="number"]::-webkit-outer-spin-button { -webkit-appearance: none; margin: 0; }
.gw-select { appearance: none; background-image: linear-gradient(45deg, transparent 50%, var(--gw-faint) 50%), linear-gradient(135deg, var(--gw-faint) 50%, transparent 50%); background-position: calc(100% - 14px) 50%, calc(100% - 9px) 50%; background-size: 5px 5px, 5px 5px; background-repeat: no-repeat; padding-right: 26px; }
.gw-textarea { resize: vertical; min-height: 68px; }
.gw-input[data-invalid="true"], .gw-textarea[data-invalid="true"], .gw-select[data-invalid="true"] { border-color: rgba(255, 143, 163, 0.6); }
.gw-check { display: inline-flex; align-items: center; gap: 7px; color: var(--gw-muted); font-size: 11px; cursor: pointer; }
.gw-check input { accent-color: var(--gw-violet); width: 13px; height: 13px; }
.gw-toggle { position: relative; display: inline-flex; align-items: center; gap: 8px; color: var(--gw-muted); font-size: 11px; cursor: pointer; user-select: none; }
.gw-toggle input { position: absolute; opacity: 0; width: 1px; height: 1px; }
.gw-toggle-track { width: 34px; height: 18px; border: 1px solid var(--gw-line-strong); border-radius: 9px; background: rgba(6, 16, 18, 0.8); position: relative; transition: background 0.16s ease, border-color 0.16s ease; flex: none; }
.gw-toggle-track::after { content: ""; position: absolute; top: 2px; left: 2px; width: 12px; height: 12px; border-radius: 50%; background: var(--gw-faint); transition: transform 0.16s ease, background 0.16s ease; }
.gw-toggle input:checked + .gw-toggle-track { border-color: var(--gw-violet); background: rgba(182, 164, 255, 0.18); }
.gw-toggle input:checked + .gw-toggle-track::after { transform: translateX(16px); background: var(--gw-violet); }
.gw-toggle input:focus-visible + .gw-toggle-track { outline: 2px solid var(--gw-violet); outline-offset: 2px; }

.gw-kv { display: flex; flex-direction: column; gap: 6px; }
.gw-kv-row { display: grid; grid-template-columns: minmax(0, 0.8fr) minmax(0, 1.2fr) 26px; gap: 6px; align-items: center; }
.gw-kv-row .gw-input { height: 29px; font-size: 11px; }
.gw-json { font-family: var(--gw-mono); font-size: 10.5px; line-height: 1.55; min-height: 78px; }
.gw-inline { display: flex; align-items: center; gap: 9px; flex-wrap: wrap; }
.gw-stack { display: flex; flex-direction: column; gap: 8px; }
.gw-hint { color: var(--gw-faint); font-size: 10px; line-height: 1.55; }

.gw-notice {
  display: flex;
  gap: 9px;
  align-items: flex-start;
  padding: 9px 11px;
  border: 1px solid var(--gw-line);
  background: rgba(244, 197, 106, 0.055);
  color: var(--gw-amber);
  font-size: 11px;
  line-height: 1.55;
}
.gw-notice[data-tone="error"] { color: var(--gw-rose); background: rgba(255, 143, 163, 0.055); border-color: rgba(255, 143, 163, 0.22); }
.gw-notice[data-tone="info"] { color: var(--gw-muted); background: rgba(138, 199, 255, 0.04); border-color: rgba(138, 199, 255, 0.16); }
.gw-notice svg { flex: none; margin-top: 1px; }

.gw-backdrop {
  position: fixed;
  inset: 0;
  z-index: 80;
  background: rgba(3, 10, 11, 0.68);
  backdrop-filter: blur(3px);
  animation: gw-fade 0.18s ease-out both;
}
.gw-sheet {
  position: fixed;
  top: 0;
  right: 0;
  bottom: 0;
  z-index: 81;
  width: min(590px, 94vw);
  display: flex;
  flex-direction: column;
  border-left: 1px solid var(--gw-line-strong);
  background:
    radial-gradient(700px 300px at 100% 0%, rgba(182, 164, 255, 0.08), transparent 70%),
    var(--gw-ink-2);
  box-shadow: -34px 0 90px rgba(0, 0, 0, 0.5);
  animation: gw-sheet-in 0.24s cubic-bezier(0.2, 0.8, 0.2, 1) both;
}
.gw-sheet-head {
  flex: none;
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 18px;
  padding: 21px 24px 16px;
  border-bottom: 1px solid var(--gw-line);
}
.gw-sheet-kicker { color: var(--gw-coral); font-size: 10.5px; }
.gw-sheet-title { margin-top: 4px !important; font-family: var(--gw-serif); font-size: 30px; font-weight: 500; letter-spacing: -0.035em; line-height: 1.05; color: var(--gw-bone); overflow-wrap: anywhere; }
.gw-sheet-sub { margin-top: 5px; color: var(--gw-faint); font-size: 11px; }
.gw-sheet-body { flex: 1; min-height: 0; overflow: auto; padding: 20px 24px 30px; }
.gw-sheet-foot {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  padding: 13px 24px;
  border-top: 1px solid var(--gw-line);
  background: rgba(7, 19, 22, 0.72);
}
.gw-sheet-foot .gw-inline { min-width: 0; }
.gw-sheet-foot-note { color: var(--gw-faint); font-size: 10px; }

.gw-modal {
  position: fixed;
  z-index: 81;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  width: min(780px, 94vw);
  max-height: 86vh;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--gw-line-strong);
  background:
    radial-gradient(680px 300px at 80% -10%, rgba(182, 164, 255, 0.08), transparent 70%),
    var(--gw-ink-2);
  box-shadow: 0 34px 100px rgba(0, 0, 0, 0.6);
  animation: gw-modal-in 0.22s cubic-bezier(0.2, 0.8, 0.2, 1) both;
}
.gw-modal-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; padding: 20px 24px 15px; border-bottom: 1px solid var(--gw-line); }
.gw-modal-title { font-family: var(--gw-serif); font-size: 28px; font-weight: 500; letter-spacing: -0.035em; line-height: 1.05; color: var(--gw-bone); }
.gw-modal-sub { margin-top: 4px; color: var(--gw-faint); font-size: 11px; }
.gw-modal-body { flex: 1; min-height: 0; overflow: auto; padding: 18px 24px 22px; }
.gw-modal-foot { display: flex; align-items: center; justify-content: space-between; gap: 14px; padding: 13px 24px; border-top: 1px solid var(--gw-line); background: rgba(7, 19, 22, 0.72); }

.gw-segment { display: inline-flex; border: 1px solid var(--gw-line); }
.gw-segment button { appearance: none; border: 0; background: transparent; color: var(--gw-muted); padding: 6px 11px; font-size: 11px; cursor: pointer; }
.gw-segment button[aria-pressed="true"] { background: rgba(242, 234, 216, 0.08); color: var(--gw-bone); }
.gw-segment button + button { border-left: 1px solid var(--gw-line); }

.gw-preset-list { display: flex; flex-direction: column; border-top: 1px solid var(--gw-line); }
.gw-preset {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 92px 80px 62px;
  gap: 10px;
  align-items: center;
  padding: 10px 8px;
  border: 0;
  border-bottom: 1px solid var(--gw-line);
  background: transparent;
  color: var(--gw-muted);
  text-align: left;
  cursor: pointer;
}
.gw-preset:hover { background: rgba(242, 234, 216, 0.045); color: var(--gw-bone); }
.gw-preset:disabled { opacity: 0.35; cursor: not-allowed; }
.gw-preset-name { font-size: 12.5px; color: inherit; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gw-preset-id { margin-top: 2px; color: var(--gw-faint); font-family: var(--gw-mono); font-size: 9.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gw-preset-meta { color: var(--gw-faint); font-size: 10px; font-variant-numeric: tabular-nums; text-align: right; }
.gw-preset-meta b { display: block; color: var(--gw-muted); font-weight: 400; font-size: 12px; }
.gw-preset-add { justify-self: end; }

.gw-discover-list { display: flex; flex-direction: column; border-top: 1px solid var(--gw-line); }
.gw-discover {
  display: grid;
  grid-template-columns: 18px minmax(0, 1fr) 78px 70px 96px;
  gap: 9px;
  align-items: center;
  padding: 9px 6px;
  border-bottom: 1px solid var(--gw-line);
  cursor: pointer;
}
.gw-discover:hover { background: rgba(242, 234, 216, 0.035); }
.gw-discover[data-existing="true"] { opacity: 0.5; cursor: default; }
.gw-discover input { accent-color: var(--gw-violet); }
.gw-discover-name { font-size: 12px; color: var(--gw-bone); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gw-discover-id { margin-top: 1px; color: var(--gw-faint); font-family: var(--gw-mono); font-size: 9.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gw-discover-meta { color: var(--gw-faint); font-size: 10px; text-align: right; font-variant-numeric: tabular-nums; }
.gw-discover-status { color: var(--gw-jade); font-size: 9.5px; text-align: right; }
.gw-scanning { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; padding: 60px 20px; color: var(--gw-muted); font-size: 11.5px; text-align: center; }
.gw-scan-line { width: min(300px, 80%); height: 1px; background: var(--gw-line); position: relative; overflow: hidden; }
.gw-scan-line::after { content: ""; position: absolute; inset: 0; width: 38%; background: linear-gradient(90deg, transparent, var(--gw-violet), transparent); animation: gw-scan 1.2s ease-in-out infinite; }
.gw-scanning strong { font-family: var(--gw-serif); font-size: 23px; font-weight: 500; color: var(--gw-bone); }

.gw-root:has(.gw-sheet) .gw-toast,
.gw-root:has(.gw-modal) .gw-toast {
  right: auto;
  left: 22px;
}
.gw-toast {
  position: fixed;
  right: 22px;
  bottom: 20px;
  z-index: 95;
  min-width: 240px;
  max-width: min(420px, calc(100vw - 44px));
  padding: 10px 13px;
  border: 1px solid rgba(111, 227, 193, 0.34);
  background: #0a1c1e;
  color: var(--gw-bone);
  font-size: 11.5px;
  line-height: 1.5;
  box-shadow: 0 16px 50px rgba(0, 0, 0, 0.45);
  animation: gw-toast-in 0.22s ease-out both;
}
.gw-toast[data-tone="error"] { border-color: rgba(255, 143, 163, 0.45); }
.gw-toast[data-tone="info"] { border-color: rgba(138, 199, 255, 0.35); }
.gw-toast strong { display: block; font-weight: 500; margin-bottom: 2px; }
.gw-toast span { color: var(--gw-muted); }
.gw-sr { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }

@keyframes gw-rise { from { transform: scaleY(0); } to { transform: scaleY(1); } }
@keyframes gw-fade { from { opacity: 0; } to { opacity: 1; } }
@keyframes gw-sheet-in { from { transform: translateX(26px); opacity: 0; } to { transform: translateX(0); opacity: 1; } }
@keyframes gw-modal-in { from { transform: translate(-50%, -48%) scale(0.985); opacity: 0; } to { transform: translate(-50%, -50%) scale(1); opacity: 1; } }
@keyframes gw-toast-in { from { transform: translateY(8px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
@keyframes gw-scan { from { transform: translateX(-100%); } to { transform: translateX(300%); } }

@media (max-width: 1120px) {
  .gw-head { grid-template-columns: 1fr; gap: 18px; }
  .gw-spectrum { border-left: 0; border-top: 1px solid var(--gw-line); padding-left: 0; padding-top: 14px; }
  .gw-spectrum-legend { display: none; }
  .gw-bars { height: 64px; }
  .gw-body { grid-template-columns: 250px minmax(0, 1fr); }
  .gw-main { padding: 22px 24px 38px; }
  .gw-model-head, .gw-model { grid-template-columns: minmax(0, 1.5fr) 68px 78px 78px 96px 56px; }
}
@media (max-width: 860px) {
  .gw-root { height: auto; min-height: 100%; overflow: visible; }
  .gw-root:has(.gw-sheet) .gw-toast,
  .gw-root:has(.gw-modal) .gw-toast {
    top: 62px;
    right: 16px;
    bottom: auto;
    left: 16px;
    max-width: none;
  }
  .gw-head { padding: 22px 20px 18px; }
  .gw-body { display: block; }
  .gw-rail { border-right: 0; border-bottom: 1px solid var(--gw-line); overflow: visible; padding: 14px 16px; }
  .gw-provider-list { flex-direction: row; overflow-x: auto; gap: 6px; padding-bottom: 4px; }
  .gw-provider { flex: 0 0 auto; width: auto; min-width: 158px; border: 1px solid var(--gw-line); border-left-width: 2px; }
  .gw-provider[aria-current="true"] { border-left-color: var(--gw-violet); border-color: rgba(182, 164, 255, 0.35); }
  .gw-rail-add { margin-top: 0; }
  .gw-rail-note { display: none; }
  .gw-main { overflow: visible; padding: 20px 18px 34px; }
  .gw-masthead { flex-direction: column; gap: 14px; }
  .gw-actions { padding-top: 0; }
  .gw-figures { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .gw-figure-cell:nth-child(2) { border-right: 0; }
  .gw-figure-cell:nth-child(-n+2) { border-bottom: 1px solid var(--gw-line); }
  .gw-model-head { display: none; }
  .gw-model { grid-template-columns: minmax(0, 1fr) auto; gap: 7px 12px; padding: 12px 8px; }
  .gw-model-cell { display: none; }
  .gw-model-actions { opacity: 1; }
  .gw-toolbar { flex-wrap: wrap; }
  .gw-toolbar-count { width: 100%; margin-left: 0; }
  .gw-sheet { width: 100%; }
  .gw-grid[data-cols="3"], .gw-grid[data-cols="4"] { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .gw-preset { grid-template-columns: minmax(0, 1fr) 62px; }
  .gw-preset-meta:nth-child(2), .gw-preset-meta:nth-child(3) { display: none; }
  .gw-discover { grid-template-columns: 18px minmax(0, 1fr) 66px; }
  .gw-discover-meta:nth-of-type(2), .gw-discover-status { display: none; }
}
@media (max-width: 560px) {
  .gw-title { font-size: 38px; }
  .gw-head-figures { gap: 8px 18px; }
  .gw-figure-value { font-size: 20px; }
  .gw-figure-cell { padding-right: 10px; }
  .gw-grid[data-cols="2"], .gw-grid[data-cols="3"], .gw-grid[data-cols="4"] { grid-template-columns: 1fr; }
  .gw-actions { flex-wrap: wrap; }
  .gw-sheet-body, .gw-sheet-head, .gw-sheet-foot, .gw-modal-body, .gw-modal-head, .gw-modal-foot { padding-left: 16px; padding-right: 16px; }
  .gw-kv-row { grid-template-columns: 1fr 1.2fr 24px; }
}
@media (prefers-reduced-motion: reduce) {
  .gw-root *, .gw-root *::before, .gw-root *::after {
    animation-duration: 0.001ms !important;
    animation-delay: 0ms !important;
    transition-duration: 0.001ms !important;
  }
}

/* Small additions used by the panel composition. */
.gw-root .gw-accent {
  width: 46px;
  height: 2px;
  margin-bottom: 15px;
  background: var(--c, var(--gw-violet));
  box-shadow: 0 0 14px color-mix(in srgb, var(--c, var(--gw-violet)) 55%, transparent);
}
.gw-root .gw-banner {
  display: flex;
  align-items: center;
  gap: 9px;
  margin-bottom: 16px;
  padding: 9px 11px;
  border: 1px solid rgba(244, 197, 106, 0.28);
  background: rgba(244, 197, 106, 0.055);
  color: var(--gw-amber);
  font-size: 11px;
  line-height: 1.55;
}
.gw-root .gw-banner[data-tone="muted"] {
  border-color: var(--gw-line);
  background: rgba(242, 234, 216, 0.025);
  color: var(--gw-muted);
}
.gw-root .gw-skeleton {
  padding: 34px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.gw-root .gw-skeleton-line {
  height: 12px;
  width: var(--w, 60%);
  background: linear-gradient(90deg, rgba(242,234,216,.06), rgba(242,234,216,.12), rgba(242,234,216,.06));
  background-size: 200% 100%;
  animation: gw-shimmer 1.4s linear infinite;
}
@keyframes gw-shimmer { from { background-position: 200% 0; } to { background-position: -200% 0; } }
`;
