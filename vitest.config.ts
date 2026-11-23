import { defineConfig, mergeConfig } from "vitest/config";

import viteConfig from "./vite.config";

/**
 * `pnpm test` runs the `.spec.ts` files under `src/tests/` in Node against
 * the app's Primitive server, signed in as the test account
 * (`src/tests/support/signIn.ts`).
 * It merges the app's own Vite config so aliases, the type files the generated
 * models import, and generated code resolve exactly as they do in the browser.
 */
export default defineConfig((configEnv) =>
  mergeConfig(
    viteConfig(configEnv),
    defineConfig({
      resolve: {
        // The js-bao ORM keeps its state in statics on its BaseModel class;
        // ensure the app and the client share one copy of the client stack,
        // even when a package is linked.
        dedupe: ["js-bao", "js-bao-wss-client", "yjs"],
      },
      test: {
        environment: "node",
        include: ["src/tests/**/*.spec.ts"],
        server: {
          deps: {
            // js-bao-wss-client's dist uses extension-less relative imports,
            // which native Node ESM rejects — run it through Vite's resolver.
            inline: ["js-bao-wss-client"],
          },
        },
        // Tests hit the real Primitive server (sign-in, data, network sync),
        // so allow more time than vitest's 5s default.
        testTimeout: 60_000,
        hookTimeout: 120_000,
      },
    })
  )
);
