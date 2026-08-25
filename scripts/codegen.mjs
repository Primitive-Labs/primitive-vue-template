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
 * Node builtins only — this runs before `pnpm install` has any say.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
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

/**
 * True when `<syncRoot>/<env>/<appId>/<kind>/` holds at least one `.toml`.
 * Mirrors the `.primitive/sync/*​/*​/<kind>/*.toml` glob the shell guard used.
 */
function hasSyncedToml(syncRoot, kind) {
  for (const env of subdirectories(syncRoot)) {
    for (const appId of subdirectories(join(syncRoot, env))) {
      const kindDir = join(syncRoot, env, appId, kind);
      try {
        if (readdirSync(kindDir).some((name) => name.endsWith(".toml"))) return true;
      } catch {
        // No such directory for this app — keep looking.
      }
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

const projectRoot = findProjectRoot(process.cwd()) ?? process.cwd();
const syncRoot = join(projectRoot, ".primitive", "sync");

if (hasSyncedToml(syncRoot, "database-type-configs")) {
  runPrimitive(["databases", "codegen", "-o", "src/types/generated"]);
}

if (hasSyncedToml(syncRoot, "workflows")) {
  runPrimitive(["workflows", "codegen", "-o", "src/types/generated/workflows"]);
}
