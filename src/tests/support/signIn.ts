/// <reference types="node" />
/**
 * Sign the test account in from a `pnpm test` run.
 *
 * `signIn()` starts the app's client (`@/lib/client`) for the app this build
 * resolved (the `VITE_*` identity the `primitiveEnv()` plugin fills in from
 * `primitive/config.json`) and signs in `PRIMITIVE_TEST_EMAIL` with the fixed
 * code `000000`, so code under `src/lib/` that awaits `getAppClient()` runs
 * as the test user. That
 * address must be a `+primitivetest` derivative of a base the app lists in
 * `testAccountBaseEmails` (e.g. `you+primitivetest@example.com` for
 * `you@example.com`): no email is sent.
 *
 * ```ts
 * const { client, email } = await signIn();
 * // ... use client, or anything that awaits getAppClient() ...
 * await signOut(client);
 * ```
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { JsBaoClient } from "js-bao-wss-client";
import {
  disconnectAppClient,
  getAppClient,
  initializeAppClient,
} from "@/lib/client";
import { allModels } from "@/models";

/** The code the test bypass accepts for a whitelisted `+primitivetest` address. */
export const TEST_SIGN_IN_CODE = "000000";

/**
 * The sql.js engine, loaded from the wasm the app serves. Throws when the
 * wasm is missing: a client with no engine signs in and subscribes, then
 * fails its first db3 save far from the cause.
 */
function databaseConfig() {
  const wasmPath = resolve(process.cwd(), "public/sql-wasm.wasm");
  if (!existsSync(wasmPath)) {
    throw new Error(
      "public/sql-wasm.wasm is missing, so the test client would have no database " +
        "engine. Run the tests through `pnpm test`, whose codegen copies it (or run " +
        "`pnpm codegen` once before `pnpm exec vitest`)."
    );
  }
  return { type: "sqljs" as const, options: { locateFile: () => wasmPath } };
}

/**
 * Sign the test account in as the app's client, and return that client and
 * the address it signed in as. An app client already running is replaced.
 */
export async function signIn(): Promise<{
  client: JsBaoClient;
  email: string;
}> {
  const email = process.env.PRIMITIVE_TEST_EMAIL?.trim();
  if (!email) {
    throw new Error(
      "PRIMITIVE_TEST_EMAIL is not set: export a +primitivetest address whose base " +
        "is in the app's testAccountBaseEmails (see the README's test setup)."
    );
  }
  const database = databaseConfig();
  await disconnectAppClient();
  initializeAppClient({
    appId: import.meta.env.VITE_APP_ID,
    apiUrl: import.meta.env.VITE_API_URL,
    wsUrl: import.meta.env.VITE_WS_URL,
    // The tests need no persisted session, and the in-memory store needs no
    // native module (the app's install does not build better-sqlite3).
    storageConfig: { type: "memory" },
    databaseConfig: database,
    models: allModels,
  });
  const client = await getAppClient();
  try {
    await client.otpVerify(email, TEST_SIGN_IN_CODE);
  } catch (error) {
    await disconnectAppClient();
    throw new Error(
      `Signing in ${email} with the test code failed. Its base address must be in ` +
        "the app's testAccountBaseEmails (`primitive/<env>/app.toml`, then " +
        "`primitive config push`), and an invite-only app must have invited it. " +
        `Underlying error: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  return { client, email };
}

/**
 * Disconnect the app's client, and `client` when it is another one; the next
 * `signIn()` signs in a new app client.
 */
export async function signOut(client?: JsBaoClient): Promise<void> {
  await disconnectAppClient();
  // A no-op for the app client, which is already disconnected.
  if (client) await client.disconnect();
}
