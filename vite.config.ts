import { fileURLToPath, URL } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import vue from "@vitejs/plugin-vue";
import vueJsx from "@vitejs/plugin-vue-jsx";
import { primitiveDevTools } from "primitive-app/vite";
import { defineConfig, loadEnv } from "vite";
import vueDevTools from "vite-plugin-vue-devtools";

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "VITE_");
  const appName = env.VITE_APP_NAME || "Primitive Template App";

  return {
    plugins: [
      vue(),
      vueJsx(),
      vueDevTools(),
      tailwindcss(),
      primitiveDevTools({
        appName,
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
