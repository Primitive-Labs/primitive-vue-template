import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import type { Plugin } from "vite";

/**
 * The versions the Primitive client accepts as `appVersion`: one to three
 * dot-separated parts of one to six digits each. The client refuses anything
 * else at start-up, so the build refuses it first.
 */
export const APP_VERSION_RULE = /^[0-9]{1,6}(\.[0-9]{1,6}){0,2}$/;

/** The file every build writes at the root of its output. */
export const VERSION_FILE = "version.json";

/**
 * The `version` of the `package.json` in `root`, or null when it has none.
 * Throws for a version the client would refuse, naming the value and the fix.
 */
export function readPackageVersion(root: string): string | null {
  const file = join(root, "package.json");
  const manifest = JSON.parse(readFileSync(file, "utf-8")) as {
    version?: unknown;
  };
  const version = manifest.version;
  if (version === undefined || version === null) return null;
  if (typeof version !== "string") {
    throw new Error(
      `The "version" in ${file} is ${JSON.stringify(version)}, not a string. ` +
        `Write it as a quoted string such as "1.4.2": change "version" in package.json.`
    );
  }
  if (!APP_VERSION_RULE.test(version)) {
    throw new Error(
      `The "version" in ${file} is ${JSON.stringify(version)}, which the Primitive client refuses. ` +
        `A version is one to three dot-separated numbers of up to six digits each, such as "1.4.2". ` +
        `Change "version" in package.json.`
    );
  }
  return version;
}

/** A new build id: the time in base 36, a hyphen and eight random hex characters. */
export function newBuildId(): string {
  return `${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
}

/** The body of `version.json`. */
export function versionFileBody(build: {
  version: string | null;
  buildId: string;
  builtAt: Date;
}): string {
  return (
    JSON.stringify(
      {
        version: build.version,
        buildId: build.buildId,
        builtAt: build.builtAt.toISOString(),
      },
      null,
      2
    ) + "\n"
  );
}

/**
 * Stamp the app's version into the client and write `version.json`.
 *
 * Reads `version` from the app's `package.json` and defines it as
 * `import.meta.env.VITE_APP_VERSION`, which `getJsBaoConfig()` passes to the
 * client as `appVersion`. A build also gets a fresh build id
 * (`import.meta.env.VITE_APP_BUILD_ID`) and writes `version.json` with the
 * version, the build id and the build time; the update banner compares the
 * page's build id with the one its origin serves. `vite` dev has an empty
 * build id and writes no file. A version the client would refuse stops Vite
 * before anything is bundled.
 */
export function appVersion(): Plugin {
  let version: string | null = null;
  let buildId = "";
  return {
    name: "app-version-stamp",
    config(config, { command }) {
      version = readPackageVersion(resolve(config.root ?? process.cwd()));
      buildId = command === "build" ? newBuildId() : "";
      return {
        define: {
          "import.meta.env.VITE_APP_VERSION": JSON.stringify(version ?? ""),
          "import.meta.env.VITE_APP_BUILD_ID": JSON.stringify(buildId),
        },
      };
    },
    generateBundle() {
      if (!buildId) return;
      this.emitFile({
        type: "asset",
        fileName: VERSION_FILE,
        source: versionFileBody({ version, buildId, builtAt: new Date() }),
      });
    },
  };
}
