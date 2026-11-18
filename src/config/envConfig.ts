// Environment and client configuration for the template app
import { allModels } from "@/models";
import type { JsBaoClientOptions } from "js-bao-wss-client";
import type { LogLevel } from "@/lib/logger";
import { APP_VERSION } from "@/lib/appUpdate";
import { getDatabaseConfig } from "./storage";
import {
  loadHostedConfig,
  refreshProxyOption,
  type HostedConfig,
} from "./hostedConfig";

/**
 * True in a hosted build (`pnpm build:hosted`, Vite mode `hosted`). Such a
 * build holds no app identity: `loadIdentity()` reads it from the origin.
 */
export const IS_HOSTED_BUILD = import.meta.env.MODE === "hosted";

/**
 * Path on the app's own origin that renders the OAuth / magic-link callback.
 * Must stay in sync with the callback route in router/routes.ts.
 */
const DEFAULT_OAUTH_CALLBACK_PATH = "/oauth/callback";

/**
 * Resolve the OAuth redirect URI to an absolute URL, defaulting to a path on
 * the origin the app is actually served from.
 *
 * OAuth providers and magic-link emails require an absolute callback URL, but
 * hard-coding the host/port is a footgun: run the app on a different port (or
 * domain) than VITE_OAUTH_REDIRECT_URI and the callback points at the wrong
 * place while the server's CORS / redirect-URI checks fail. So:
 *   - unset, or a relative path like "/oauth/callback" -> resolved against
 *     window.location.origin, so it always tracks where the app is served;
 *   - an absolute URL -> honored as-is (escape hatch for a fixed callback).
 *
 * The result is always absolute, so every consumer (the client, which builds
 * emailed links and OAuth redirects from it, and the router's callback-path
 * derivation) can rely on it being a full URL. This is the single place the
 * app resolves the redirect URI — read it via `config.oauthRedirectUri`
 * everywhere else.
 */
export function resolveOauthRedirectUri(): string {
  const configured = import.meta.env.VITE_OAUTH_REDIRECT_URI?.trim();
  const value = configured || DEFAULT_OAUTH_CALLBACK_PATH;
  const origin =
    typeof window !== "undefined" ? window.location.origin : undefined;
  try {
    // An absolute `value` ignores the base; a relative path resolves against it.
    return new URL(value, origin).toString();
  } catch {
    // No origin available (SSR/tests) with a relative value: return as-is.
    return value;
  }
}

// Raw environment-derived config shared between router, client, and logging.
// In a hosted build the identity fields start empty and `loadIdentity()`
// fills them from the origin before the client options are built.
export const config = {
  appName: import.meta.env.VITE_APP_NAME ?? "Primitive Template App",
  appId: IS_HOSTED_BUILD ? "" : import.meta.env.VITE_APP_ID,
  apiUrl: IS_HOSTED_BUILD ? "" : import.meta.env.VITE_API_URL,
  wsUrl: IS_HOSTED_BUILD ? "" : import.meta.env.VITE_WS_URL,
  oauthRedirectUri: resolveOauthRedirectUri(),
  enableAuthProxy: import.meta.env.VITE_ENABLE_AUTH_PROXY === "true",
  logLevel: import.meta.env.VITE_LOG_LEVEL,
  /** What the origin served at /__primitive/config.json, in a hosted build. */
  hosted: null as HostedConfig | null,
};

/**
 * Fill in the app's identity before the client is created. Every build but a
 * hosted one already has it, baked in by `primitiveEnv()`, and returns at
 * once. A hosted build fetches `/__primitive/config.json` from its own origin
 * and rejects with a `HostedConfigError` when the origin does not serve one.
 */
export async function loadIdentity(): Promise<void> {
  if (!IS_HOSTED_BUILD) return;
  const hosted = await loadHostedConfig();
  config.hosted = hosted;
  config.appId = hosted.appId;
  config.apiUrl = hosted.apiUrl;
  config.wsUrl = hosted.wsUrl;
}

/**
 * The client options `main.ts` hands `initializeAppClient`, once
 * `loadIdentity()` has run: the environment's identity, the callback URL, session storage and the refresh proxy, the log
 * level, the app's `package.json` version (`appVersion`), the generated models (`@/models`, rewritten by `pnpm codegen`
 * from `primitive/<env>/db3-types/`), and where db3s are kept on the device
 * (`./storage.ts`).
 */
export function getJsBaoConfig(): JsBaoClientOptions {
  // A hosted build signs in through the origin's proxy at /__primitive; any
  // other build through the self-hosted Worker's /proxy when enabled.
  const refreshProxy = refreshProxyOption({
    hosted: config.hosted,
    enableAuthProxy: config.enableAuthProxy,
    pageOrigin: typeof window !== "undefined" ? window.location.origin : "",
  });
  const auth = {
    persistJwtInStorage: true,
    ...(refreshProxy ? { refreshProxy } : {}),
  };

  return {
    appId: config.appId,
    apiUrl: config.apiUrl,
    wsUrl: config.wsUrl,
    oauthRedirectUri: config.oauthRedirectUri,
    auth,
    logLevel: getLogLevel(),
    models: allModels,
    databaseConfig: getDatabaseConfig(),
    // The app's package.json version, stamped in by vite-plugins/appVersion.ts;
    // undefined when package.json has none.
    ...(APP_VERSION ? { appVersion: APP_VERSION } : {}),
  };
}

const VALID_LOG_LEVELS: LogLevel[] = ["debug", "info", "warn", "error", "none"];

/**
 * Returns the desired log level for the template app.
 *
 * This is the only place the template reads VITE_LOG_LEVEL. The client
 * options and the app's loggers (`src/lib/logger.ts`) read it from here.
 *
 * This factory is called once during bootstrap and is not reactive.
 */
export function getLogLevel(): LogLevel {
  const raw = config.logLevel;
  if (!raw || typeof raw !== "string") return "warn";

  const normalized = raw.toLowerCase().trim() as LogLevel;
  return VALID_LOG_LEVELS.includes(normalized) ? normalized : "warn";
}

// Validate required configuration (dev aid). oauthRedirectUri is intentionally
// omitted — it always resolves to a value (defaulting to the running origin).
// A hosted build has no identity until `loadIdentity()` runs, so it is not
// checked here.
const requiredVars = ["appId", "apiUrl", "wsUrl"] as const;
const missingVars = IS_HOSTED_BUILD
  ? []
  : requiredVars.filter((key) => !config[key]);

if (missingVars.length > 0) {
  console.error("Missing required Primitive configuration:", missingVars);

  // These come from the selected Primitive environment in
  // primitive/config.json, filled in at build time by the primitiveEnv()
  // Vite plugin — not from a .env file.
  console.error(
    "appId / apiUrl / wsUrl come from primitive/config.json. Check that the " +
      "project has one and that an environment is selected: " +
      "`primitive env list`, then `primitive env use <name>`."
  );
}
