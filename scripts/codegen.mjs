#!/usr/bin/env node
/**
 * Regenerate the typed database and workflow surfaces from this app's SYNCED
 * server config — the `.primitive/sync/<env>/<appId>/` export tree.
 *
 * Why a script and not a shell one-liner in `package.json`: the sync tree sits
 * beside `.primitive/config.json`, and that config is not always in this
 * directory. One Primitive app can have several clients (a web client and a
 * native client in sibling directories), in which case the project config and
 * its sync export live at the REPO ROOT and this package is one client inside
 * it. A client-relative `ls .primitive/sync/*​/*​/…` guard never matches there,
 * so both codegens were skipped silently and every build compiled whatever
 * generated code happened to be in the tree.
 *
 * So: walk up to the nearest `.primitive/config.json` (the way git finds
 * `.git`, and the way the CLI itself resolves the project) and glob the sync
 * tree beside it. A standalone scaffold's nearest ancestor is itself, which is
 * exactly the old behavior.
 *
 * The `primitive` commands are still run FROM THIS DIRECTORY: the output paths
 * are client-relative, and the CLI resolves the project root on its own.
 *
 * The guard is scoped to ONE environment (#3078). It used to answer "does any
 * environment have this class synced?", while the CLI it then invokes resolves
 * exactly one — PRIMITIVE_ENV, then this machine's `primitive env use`
 * selection, then `defaultEnvironment`, then a sole environment — and errors
 * when that one's directory is empty. An app with workflows synced under
 * `alpha` while `dev` is selected therefore failed `pnpm dev`, `pnpm build` and
 * `pnpm test` alike. So ask the same question the CLI will.
 *
 * Node builtins only — this runs before `pnpm install` has any say.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** The nearest ancestor directory (starting at `from`) that holds a project config. */
function findProjectRoot(from) {
  let dir = resolve(from);
  for (;;) {
    if (existsSync(join(dir, ".primitive", "config.json"))) return dir;
    const parent = dirname(dir);
    // Stop at the filesystem root rather than looping forever.
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Directory names inside `dir`, or `[]` when it does not exist. */
function subdirectories(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

/** A JSON object at `path`, or `null` when it is missing or unreadable. */
function readJson(path) {
  try {
    const value = JSON.parse(readFileSync(path, "utf-8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * The environment and app slot the CLI itself will resolve, or `null` when no
 * single one can be determined.
 *
 * The order is the CLI's: PRIMITIVE_ENV, then `.primitive/local.json` (written
 * by `primitive env use`), then the committed `defaultEnvironment`, then a sole
 * environment. A selection naming an undefined environment resolves to nothing
 * here on purpose — the CLI reports that properly, with the available names.
 */
function resolveSelection(projectRoot) {
  const config = readJson(join(projectRoot, ".primitive", "config.json"));
  if (!config) return null;
  const environments = config.environments;
  if (!environments || typeof environments !== "object") return null;

  const local = readJson(join(projectRoot, ".primitive", "local.json")) ?? {};
  const selected =
    typeof local.selectedEnvironment === "string" && local.selectedEnvironment
      ? local.selectedEnvironment
      : null;

  const names = Object.keys(environments);
  const candidate =
    process.env.PRIMITIVE_ENV || selected || config.defaultEnvironment || null;

  const name = candidate ?? (names.length === 1 ? names[0] : null);
  if (!name || !Object.prototype.hasOwnProperty.call(environments, name)) return null;

  const appId = environments[name]?.appId;
  return { name, appId: typeof appId === "string" ? appId : null };
}

/** True when `<syncRoot>/<env>/<appId>/<kind>/` holds at least one `.toml`. */
function kindHasToml(syncRoot, env, appId, kind) {
  try {
    return readdirSync(join(syncRoot, env, appId, kind)).some((name) =>
      name.endsWith(".toml"),
    );
  } catch {
    // No such directory for this app — nothing synced.
    return false;
  }
}

/**
 * True when the SELECTED environment's app slot has `kind` synced.
 *
 * Two deliberate fallbacks. An environment with no `appId` scopes to the
 * environment and accepts any app slot inside it. And when no single
 * environment resolves at all — several defined, none selected — the guard
 * widens back to every environment, so an app that really does have TOMLs
 * invokes the CLI and gets the CLI's own resolver error rather than a silent
 * skip of work the developer asked for.
 */
function hasSyncedToml(syncRoot, kind, selection) {
  const environments = selection ? [selection.name] : subdirectories(syncRoot);
  for (const env of environments) {
    const slots =
      selection?.appId != null ? [selection.appId] : subdirectories(join(syncRoot, env));
    for (const appId of slots) {
      if (kindHasToml(syncRoot, env, appId, kind)) return true;
    }
  }
  return false;
}

/** Run a `primitive` subcommand from this client directory; exit on failure. */
function runPrimitive(args) {
  const result = spawnSync("primitive", args, { stdio: "inherit", shell: false });
  if (result.error) {
    console.error(
      `Error: could not run \`primitive ${args.join(" ")}\`: ${result.error.message}`,
    );
    console.error(
      "  Install the CLI with: pnpm add -g primitive-admin   (or: npm install -g primitive-admin)",
    );
    process.exit(1);
  }
  // Propagate the failure the way the old `&&` chain did.
  if (result.status !== 0) process.exit(result.status ?? 1);
}

// No config anywhere is a scaffold that is not a project yet: nothing to
// generate, and nothing to fail about.
const projectRoot = findProjectRoot(process.cwd());
if (projectRoot) {
  const syncRoot = join(projectRoot, ".primitive", "sync");
  const selection = resolveSelection(projectRoot);

  if (hasSyncedToml(syncRoot, "database-type-configs", selection)) {
    runPrimitive(["databases", "codegen", "-o", "src/types/generated"]);
  }

  if (hasSyncedToml(syncRoot, "workflows", selection)) {
    runPrimitive(["workflows", "codegen", "-o", "src/types/generated/workflows"]);
  }
}
