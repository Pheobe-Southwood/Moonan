import { createContext, useContext, useMemo, type ReactNode } from "react";

export type Locale = "zh" | "en";

/** A plugin's own strings. `useT(messages)` layers them over the shell's dictionary. */
export type Messages = Record<Locale, Record<string, string>>;

const zh: Record<string, string> = {
	"brand.tagline": "沉浸式角色扮演",
	"panel.unknown.title": "未知面板",
	"panel.unknown.body": "这个面板由插件提供，当前版本还没有加载它的界面：",
	"conn.connecting": "连接中",
	"conn.open": "已连接",
	"conn.closed": "已断开",
	"common.save": "保存",
	"common.saved": "已保存",
	"common.cancel": "取消",
	"common.remove": "删除",
	"common.add": "添加",
	"common.refresh": "刷新",
	"common.search": "搜索",
	"common.none": "无",
	"common.optional": "可选",
	"common.retry": "重试",
	"common.loading": "加载中",
	"common.required": "必填",
	"upgrade.title": "界面版本不匹配",
	"upgrade.body": "服务端已经更新，请刷新页面。",
	"panel.empty": "没有可用的面板",
};

const en: Record<string, string> = {
	"brand.tagline": "Immersive roleplay",
	"panel.unknown.title": "Unknown panel",
	"panel.unknown.body": "A plugin provides this panel, but this version has no UI for it yet:",
	"conn.connecting": "Connecting",
	"conn.open": "Connected",
	"conn.closed": "Disconnected",
	"common.save": "Save",
	"common.saved": "Saved",
	"common.cancel": "Cancel",
	"common.remove": "Remove",
	"common.add": "Add",
	"common.refresh": "Refresh",
	"common.search": "Search",
	"common.none": "None",
	"common.optional": "optional",
	"common.retry": "Retry",
	"common.loading": "Loading",
	"common.required": "required",
	"upgrade.title": "UI version mismatch",
	"upgrade.body": "The server was updated. Reload the page.",
	"panel.empty": "No panels available",
};

const DICTIONARIES: Record<Locale, Record<string, string>> = { zh, en };

const LocaleContext = createContext<{ locale: Locale; t: (key: string) => string }>({
	locale: "zh",
	t: (key) => zh[key] ?? key,
});

export function LocaleProvider({ locale, children }: { locale: Locale; children: ReactNode }) {
	const value = useMemo(() => {
		const dict = DICTIONARIES[locale] ?? zh;
		return { locale, t: (key: string) => dict[key] ?? zh[key] ?? key };
	}, [locale]);
	return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

/**
 * `useT()` reads the shell dictionary. A panel passes its own `messages` and gets a
 * translator that falls back to the shell, so `common.save` never has to be duplicated.
 */
export function useT(extra?: Messages): (key: string) => string {
	const { locale, t: base } = useContext(LocaleContext);
	return useMemo(() => {
		if (!extra) return base;
		const dict = extra[locale] ?? {};
		return (key: string) => dict[key] ?? base(key);
	}, [extra, locale, base]);
}

export function useLocale(): Locale {
	return useContext(LocaleContext).locale;
}
