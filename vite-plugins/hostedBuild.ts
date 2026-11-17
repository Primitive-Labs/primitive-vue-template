import { existsSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

import type { Plugin } from "vite";

/** The Vite mode of `pnpm build:hosted`. */
export const HOSTED_MODE = "hosted";

/** What a hosted build prints once, so the build output says where identity comes from. */
export const HOSTED_BUILD_LINE =
  "[primitive] hosted build: app identity is read from /__primitive/config.json at start-up";

/**
 * The identity keys a hosted build never carries. They are defined empty, so
 * a value in a `.env` file or the shell cannot reach the bundle.
 */
export const HOSTED_EMPTY_IDENTITY: Record<string, string> = {
  "import.meta.env.VITE_APP_ID": '""',
  "import.meta.env.VITE_API_URL": '""',
  "import.meta.env.VITE_WS_URL": '""',
};

/**
 * Root files another host reads as configuration. Primitive hosting refuses a
 * deployment that carries one (`platform_file_not_supported`); the names are
 * the hosting service's `PLATFORM_FILES`.
 */
export const HOSTED_PLATFORM_FILES: readonly string[] = [
  "_headers",
  "_redirects",
];

/**
 * Leave the platform files out of a hosted build's output.
 *
 * `public/_headers` sets headers for the self-hosted Worker and ships with
 * every other build. Primitive hosting sets headers and routing itself and
 * refuses a deployment that carries the file, so a hosted build removes it
 * (and `_redirects`, if present) from the output once it is written, naming
 * each file it removed, and `primitive hosting deploy dist` takes the whole
 * directory as built.
 */
export function hostedBuild(): Plugin {
  let outDir = "";
  return {
    name: "primitive-hosted-build",
    apply: "build",
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    closeBundle() {
      for (const name of HOSTED_PLATFORM_FILES) {
        const file = join(outDir, name);
        if (!existsSync(file)) continue;
        rmSync(file);
        console.log(
          `[primitive] hosted build: left out ${name} (Primitive hosting sets headers and routing itself)`
        );
      }
    },
  };
}
