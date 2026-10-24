import { Panels, type PanelContribution } from "@moonan_ai/web-api";
import { useEffect, useState } from "react";

/**
 * Reads the panels contributed to the browser host. Registries are per host, so this
 * re-subscribes whenever the host is replaced; the table is replaced wholesale at the
 * end of a load, which is why a single subscribe is enough.
 */
export function usePanels(host: unknown): PanelContribution[] {
	const [panels, setPanels] = useState<PanelContribution[]>([]);

	useEffect(() => {
		if (!host) {
			setPanels([]);
			return;
		}
		const view = (host as { registry(registry: unknown): any }).registry(Panels);
		const read = (table: Map<string, PanelContribution>) =>
			setPanels([...table.values()].sort((left, right) => left.order - right.order));
		read(view.table() as Map<string, PanelContribution>);
		const stop = view.subscribe(read);
		return () => stop();
	}, [host]);

	return panels;
}
