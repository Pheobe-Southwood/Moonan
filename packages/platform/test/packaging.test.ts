import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** The packages that go to npm. `web` is not one of them: its `dist` ships inside the platform. */
const PUBLISHED = ["packages/sdk", "packages/platform", "packages/ai-gateway"] as const;
const PRIVATE = ["packages/web"] as const;

interface Manifest {
	name?: string;
	version?: string;
	private?: boolean;
	files?: string[];
	publishConfig?: { access?: string };
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
	peerDependencies?: Record<string, string>;
}

function manifest(area: string): Manifest {
	return JSON.parse(readFileSync(join(root, area, "package.json"), "utf8")) as Manifest;
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
			const pkg = manifest(area);
			expect(pkg.private, `${area} must be publishable`).not.toBe(true);
			// Scoped packages default to restricted; without this the publish is refused.
			expect(pkg.publishConfig?.access, `${area} publishConfig.access`).toBe("public");
		}
		for (const area of PRIVATE) {
			expect(manifest(area).private, `${area} must stay private`).toBe(true);
		}
	});

	it("ships dist in every published package", () => {
		for (const area of PUBLISHED) {
			expect(manifest(area).files, `${area} files`).toContain("dist");
		}
	});

	it("keeps every version equal to the one `moonan --version` prints", () => {
		const version = sourceVersion();
		expect(manifest(".").version, "workspace version").toBe(version);
		for (const area of [...PUBLISHED, ...PRIVATE]) {
			expect(manifest(area).version, `${area} version`).toBe(version);
		}
	});

	it("never depends at runtime on a package that is not published", () => {
		// pnpm rewrites `workspace:*` to the real version at publish time. That rewrite is only
		// installable if the target is on npm, so a private workspace package may appear as a
		// build-time devDependency and nowhere else.
		const privateNames = PRIVATE.map((area) => {
			const name = manifest(area).name;
			expect(name, `${area} name`).toBeTruthy();
			return name!;
		});
		for (const area of PUBLISHED) {
			const pkg = manifest(area);
			for (const name of privateNames) {
				expect(pkg.dependencies?.[name], `${area} dependencies`).toBeUndefined();
				expect(pkg.peerDependencies?.[name], `${area} peerDependencies`).toBeUndefined();
			}
		}
	});
});
