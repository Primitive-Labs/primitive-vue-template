import type { Plugin } from "vite";

/** The Node built-ins sql.js's loader requires, on its Node branch only. */
const SQL_JS_NODE_BUILTINS = new Set(["fs", "path", "crypto"]);
const EMPTY_MODULE = "\0sql.js-node-builtin";

/**
 * Give sql.js's Node-only `require("fs" | "path" | "crypto")` an empty module
 * in the production build.
 *
 * sql.js is the in-memory engine the app's database runs in the browser, so
 * it is bundled. Its emscripten loader requires those three built-ins only
 * when it runs under Node; left to Vite, each one becomes a browser stub and a
 * build warning. Any other module importing a Node built-in still warns.
 * Dev and `vitest` (which run sql.js under Node) are untouched.
 */
export function sqlJsNodeBuiltins(): Plugin {
  return {
    name: "sql-js-node-builtins",
    apply: "build",
    enforce: "pre",
    resolveId(id, importer) {
      if (!SQL_JS_NODE_BUILTINS.has(id) || !importer) return null;
      return /[\\/]node_modules[\\/]sql\.js[\\/]/.test(importer)
        ? EMPTY_MODULE
        : null;
    },
    load(id) {
      return id === EMPTY_MODULE ? "export default {};" : null;
    },
  };
}
