#!/usr/bin/env node
/**
 * Build and deploy this app to Cloudflare Workers.
 *
 * Usage:
 *   pnpm cf-deploy --deploy-env <name> --primitive-env <name> [--check] [-- wrangler args...]
 *
 * TWO INDEPENDENT AXES, neither of which defaults:
 *
 *   --deploy-env <name>     WHICH FRONT END. The Vite mode (`--mode <name>`,
 *                           so `.env.<name>` applies) and the Wrangler
 *                           environment (`[env.<name>]` in wrangler.toml).
 *
 *   --primitive-env <name>  WHICH BACKEND / APP. A key in
 *                           `.primitive/config.json`, supplying apiUrl,
 *                           appId and appName.
 *
 * They cross in practice — a production front end against the alpha backend, a
 * customer whose dev and prod builds both hit primitiveapi.com with different
 * app IDs — so neither is inferred from the other, and omitting either is an
 * error. Say "deploy environment" or "Primitive environment"; a bare
 * "environment" is ambiguous here.
 *
 * Examples:
 *   pnpm cf-deploy --deploy-env production --primitive-env prod
 *   pnpm cf-deploy --deploy-env production --primitive-env alpha
 *   pnpm cf-deploy --deploy-env production --primitive-env prod --check
 *   pnpm cf-deploy --deploy-env production --primitive-env prod -- --dry-run
 *
 * `.primitive/config.json` is the ONLY place the backend URL and app ID are
 * typed. This script reads them from there and passes them to the worker as
 * `--var APP_ID` / `--var API_ORIGIN`; the build gets `PRIMITIVE_ENV` so the
 * `primitiveEnv()` Vite plugin resolves the same environment. An identity key
 * (`VITE_APP_ID`, `VITE_API_URL`, `VITE_WS_URL`, `VITE_APP_NAME`) in a `.env`
 * file or the shell is a hard error rather than a silent second source.
 *
 * Node builtins only, and every spawn is an argv array with `shell: false`.
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = resolve(__dirname, "..");

/** Schema version of `.primitive/config.json` this script understands. */
const CONFIG_VERSION = 1;

/** Keys the `primitiveEnv()` plugin owns. Authoring one here is the old way. */
const IDENTITY_KEYS = ["VITE_APP_ID", "VITE_API_URL", "VITE_WS_URL", "VITE_APP_NAME"];

const USAGE = `Usage: pnpm cf-deploy --deploy-env <name> --primitive-env <name> [--check] [-- wrangler args...]

  --deploy-env <name>     Which front end: the Vite mode and the wrangler.toml
                          [env.<name>] section. e.g. production
  --primitive-env <name>  Which backend/app: an environment in
                          .primitive/config.json. e.g. prod, alpha
  --check                 Print the resolved pair and the exact commands, then exit.

Both are required — neither is inferred from the other.

  pnpm cf-deploy --deploy-env production --primitive-env prod`;

function fail(...lines) {
  for (const line of lines) console.error(`[deploy] ${line}`);
  process.exit(1);
}

function parseArgs(argv) {
  const parsed = {
    deployEnv: null,
    primitiveEnv: null,
    check: false,
    positional: null,
    passthrough: [],
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") {
      parsed.passthrough.push(...argv.slice(i + 1));
      break;
    }
    if (arg === "--deploy-env") {
      parsed.deployEnv = argv[++i] ?? null;
    } else if (arg.startsWith("--deploy-env=")) {
      parsed.deployEnv = arg.slice("--deploy-env=".length);
    } else if (arg === "--primitive-env") {
      parsed.primitiveEnv = argv[++i] ?? null;
    } else if (arg.startsWith("--primitive-env=")) {
      parsed.primitiveEnv = arg.slice("--primitive-env=".length);
    } else if (arg === "--check" || arg === "--dry-run-plan") {
      parsed.check = true;
    } else if (!arg.startsWith("-") && parsed.positional === null) {
      parsed.positional = arg;
    } else {
      // Anything else before `--` is an unknown flag. There is deliberately no
      // escape hatch here (notably none for the identity check below), so an
      // unrecognized flag is a mistake worth naming.
      fail(`Unknown option: ${arg}`, "", USAGE);
    }
  }

  return parsed;
}

/** Finds `.primitive/config.json`, honoring the PRIMITIVE_PROJECT_CONFIG override. */
function findProjectConfigPath() {
  const override = process.env.PRIMITIVE_PROJECT_CONFIG;
  if (override) {
    const forced = resolve(override);
    return existsSync(forced) ? forced : null;
  }
  let current = ROOT_DIR;
  for (;;) {
    const candidate = join(current, ".primitive", "config.json");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/** Reads the environment identity for `name`, failing loudly on anything odd. */
function readPrimitiveEnvironment(name) {
  const configPath = findProjectConfigPath();
  if (!configPath) {
    fail(
      "No .primitive/config.json found for this project.",
      "It is the single source of truth for the backend URL and app ID.",
      "Run 'primitive init' to create one, or 'primitive env add <name> --api-url ... --app-id ...'.",
    );
  }

  let config;
  try {
    config = JSON.parse(readFileSync(configPath, "utf-8"));
  } catch (err) {
    fail(`Could not parse ${configPath}: ${err.message}`);
  }

  if (config?.version !== CONFIG_VERSION) {
    fail(
      `${configPath} has version ${config?.version}, but this script understands version ${CONFIG_VERSION}.`,
      "Upgrade the Primitive CLI and this template together.",
    );
  }
  if (!config.environments || typeof config.environments !== "object") {
    fail(`${configPath} has no "environments" object.`);
  }

  const entry = config.environments[name];
  if (!entry) {
    const available = Object.keys(config.environments).join(", ") || "(none)";
    fail(
      `Primitive environment "${name}" is not defined in ${configPath}.`,
      `Available: ${available}`,
    );
  }
  if (typeof entry.apiUrl !== "string" || !entry.apiUrl) {
    fail(`Primitive environment "${name}" has no "apiUrl" in ${configPath}.`);
  }
  // Typed, not merely present: the schema says these are strings, and the
  // resolver the build uses treats anything else as absent. A number or object
  // here would otherwise reach wrangler as `--var APP_ID:[object Object]`.
  if (typeof entry.appId !== "string" || !entry.appId) {
    fail(
      `Primitive environment "${name}" has no "appId" string in ${configPath}, and a deploy needs one.`,
      `Add it with: primitive env add ${name} --api-url ${entry.apiUrl} --app-id <id>`,
    );
  }

  return {
    name,
    apiUrl: entry.apiUrl.replace(/\/$/, ""),
    appId: entry.appId,
    appName: typeof entry.appName === "string" ? entry.appName : undefined,
    configPath,
  };
}

/** Minimal `.env` reader — same rules the primitiveEnv() plugin applies. */
function parseEnvFile(path) {
  if (!existsSync(path)) return {};
  const out = {};
  for (const line of readFileSync(path, "utf-8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, "").trim();
    }
    out[match[1]] = value;
  }
  return out;
}

/**
 * A deploy is strict about identity: the build must take it from
 * `.primitive/config.json`, and the worker vars below come from the same
 * place. An identity key anywhere the build would see it means the two could
 * disagree, so it stops the deploy. There is no override flag — remove the
 * key. (This is also the migration step for an app scaffolded by an older CLI,
 * which appended these keys to `.env`.)
 */
function assertNoIdentityOverrides(deployEnv) {
  const found = [];

  for (const key of IDENTITY_KEYS) {
    if (process.env[key] !== undefined && process.env[key] !== "") {
      found.push({ key, where: "the process environment" });
    }
  }

  for (const file of [".env", ".env.local", `.env.${deployEnv}`, `.env.${deployEnv}.local`]) {
    const vars = parseEnvFile(join(ROOT_DIR, file));
    for (const key of IDENTITY_KEYS) {
      if (vars[key] !== undefined) found.push({ key, where: file });
    }
  }

  if (found.length === 0) return;

  fail(
    "Identity keys must not be set for a deploy — they would compete with .primitive/config.json:",
    ...found.map(({ key, where }) => `  ${key} (in ${where})`),
    "",
    "Remove them. The backend URL and app ID are typed once, in .primitive/config.json,",
    "and reach the build through the primitiveEnv() Vite plugin. If this app was",
    "scaffolded by an older CLI, deleting these lines from your .env files is the",
    "whole migration.",
  );
}

/**
 * Every spelling of Wrangler's environment flag. Wrangler parses with yargs,
 * which accepts `-e alpha`, `-e=alpha` and `-ealpha` for the short form and
 * `--env alpha` / `--env=alpha` for the long one — and a later occurrence wins
 * over the `--env` this script passes. Matching only the exact tokens would
 * let `-e=alpha` through and deploy somewhere other than the environment the
 * run just printed, so every spelling of the flag itself is rejected. Longer
 * flags that merely begin with `--env` (`--env-file`) are left alone.
 */
const WRANGLER_ENV_FLAG = /^(--env(=.*)?|-e(=.*|.+)?)$/;

/** Rejects passthrough args that would take over what this script decides. */
function assertPassthroughIsSafe(passthrough) {
  for (let i = 0; i < passthrough.length; i++) {
    const arg = passthrough[i];
    if (WRANGLER_ENV_FLAG.test(arg)) {
      fail(
        `Passthrough argument "${arg}" would re-point the Wrangler environment.`,
        "Use --deploy-env, which sets both the Vite mode and the Wrangler environment.",
      );
    }
    const varValue = arg === "--var" ? passthrough[i + 1] : arg.startsWith("--var=") ? arg.slice("--var=".length) : null;
    if (varValue && /^(APP_ID|API_ORIGIN)[:=]/.test(varValue)) {
      fail(
        `Passthrough argument "--var ${varValue}" would override the identity this deploy resolved.`,
        "APP_ID and API_ORIGIN come from the Primitive environment; other --var flags pass through.",
      );
    }
  }
}

function runCommand(command, args, extraEnv = {}) {
  return new Promise((resolvePromise, reject) => {
    console.log(`\n> ${command} ${args.join(" ")}\n`);
    const child = spawn(command, args, {
      stdio: "inherit",
      shell: false,
      cwd: ROOT_DIR,
      env: { ...process.env, ...extraEnv },
    });
    child.on("close", (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`Command failed with exit code ${code}`));
    });
    child.on("error", reject);
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.positional !== null) {
    if (args.deployEnv !== null && args.deployEnv !== args.positional) {
      fail(
        `Conflicting deploy environments: "${args.positional}" (positional) and "${args.deployEnv}" (--deploy-env).`,
        "",
        USAGE,
      );
    }
    console.warn(
      `[deploy] Deprecated: the bare "${args.positional}" argument now means ` +
        `--deploy-env ${args.positional}. Pass it explicitly; it used to select the ` +
        `Primitive environment too, which is now --primitive-env.`,
    );
    args.deployEnv = args.positional;
  }

  if (!args.deployEnv || !args.primitiveEnv) {
    const missing = [
      !args.deployEnv ? "--deploy-env" : null,
      !args.primitiveEnv ? "--primitive-env" : null,
    ].filter(Boolean);
    fail(`Missing required option(s): ${missing.join(", ")}`, "", USAGE);
  }

  assertPassthroughIsSafe(args.passthrough);
  assertNoIdentityOverrides(args.deployEnv);

  const env = readPrimitiveEnvironment(args.primitiveEnv);

  const buildArgs = ["build-only", "--mode", args.deployEnv];
  const buildEnv = { PRIMITIVE_ENV: env.name };
  const wranglerArgs = [
    "dlx",
    "wrangler",
    "deploy",
    "--env",
    args.deployEnv,
    "--var",
    `APP_ID:${env.appId}`,
    "--var",
    `API_ORIGIN:${env.apiUrl}`,
    ...args.passthrough,
  ];

  console.log("");
  console.log(`[deploy] Deploy environment:    ${args.deployEnv}  (Vite mode + wrangler [env.${args.deployEnv}])`);
  console.log(`[deploy] Primitive environment: ${env.name}`);
  console.log(`[deploy]   apiUrl:  ${env.apiUrl}`);
  console.log(`[deploy]   appId:   ${env.appId}`);
  console.log(`[deploy]   appName: ${env.appName ?? "(unset)"}`);
  console.log(`[deploy]   config:  ${env.configPath}`);
  console.log("");

  if (args.check) {
    console.log("[deploy] --check: nothing will be built or deployed.");
    console.log(`[deploy] build:    pnpm ${buildArgs.join(" ")}`);
    console.log(`[deploy] build env: PRIMITIVE_ENV=${buildEnv.PRIMITIVE_ENV}`);
    console.log(`[deploy] deploy:   pnpm ${wranglerArgs.join(" ")}`);
    return;
  }

  console.log(`[deploy] Building for deploy environment "${args.deployEnv}"...`);
  try {
    await runCommand("pnpm", buildArgs, buildEnv);
  } catch (error) {
    fail(`Build failed: ${error.message}`);
  }

  console.log("\n[deploy] Deploying to Cloudflare Workers...");
  try {
    await runCommand("pnpm", wranglerArgs);
  } catch (error) {
    fail(`Deploy failed: ${error.message}`);
  }

  console.log("\n[deploy] Deployment complete!");
}

main().catch((error) => {
  console.error("[deploy] Unexpected error:", error);
  process.exit(1);
});
