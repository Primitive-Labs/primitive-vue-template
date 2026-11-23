// Where the app keeps its db3s: on the device, in the browser's origin-private
// file system (OPFS), so a db3 survives a reload and opens without a network.
import type { DatabaseConfig } from "js-bao-wss-client";
// URL imports (strings), never `?worker` / `?sharedworker` constructors: a
// Node test run that imports the client options must not start a worker.
import workerURL from "js-bao/format2-worker?worker&url";
// The broker hands a db3's store to every other tab of the app. js-bao starts
// it as a classic script, so pass the bundle's URL, never a module.
import brokerURL from "js-bao/format2-broker?url";
import sqliteWasmURL from "js-bao/sqlite3.wasm?url";

/**
 * The two wasm files js-bao asks for, by name: `sqlite3.wasm` (the worker's
 * store, from the package) and `sql-wasm.wasm` (the in-memory mirror, kept in
 * `public/` by `pnpm codegen`). Any other name throws: passed through, it
 * would resolve to the app's `index.html`.
 */
function locateFile(file: string): string {
  if (file === "sqlite3.wasm") return sqliteWasmURL;
  if (file === "sql-wasm.wasm") return "/sql-wasm.wasm";
  throw new Error(
    `locateFile: js-bao asked for ${file}, which src/config/storage.ts does not serve`
  );
}

/** The client's `databaseConfig`: the OPFS engine with its worker, broker and wasm files. */
export function getDatabaseConfig(): DatabaseConfig {
  return {
    type: "opfs",
    options: { workerURL, brokerURL, locateFile },
  };
}
