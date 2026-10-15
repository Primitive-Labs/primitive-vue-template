#!/usr/bin/env node
/**
 * Give a line of work its own child app, and tear it down when the work ends.
 *
 * Usage:
 *   pnpm child:up <slug> [--port <n>]
 *   pnpm child:down <slug> [--skip-teardown]
 *
 * A child app is a copy of the selected environment's app (its settings and
 * secrets), owned by you, that shares the parent's `primitive/<env>/` tree.
 * Run these from the app with the parent environment selected, or a sibling
 * child selected (the parent is then that child's tree).
 *
 * `up` creates the child (or attaches/resumes one that already exists),
 * checks that `--env <slug>` really is that child, runs the app's own
 * `scripts/child-app-init`, pushes the tree into the child, allows the dev
 * server's origin (`http://localhost:<port>`, default 5173) and selects the
 * child. Every step is safe to repeat, so running `up` again resumes an
 * interrupted run.
 *
 * `down` checks that `--env <localName>` is the child, runs the app's own
 * `scripts/child-app-teardown`, then deletes the child and its local state.
 * `--skip-teardown` deletes without running the hook (and without the check),
 * leaving anything the child created outside the platform behind.
 *
 * APP-OWNED HOOKS. This template ships neither hook; an app adds them as
 * executable files when it needs them:
 *
 *   scripts/child-app-init      run by `up` before the first push, on EVERY
 *                               `up`, so it must be safe to repeat. Seed what a
 *                               fresh child needs here: users, databases, the
 *                               child's own config vars (`primitive config
 *                               set vars KEY=value`), anything else.
 *   scripts/child-app-teardown  run by `down` before the delete. Revoke or
 *                               delete anything the child created outside the
 *                               platform (third-party connections, buckets,
 *                               webhooks). Exiting non-zero keeps the child.
 *
 * Each hook runs from the app root with PRIMITIVE_ENV (the child's local
 * environment name), CHILD_APP_ID, CHILD_APP_SLUG and PARENT_ENV set. Address
 * the child through PRIMITIVE_ENV (or `--env`), never through the selected
 * environment: a hook may change the selection, and this script does not rely
 * on it afterwards. Every `primitive` call made after a hook names its
 * environment explicitly.
 *
 * Node builtins only, and every spawn is an argv array with `shell: false`.
 */

import { spawn } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = resolve(__dirname, "..");
const DEFAULT_PORT = 5173;
const INIT_HOOK = "scripts/child-app-init";
const TEARDOWN_HOOK = "scripts/child-app-teardown";

const USAGE = `Usage:
  pnpm child:up <slug> [--port <n>]       create or resume a child app, push the tree into it, select it
  pnpm child:down <slug> [--skip-teardown] run the teardown hook, then delete the child`;

function say(...lines) {
  for (const line of lines) console.log(`[child-app] ${line}`);
}

function fail(...lines) {
  for (const line of lines) console.error(`[child-app] ${line}`);
  process.exit(1);
}

function usage(problem) {
  fail(problem, ...USAGE.split("\n"));
}

function parseArgs(argv) {
  const [verb, ...rest] = argv;
  if (verb !== "up" && verb !== "down") usage(`Unknown command "${verb ?? ""}".`);
  const parsed = { verb, slug: null, port: DEFAULT_PORT, skipTeardown: false };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--") continue;
    if (verb === "up" && (arg === "--port" || arg.startsWith("--port="))) {
      const value = arg === "--port" ? rest[++i] : arg.slice("--port=".length);
      if (value === undefined || !/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535) {
        usage(`--port must be a whole number from 1 to 65535; got "${value ?? ""}".`);
      }
      parsed.port = Number(value);
    } else if (verb === "down" && arg === "--skip-teardown") {
      parsed.skipTeardown = true;
    } else if (arg.startsWith("-")) {
      usage(`Unknown option "${arg}" for ${verb}.`);
    } else if (parsed.slug === null) {
      parsed.slug = arg;
    } else {
      usage(`Unexpected argument "${arg}".`);
    }
  }
  // The CLI validates the slug's characters; this only keeps a missing slug,
  // or one that would read as an option, from reaching it.
  if (parsed.slug === null || parsed.slug === "") usage("A child slug is required.");
  if (/\s/.test(parsed.slug)) usage(`The slug "${parsed.slug}" contains whitespace.`);
  return parsed;
}

/** Runs `primitive <args>` and returns its exit code and output, without printing it. */
function capture(args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("primitive", args, {
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      cwd: ROOT_DIR,
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    child.on("close", (code) => resolvePromise({ code: code ?? 1, stdout, stderr }));
    child.on("error", reject);
  });
}

/** Runs `primitive <args>` with its output passed through, and returns its exit code. */
function run(args) {
  return new Promise((resolvePromise, reject) => {
    say(`> primitive ${args.join(" ")}`);
    const child = spawn("primitive", args, {
      stdio: "inherit",
      shell: false,
      cwd: ROOT_DIR,
      env: process.env,
    });
    child.on("close", (code) => resolvePromise(code ?? 1));
    child.on("error", reject);
  });
}

/** The CLI's own words, for a failure this script repeats. */
function cliOutput(result) {
  return `${result.stderr}${result.stdout}`
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line && !line.startsWith("CLI Version:"))
    .map((line) => `  ${line}`);
}

/** `primitive <args> --json`, parsed; any failure exits naming the command. */
async function json(args) {
  const result = await capture([...args, "--json"]);
  if (result.code !== 0) {
    fail(`'primitive ${args.join(" ")} --json' failed:`, ...cliOutput(result));
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    fail(`'primitive ${args.join(" ")} --json' did not print JSON:`, ...cliOutput(result));
  }
}

/**
 * The selected environment and the parent it implies: a child's tree, or the
 * committed environment itself.
 */
async function resolveParent() {
  const shown = await json(["env", "show"]);
  return { selected: shown.name, parent: shown.local === true ? shown.tree : shown.name };
}

/** Every child of `parent`, following the listing's cursor. */
async function listChildren(parent) {
  const items = [];
  let cursor;
  for (;;) {
    const page = await json([
      "--env",
      parent,
      "apps",
      "children",
      "list",
      "--limit",
      "100",
      ...(cursor ? ["--cursor", cursor] : []),
    ]);
    items.push(...(page.items ?? []));
    if (!page.hasMore || !page.nextCursor) return items;
    cursor = page.nextCursor;
  }
}

/**
 * Refuses a slug that names an environment this machine already has under
 * another meaning — a committed environment in primitive/config.json — before
 * anything selects it: `env use <slug>` would select that environment
 * instead of attaching the child.
 */
async function refuseCommittedName(slug, parent, createdHere) {
  const shown = await capture(["env", "show", slug, "--json"]);
  if (shown.code !== 0) return;
  fail(
    `"${slug}" is a committed environment in primitive/config.json, so the child "${slug}" cannot be attached under that name on this machine.`,
    ...(createdHere
      ? [
          `The child now exists on the server but is not registered here. Delete it with 'primitive --env ${parent} apps children delete ${slug} --yes'.`,
        ]
      : []),
    "Nothing was selected, run or pushed. Choose another slug.",
  );
}

/** Attaches the child `slug` of `parent` as a local environment. */
async function attach(slug, parent) {
  const code = await run(["--env", parent, "env", "use", slug]);
  if (code !== 0) {
    fail(
      `'primitive --env ${parent} env use ${slug}' failed. The child exists on the server; fix the problem above and run 'pnpm child:up ${slug}' again.`,
    );
  }
}

/**
 * Creates the child `slug` of `parent`, or attaches or resumes it when it
 * exists, and returns its app id.
 */
async function createOrAttach(slug, parent) {
  const got = await capture(["--env", parent, "apps", "children", "get", slug, "--json"]);
  if (got.code === 0) {
    const child = JSON.parse(got.stdout);
    if (child.local) {
      if (child.localName !== slug) {
        fail(
          `The child "${slug}" (${child.appId}) is registered on this machine as "${child.localName}".`,
          `Run 'primitive env use ${child.localName}' to work on it; nothing was run or pushed.`,
        );
      }
      say(`Resuming the child "${slug}" (${child.appId}).`);
      return child.appId;
    }
    if (child.localConflict) {
      fail(
        `The local environment "${slug}" holds a different app, ${child.localConflict.appId} (tree "${child.localConflict.tree}"), not the child "${slug}" (${child.appId}).`,
        "Nothing was selected, run or pushed. Choose another slug, or remove that entry first.",
      );
    }
    await refuseCommittedName(slug, parent, false);
    say(`Attaching the existing child "${slug}" (${child.appId}).`);
    await attach(slug, parent);
    return child.appId;
  }

  // `get` fails for a slug the parent has no child for, but also for a stale
  // local entry, a login or a network failure: create only when the listing
  // confirms the child is absent.
  const children = await listChildren(parent);
  if (children.some((c) => c.childSlug === slug)) {
    fail(`'primitive --env ${parent} apps children get ${slug} --json' failed:`, ...cliOutput(got));
  }
  say(`Creating the child "${slug}" of "${parent}".`);
  const created = await capture(["--env", parent, "apps", "children", "create", slug, "--json"]);
  if (created.code === 0) return JSON.parse(created.stdout).appId;
  if (created.code === 2) {
    // Created on the server, not registered here.
    const doc = JSON.parse(created.stdout);
    await refuseCommittedName(slug, parent, true);
    await attach(slug, parent);
    return doc.appId;
  }
  fail(`'primitive --env ${parent} apps children create ${slug} --json' failed:`, ...cliOutput(created));
}

/**
 * Exits unless `--env <name>` resolves to the machine-local environment of
 * the child `appId`: nothing that writes may run against anything else.
 */
async function verifyIdentity(name, slug, appId, consequence) {
  const shown = await capture(["--env", name, "env", "show", "--json"]);
  let doc = null;
  try {
    doc = shown.code === 0 ? JSON.parse(shown.stdout) : null;
  } catch {
    doc = null;
  }
  if (doc && doc.local === true && doc.appId === appId) return;
  fail(
    `'--env ${name}' does not resolve to the child "${slug}" (${appId}): it resolved to ${
      doc ? `"${doc.name}" (${doc.appId}, ${doc.local === true ? "machine-local" : "committed"})` : "nothing"
    }.`,
    ...(doc ? [] : cliOutput(shown)),
    consequence,
  );
}

/**
 * Runs the app-owned hook `relative` when it exists. Returns whether it ran;
 * exits when it is not executable or fails.
 */
async function runHook(relative, env, onFailure) {
  const path = join(ROOT_DIR, relative);
  if (!existsSync(path)) return false;
  try {
    accessSync(path, constants.X_OK);
  } catch {
    fail(`${relative} exists but is not executable. Run 'chmod +x ${relative}', then run this again.`, onFailure);
  }
  say(`Running ${relative}...`);
  const code = await new Promise((resolvePromise, reject) => {
    const child = spawn(path, [], {
      stdio: "inherit",
      shell: false,
      cwd: ROOT_DIR,
      env: { ...process.env, ...env },
    });
    child.on("close", (exit) => resolvePromise(exit ?? 1));
    child.on("error", reject);
  });
  if (code !== 0) fail(`${relative} exited ${code}.`, onFailure);
  return true;
}

async function up({ slug, port }) {
  const { parent } = await resolveParent();
  const appId = await createOrAttach(slug, parent);
  await verifyIdentity(slug, slug, appId, "No hook ran and nothing was pushed.");

  // ---- App setup: scripts/child-app-init (see the header). ----
  const hookEnv = { PRIMITIVE_ENV: slug, CHILD_APP_ID: appId, CHILD_APP_SLUG: slug, PARENT_ENV: parent };
  const ranInit = await runHook(
    INIT_HOOK,
    hookEnv,
    `Nothing was pushed. The child "${slug}" exists; run 'pnpm child:up ${slug}' again to resume.`,
  );
  if (!ranInit) say(`There is no ${INIT_HOOK} hook; the child gets the tree as it is.`);

  const push = ["--env", slug, "config", "push", "--yes"];
  if ((await run(push)) !== 0) {
    fail(`'primitive ${push.join(" ")}' failed. Fix the problem above and run 'pnpm child:up ${slug}' again.`);
  }
  const origin = `http://localhost:${port}`;
  const allow = ["--env", slug, "apps", "children", "add-preview-origin", slug, origin, "--app-id", appId];
  if ((await run(allow)) !== 0) {
    fail(`'primitive ${allow.join(" ")}' failed. Run 'pnpm child:up ${slug} --port ${port}' again.`);
  }
  if ((await run(["env", "use", slug])) !== 0) {
    fail(`'primitive env use ${slug}' failed. Run it again to select the child.`);
  }

  say(
    `The child "${slug}" (${appId}) is ready and selected.`,
    ranInit ? `${INIT_HOOK} ran before the push.` : `No ${INIT_HOOK} hook ran.`,
    `Start the dev server against it: pnpm dev --port ${port}`,
    `Tear it down when the work ends: pnpm child:down ${slug}`,
  );
  if (process.env.PRIMITIVE_ENV) {
    say(
      `PRIMITIVE_ENV=${process.env.PRIMITIVE_ENV} is exported in this shell and outranks the selection just written; unset it to use "${slug}".`,
    );
  }
}

async function down({ slug, skipTeardown }) {
  const { parent } = await resolveParent();
  const child = await json(["--env", parent, "apps", "children", "get", slug]);

  if (skipTeardown) {
    say(
      `Skipping ${TEARDOWN_HOOK}: anything "${slug}" created outside the platform is left behind for you to remove.`,
    );
  } else {
    if (!child.local) {
      fail(
        ...(child.localConflict
          ? [
              `The local environment "${slug}" holds a different app, ${child.localConflict.appId}, not the child "${slug}" (${child.appId}).`,
            ]
          : [
              `The child "${slug}" (${child.appId}) is not registered on this machine, so its teardown hook cannot run against it.`,
              `Run 'primitive env use ${slug}' to attach it, then run this again.`,
            ]),
        `'pnpm child:down ${slug} --skip-teardown' deletes it without the hook. Nothing was deleted.`,
      );
    }
    const localName = child.localName;
    await verifyIdentity(localName, slug, child.appId, "Nothing was deleted.");

    // ---- App teardown: scripts/child-app-teardown (see the header). ----
    const ran = await runHook(
      TEARDOWN_HOOK,
      { PRIMITIVE_ENV: localName, CHILD_APP_ID: child.appId, CHILD_APP_SLUG: slug, PARENT_ENV: parent },
      `The child "${slug}" is kept; nothing was deleted.`,
    );
    if (!ran) say(`There is no ${TEARDOWN_HOOK} hook; nothing outside the platform is cleaned up.`);
  }

  // The parent was resolved before the hook ran: a hook that changed the
  // selection cannot redirect the delete to another parent's child.
  const remove = ["--env", parent, "apps", "children", "delete", slug, "--yes"];
  if ((await run(remove)) !== 0) fail(`'primitive ${remove.join(" ")}' failed.`);
  say(`Deleted the child "${slug}" (${child.appId}).`);
  if (child.selected) say(`"${slug}" was selected; run 'primitive env use ${parent}' to select its parent.`);
}

const args = parseArgs(process.argv.slice(2));
(args.verb === "up" ? up(args) : down(args)).catch((error) => {
  console.error("[child-app] Unexpected error:", error);
  process.exit(1);
});
