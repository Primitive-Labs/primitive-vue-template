/**
 * @module client
 *
 * The app's one `JsBaoClient`. `main.ts` calls `initializeAppClient` once at
 * startup with the options from `getJsBaoConfig()`; everything else awaits
 * `getAppClient()`, which creates the client on first use and returns the
 * same instance after that.
 *
 * ```ts
 * import { getAppClient } from "@/lib/client";
 *
 * const client = await getAppClient();
 * const profile = await client.me.get();
 * ```
 */
import {
  initializeClient,
  type JsBaoClient,
  type JsBaoClientOptions,
} from "js-bao-wss-client";
import { appBaseLogger } from "@/lib/logger";

const logger = appBaseLogger.forScope("client");

declare global {
  interface Window {
    /** The app's client, exposed on localhost only, for console debugging. */
    __primitiveAppClient?: JsBaoClient;
  }
}

let options: JsBaoClientOptions | null = null;
let clientPromise: Promise<JsBaoClient> | null = null;

/** True on a local development host, where the client may be exposed on `window`. */
function isLocalHost(): boolean {
  if (typeof window === "undefined") return false;
  const host = window.location.hostname;
  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "[::1]" ||
    host.endsWith(".localhost")
  );
}

/**
 * Store the client options. Call once, before anything awaits
 * `getAppClient()`. Missing identity fields are logged: they come from
 * `primitive/config.json` through the `primitiveEnv()` Vite plugin.
 */
export function initializeAppClient(clientOptions: JsBaoClientOptions): void {
  const missing = (["appId", "apiUrl", "wsUrl"] as const).filter(
    (key) => !clientOptions[key]
  );
  if (missing.length > 0) {
    logger.error(
      `Missing client configuration: ${missing.join(", ")}. These come from ` +
        "primitive/config.json through the primitiveEnv() Vite plugin: check " +
        "that the project has one and that an environment is selected " +
        "(`primitive env list`, then `primitive env use <name>`)."
    );
  }
  options = clientOptions;
}

/** The options `initializeAppClient` stored, or null before it ran. */
export function getAppClientOptions(): JsBaoClientOptions | null {
  return options;
}

/** The app's client, created on the first call. */
export function getAppClient(): Promise<JsBaoClient> {
  if (clientPromise) return clientPromise;
  if (!options) {
    return Promise.reject(
      new Error(
        "The client is not initialized: call initializeAppClient() first."
      )
    );
  }
  const clientOptions = options;
  clientPromise = initializeClient(clientOptions).then((client) => {
    client.on("error", (error) => logger.error("Client error:", error));
    if (isLocalHost()) window.__primitiveAppClient = client;
    return client;
  });
  // A failed start can be retried by the next caller.
  clientPromise.catch(() => {
    clientPromise = null;
  });
  return clientPromise;
}

/** Disconnect and forget the client; the next `getAppClient()` creates a new one. */
export async function disconnectAppClient(): Promise<void> {
  const pending = clientPromise;
  clientPromise = null;
  if (!pending) return;
  try {
    const client = await pending;
    await client.disconnect();
  } catch (error) {
    logger.warn("Disconnecting the client failed:", error);
  }
  if (isLocalHost()) delete window.__primitiveAppClient;
}
