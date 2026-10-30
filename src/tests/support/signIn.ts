/// <reference types="node" />
/**
 * Sign the test account in from a `pnpm test` run.
 *
 * `signIn()` builds a client for the app this build resolved (the `VITE_*`
 * identity the `primitiveEnv()` plugin fills in from `primitive/config.json`)
 * and signs in `PRIMITIVE_TEST_EMAIL` with the fixed code `000000`. That
 * address must be a `+primitivetest` derivative of a base the app lists in
 * `testAccountBaseEmails` (e.g. `you+primitivetest@example.com` for
 * `you@example.com`): no email is sent.
 *
 * ```ts
 * const { client, email } = await signIn();
 * // ... use client ...
 * await signOut(client);
 * ```
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { initializeClient, type JsBaoClient } from "js-bao-wss-client";
import { allModels } from "@/models";

/** The code the test bypass accepts for a whitelisted `+primitivetest` address. */
export const TEST_SIGN_IN_CODE = "000000";

/** The sql.js engine, loaded from the wasm the app serves, when it is there. */
function databaseConfig() {
  const wasmPath = resolve(process.cwd(), "public/sql-wasm.wasm");
  return existsSync(wasmPath)
    ? { type: "sqljs" as const, options: { locateFile: () => wasmPath } }
    : undefined;
}

/** A signed-in client for the test account, and the address it signed in as. */
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
  const client = await initializeClient({
    appId: import.meta.env.VITE_APP_ID,
    apiUrl: import.meta.env.VITE_API_URL,
    wsUrl: import.meta.env.VITE_WS_URL,
    // The tests need no persisted session, and the in-memory store needs no
    // native module (the app's install does not build better-sqlite3).
    storageConfig: { type: "memory" },
    databaseConfig: databaseConfig(),
    models: allModels,
  });
  try {
    await client.otpVerify(email, TEST_SIGN_IN_CODE);
  } catch (error) {
    await client.disconnect();
    throw new Error(
      `Signing in ${email} with the test code failed. Its base address must be in ` +
        "the app's testAccountBaseEmails (`primitive/<env>/app.toml`, then " +
        "`primitive config push`), and an invite-only app must have invited it. " +
        `Underlying error: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  return { client, email };
}

/** Disconnect a client `signIn()` returned. */
export async function signOut(client: JsBaoClient): Promise<void> {
  await client.disconnect();
}
