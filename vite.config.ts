import { fileURLToPath, URL } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import vue from "@vitejs/plugin-vue";
import vueJsx from "@vitejs/plugin-vue-jsx";
import { primitiveDevTools, primitiveEnv } from "primitive-app/vite";
import { defineConfig } from "vite";
import vueDevTools from "vite-plugin-vue-devtools";

// https://vite.dev/config/
export default defineConfig(() => {
  // The Primitive environment (backend URL + app ID) is resolved by this
  // plugin from .primitive/config.json — the one place it is typed. Select it
  // with `primitive env use <name>`, or `--primitive-env` on a deploy.
  //
  // The resolution deliberately happens INSIDE the plugin, not at the top of
  // this file: an eager call here would throw before the plugin's escape hatch
  // (an app whose VITE_APP_ID / VITE_API_URL come straight from the
  // environment, e.g. in CI) could apply.
  const primitive = primitiveEnv();

  return {
    plugins: [
      vue(),
      vueJsx(),
      vueDevTools(),
      tailwindcss(),
      primitive,
      primitiveDevTools({
        // A thunk, so the label follows whatever the plugin resolved (or an
        // explicit VITE_APP_NAME override) rather than a value read too early.
        appName: () => primitive.appName() || "Primitive Template App",
        testsDir: "src/tests",
        keyboardShortcut: "cmd+shift+l",
      }),
    ],
    build: {
      // The Primitive client + Vue runtime baseline is ~1.1 MB minified
      // (~300 kB gzip), so Vite's generic 500 kB chunk advisory always fires
      // on a fresh scaffold. Calibrate the threshold just above that baseline
      // — the advisory stays useful for real app-side bloat. As your app
      // grows, prefer code-splitting (dynamic import() per route) over
      // raising this further.
      chunkSizeWarningLimit: 1200,
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
