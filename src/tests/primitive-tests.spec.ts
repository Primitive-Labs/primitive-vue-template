/**
 * Vitest entry point for the Primitive test harness.
 *
 * Registers every `*.primitive-test.ts` group in this directory as vitest
 * tests — the same groups the in-browser dev-tools Test Harness panel runs —
 * so `pnpm test` can gate CI without a browser.
 *
 * Prerequisites (see README "Running harness tests headlessly"):
 *   - PRIMITIVE_TEST_EMAIL set to a +primitivetest derivative of a base on
 *     the app's testAccountBaseEmails whitelist — the bare base itself is
 *     never a test account and always fails sign-in.
 *   - `ws` installed (WebSocket implementation for Node).
 */
import { registerPrimitiveTests } from "primitive-app/testing";

import { allModels } from "@/models";

await registerPrimitiveTests({
  models: allModels,
  testModules: import.meta.glob("./**/*.primitive-test.ts"),
  appId: import.meta.env.VITE_APP_ID,
  apiUrl: import.meta.env.VITE_API_URL,
  wsUrl: import.meta.env.VITE_WS_URL,
});
