import { fileURLToPath, URL } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import vue from "@vitejs/plugin-vue";
import vueJsx from "@vitejs/plugin-vue-jsx";
import { primitiveEnv } from "primitive-admin/vite";
import { defineConfig } from "vite";
import vueDevTools from "vite-plugin-vue-devtools";

import {
  HOSTED_BUILD_LINE,
  HOSTED_EMPTY_IDENTITY,
  HOSTED_MODE,
  hostedBuild,
} from "./vite-plugins/hostedBuild.ts";
import { sqlJsNodeBuiltins } from "./vite-plugins/sqlJsNodeBuiltins.ts";

// https://vite.dev/config/
export default defineConfig(({ command, mode }) => {
  // A hosted build (`pnpm build:hosted`) carries no app identity: it reads it
  // at start-up from /__primitive/config.json on the origin Primitive hosting
  // serves it from (src/config/hostedConfig.ts). So primitiveEnv() is not
  // registered, and the identity keys are defined empty.
  const hosted = mode === HOSTED_MODE;
  if (hosted && command === "build") console.log(HOSTED_BUILD_LINE);

  // The Primitive environment (backend URL + app ID) is resolved by this
  // plugin from primitive/config.json — the one place it is typed. Select it
  // with `primitive env use <name>`, or `--primitive-env` on a deploy.
  //
  // The resolution deliberately happens INSIDE the plugin, not at the top of
  // this file: an eager call here would throw before the plugin's escape hatch
  // (an app whose VITE_APP_ID / VITE_API_URL come straight from the
  // environment, e.g. in CI) could apply.
  return {
    plugins: [
      vue(),
      vueJsx(),
      vueDevTools(),
      tailwindcss(),
      ...(hosted ? [hostedBuild()] : [primitiveEnv()]),
      // sql.js (the in-browser database engine) requires fs, path and crypto
      // on its Node branch only; keep them out of the browser bundle.
      sqlJsNodeBuiltins(),
    ],
    ...(hosted ? { define: HOSTED_EMPTY_IDENTITY } : {}),
    build: {
      // The Primitive client + Vue runtime baseline is ~1.64 MB minified
      // (~463 kB gzip), so Vite's generic 500 kB chunk advisory always fires
      // on a fresh scaffold. Calibrate the threshold just above that baseline
      // — the advisory stays useful for real app-side bloat. As your app
      // grows, prefer code-splitting (dynamic import() per route) over
      // raising this further.
      chunkSizeWarningLimit: 1700,
    },
    resolve: {
      alias: {
        "@": fileURLToPath(new URL("./src", import.meta.url)),
        // In browser bundles the js-bao client uses native WebSocket; stub the
        // Node `ws` package out of the bundle. Under vitest the tests run in
        // Node and need the real `ws`, so skip the stub there.
        ...(process.env.VITEST
          ? {}
          : {
              ws: fileURLToPath(
                new URL("./src/ws-browser-stub.js", import.meta.url)
              ),
            }),
      },
    },
  };
});
