import { defineRegistry } from "@earendil-works/chord";
import type { ComponentType } from "react";
import type { Locale } from "./i18n.js";

/**
 * What the shell hands to a panel. `host` is the browser chord host the web facet
 * was loaded into: every reference a panel holds comes from it.
 */
export interface PanelProps {
	host: unknown;
	user: string;
	locale: Locale;
}

/**
 * One top-level page a web facet contributes.
 *
 * The registry lives in the browser (chord registries are per host), so the kernel
 * never learns that panels exist and the shell never imports a plugin.
 */
export interface PanelContribution {
	id: string;
	order: number;
	/** The tab label is data, not a shell key: no dictionary entry has to exist for it. */
	title: Record<Locale, string>;
	component: ComponentType<PanelProps>;
}

export const Panels = defineRegistry<PanelContribution>("moonan.panels", { conflict: "error" });
