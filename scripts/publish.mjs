/**
 * Publish the workspace to npm, skipping versions that already exist.
 *
 * `pnpm -r publish` aborts on the first 403, which makes a partially published
 * release impossible to finish. This walks the packages in dependency order and
 * publishes only what is missing, so re-running a failed release is safe.
 *
 * Usage: node scripts/publish.mjs [--tag alpha] [--dry-run]
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

// Dependency order: a package is published after everything it depends on.
const order = ["packages/contracts", "packages/plugin-sdk", "packages/core", "packages/testing", "packages/moonan"];

const args = process.argv.slice(2);
const tagIndex = args.indexOf("--tag");
const tag = tagIndex >= 0 ? args[tagIndex + 1] : "alpha";
const dryRun = args.includes("--dry-run");

function readManifest(dir) {
	return JSON.parse(readFileSync(join(root, dir, "package.json"), "utf8"));
}

function isPublished(name, version) {
	try {
		execFileSync("npm", ["view", `${name}@${version}`, "version"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

let failed = false;
for (const dir of order) {
	const manifest = readManifest(dir);
	if (manifest.private) {
		console.log(`skip ${manifest.name} (private)`);
		continue;
	}
	const spec = `${manifest.name}@${manifest.version}`;
	if (isPublished(manifest.name, manifest.version)) {
		console.log(`skip ${spec} (already published)`);
		continue;
	}
	console.log(`publishing ${spec}`);
	if (dryRun) continue;
	try {
		execFileSync("pnpm", ["publish", "--access", "public", "--tag", tag, "--no-git-checks"], {
			cwd: join(root, dir),
			stdio: "inherit",
		});
	} catch (error) {
		failed = true;
		console.error(`failed to publish ${spec}`, error instanceof Error ? error.message : error);
		break;
	}
}

process.exit(failed ? 1 : 0);
