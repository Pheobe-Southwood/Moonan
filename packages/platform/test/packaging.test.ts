import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** The packages that go to npm. `web` is not one of them: its `dist` ships inside the platform. */
const PUBLISHED = ["packages/sdk", "packages/platform", "packages/ai-gateway", "packages/plugin-manager"] as const;
const PRIVATE = ["packages/web"] as const;

interface PackageJson {
	name?: string;
	version?: string;
	private?: boolean;
	files?: string[];
	publishConfig?: { access?: string };
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
	peerDependencies?: Record<string, string>;
	optionalDependencies?: Record<string, string>;
	moonan?: { officialPlugins?: { ref?: string; locked?: boolean }[] };
}

function packageJson(area: string): PackageJson {
	return JSON.parse(readFileSync(join(root, area, "package.json"), "utf8")) as PackageJson;
}

/** `moonan --version` prints this constant, so it is the version everything else must agree on. */
function sourceVersion(): string {
	const text = readFileSync(join(root, "packages/platform/src/index.ts"), "utf8");
	const match = /export const VERSION = "([^"]+)"/.exec(text);
	expect(match?.[1], "VERSION in packages/platform/src/index.ts").toBeTruthy();
	return match![1]!;
}

/**
 * The release contract, asserted rather than assumed.
 *
 * A package.json is the one file that only breaks on publish: a missing `publishConfig`
 * makes a scoped package private, a stale `version` publishes something that disagrees with
 * `moonan --version`, and a `files` entry that forgets `dist` ships an empty package. None
 * of that shows up in `pnpm build` or in the integration tests, so it is checked here.
 */
describe("packaging", () => {
	it("marks the published packages public and the build-only one private", () => {
		for (const area of PUBLISHED) {
			const pkg = packageJson(area);
			expect(pkg.private, `${area} must be publishable`).not.toBe(true);
			// Scoped packages default to restricted; without this the publish is refused.
			expect(pkg.publishConfig?.access, `${area} publishConfig.access`).toBe("public");
		}
		for (const area of PRIVATE) {
			expect(packageJson(area).private, `${area} must stay private`).toBe(true);
		}
	});

	it("ships dist in every published package", () => {
		for (const area of PUBLISHED) {
			expect(packageJson(area).files, `${area} files`).toContain("dist");
		}
	});

	it("keeps every version equal to the one `moonan --version` prints", () => {
		const version = sourceVersion();
		expect(packageJson(".").version, "workspace version").toBe(version);
		for (const area of [...PUBLISHED, ...PRIVATE]) {
			expect(packageJson(area).version, `${area} version`).toBe(version);
		}
	});

	it("declares every official plugin as an optional dependency", () => {
		const platform = packageJson("packages/platform");
		const manifest = platform.moonan?.officialPlugins ?? [];
		const optional = platform.optionalDependencies ?? {};
		expect(manifest.length, "moonan.officialPlugins").toBeGreaterThan(0);
		for (const item of manifest) {
			expect(typeof item.ref, "official ref").toBe("string");
			// `pnpm publish` rewrites `workspace:*` to the exact version; anything else would
			// either pin a stale version or make the platform installable without its plugins.
			expect(optional[item.ref!], `${item.ref} optionalDependency`).toBe("workspace:*");
		}
		// No silent extra: an optionalDependency the manifest does not list would be installed
		// but never seeded, which is the confusing half of a forgotten entry.
		for (const name of Object.keys(optional)) {
			expect(manifest.some((item) => item.ref === name), `${name} in moonan.officialPlugins`).toBe(true);
		}
		// The plugin manager must be locked: the page that manages plugins cannot be turned off
		// from that page.
		const manager = manifest.find((item) => item.locked === true);
		expect(manager, "a locked official plugin").toBeDefined();
	});

	it("never depends at runtime on a package that is not published", () => {
		// pnpm rewrites `workspace:*` to the real version at publish time. That rewrite is only
		// installable if the target is on npm, so a private workspace package may appear as a
		// build-time devDependency and nowhere else.
		const privateNames = PRIVATE.map((area) => {
			const name = packageJson(area).name;
			expect(name, `${area} name`).toBeTruthy();
			return name!;
		});
		for (const area of PUBLISHED) {
			const pkg = packageJson(area);
			for (const name of privateNames) {
				expect(pkg.dependencies?.[name], `${area} dependencies`).toBeUndefined();
				expect(pkg.peerDependencies?.[name], `${area} peerDependencies`).toBeUndefined();
			}
		}
	});
});
