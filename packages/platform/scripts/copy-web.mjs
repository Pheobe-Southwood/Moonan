import { cp, mkdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

/**
 * Ships the built shell inside the platform package, so `npx @moonan_ai/moonan` serves
 * a UI without anyone building one. The source of truth stays `packages/web/dist`; this
 * is a copy, not a second build.
 */
const require = createRequire(import.meta.url);
const source = join(dirname(require.resolve("@moonan_ai/web/package.json")), "dist");
const target = new URL("../dist/web/", import.meta.url);

await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });
await cp(source, target, { recursive: true });
console.log(`copied ${source} -> ${target.pathname}`);
