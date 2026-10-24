import { Panels, type PanelContribution } from "@moonan_ai/sdk/web";
import { useEffect, useState } from "react";

/**
 * Reads the panels contributed to the browser host.
 *
 * Registries are per host, so this re-subscribes whenever the host is replaced. A load
 * installs its whole table in one commit, which is why a single subscribe is enough: the
 * listener sees the completed table, never a half-loaded one.
 */
export function usePanels(host: unknown): PanelContribution[] {
	const [panels, setPanels] = useState<PanelContribution[]>([]);

	useEffect(() => {
		if (!host) {
			setPanels([]);
			return;
		}
		const view = (host as { registry(registry: unknown): any }).registry(Panels);
		const read = (table: ReadonlyMap<string, PanelContribution>) =>
			setPanels(
				[...table.values()]
					.map((panel, index) => ({ panel, index }))
					.sort((left, right) => (left.panel.order ?? 0) - (right.panel.order ?? 0) || left.index - right.index)
					.map(({ panel }) => panel),
			);
		read(view.table() as ReadonlyMap<string, PanelContribution>);
		const stop = view.subscribe(read);
		return () => stop();
	}, [host]);

	return panels;
}
