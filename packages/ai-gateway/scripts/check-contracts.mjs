/**
 * The server facet and the browser facet must agree on the contract fingerprints.
 *
 * `build:server` (tsc) and `build:web` (esbuild) are separate artifacts, and neither
 * `pnpm typecheck` nor the unit tests read a bundle. This check imports both artifacts the
 * way a host would and compares the fingerprints chord computes from the contract values.
 *
 * It runs at the end of `pnpm build` and again as `prepack`, so a pair assembled from two
 * different source revisions cannot be published even when only one side was rebuilt. The
 * web bundle is imported in Node, which needs the workspace `@moonan_ai/sdk` dist (built
 * before this package by the root `pnpm build`) and the `react` devDependency.
 */
const dist = (name) => new URL(`../dist/${name}`, import.meta.url);

async function load(entry, label) {
	try {
		return await import(entry);
	} catch (error) {
		console.error(
			`contract check: cannot import ${label}: ${error instanceof Error ? error.message : String(error)}\n` +
				"Build both facets from the repository root first (`pnpm build`, which also builds `@moonan_ai/sdk`), " +
				"and make sure the workspace devDependencies (react) are installed.",
		);
		process.exit(1);
	}
}

const CONTRACTS = ["AiGateway", "GatewayState"];

const server = await load(dist("contract.js"), "dist/contract.js");
const web = await load(dist("web.js"), "dist/web.js");

const failures = [];
for (const name of CONTRACTS) {
	const fromServer = server[name];
	const fromWeb = web[name];
	if (typeof fromServer?.fingerprint !== "string") {
		failures.push(`dist/contract.js does not export ${name}`);
		continue;
	}
	if (typeof fromWeb?.fingerprint !== "string") {
		failures.push(`dist/web.js does not export ${name} (did the web facet build include contract.ts?)`);
		continue;
	}
	if (fromServer.fingerprint !== fromWeb.fingerprint) {
		failures.push(`${name}: server ${fromServer.fingerprint} != web ${fromWeb.fingerprint}`);
	}
}

if (failures.length > 0) {
	console.error("contract check: the built facets disagree:");
	for (const failure of failures) console.error(`  - ${failure}`);
	console.error("Rebuild both facets from the same source (`pnpm build` from .), then retry.");
	process.exit(1);
}

console.log(`contract check: ${CONTRACTS.join(", ")} agree between dist/contract.js and dist/web.js`);
