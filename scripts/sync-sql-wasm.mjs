#!/usr/bin/env node
/**
 * Copy the installed sql.js's wasm to `public/sql-wasm.wasm`.
 *
 * The client's database engine is sql.js, and sql.js's JavaScript only loads
 * the wasm built with it: a wasm from another version leaves the database
 * unable to start. js-bao depends on sql.js by a version range, so which
 * version an install resolves is not fixed, and a committed wasm goes stale
 * the day a newer sql.js is published. `codegen` (run by `dev`, `build` and
 * `test`) runs this first, so the browser and the headless tests both load
 * the wasm of the sql.js js-bao actually imports.
 *
 * The sql.js is resolved from js-bao's own location, not this app's: that is
 * the copy js-bao's engine imports. Before `pnpm install` there is nothing to
 * copy, and the committed file is left alone.
 */
import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const target = join(process.cwd(), "public", "sql-wasm.wasm");

/** The installed sql.js's `dist/sql-wasm.wasm`, or `null` before install. */
function installedWasm() {
  try {
    const fromApp = createRequire(join(process.cwd(), "package.json"));
    const fromJsBao = createRequire(fromApp.resolve("js-bao"));
    return fromJsBao.resolve("sql.js/dist/sql-wasm.wasm");
  } catch {
    return null;
  }
}

const source = installedWasm();
if (!source) {
  console.warn(
    "[sync-sql-wasm] js-bao's sql.js is not installed — keeping public/sql-wasm.wasm. Run `pnpm install`."
  );
} else if (
  !existsSync(target) ||
  !readFileSync(source).equals(readFileSync(target))
) {
  copyFileSync(source, target);
  console.log(`[sync-sql-wasm] public/sql-wasm.wasm <- ${source}`);
}
