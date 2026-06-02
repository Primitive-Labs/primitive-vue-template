// Environment and js-bao configuration for the template app
import { allModels } from "@/models";
import type { JsBaoClientOptions } from "js-bao-wss-client";
import type { LogLevel } from "@/lib/logger";

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
 * The result is always absolute, so every consumer (js-bao client, router
 * callback-path derivation, magic-link builder) can rely on it being a full
 * URL. This is the single place the app resolves the redirect URI — read it
 * via `config.oauthRedirectUri` everywhere else.
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

// Raw environment-derived config shared between router, js-bao, and logging
export const config = {
  appName: import.meta.env.VITE_APP_NAME ?? "Primitive Template App",
  appId: import.meta.env.VITE_APP_ID,
  apiUrl: import.meta.env.VITE_API_URL,
  wsUrl: import.meta.env.VITE_WS_URL,
  oauthRedirectUri: resolveOauthRedirectUri(),
  enableAuthProxy: import.meta.env.VITE_ENABLE_AUTH_PROXY === "true",
  logLevel: import.meta.env.VITE_LOG_LEVEL,
};

function getRefreshProxyBaseUrl(): string {
  return typeof window !== "undefined"
    ? `${window.location.origin}/proxy`
    : "/proxy";
}

export function getJsBaoConfig(): JsBaoClientOptions {
  const auth = {
    persistJwtInStorage: true,
    ...(config.enableAuthProxy
      ? {
          refreshProxy: {
            baseUrl: getRefreshProxyBaseUrl(),
          },
        }
      : {}),
  };

  return {
    appId: config.appId,
    apiUrl: config.apiUrl,
    wsUrl: config.wsUrl,
    oauthRedirectUri: config.oauthRedirectUri,
    auth,
    models: allModels,
  } as JsBaoClientOptions;
}

const VALID_LOG_LEVELS: LogLevel[] = ["debug", "info", "warn", "error", "none"];

/**
 * Returns the desired log level for the template app.
 *
 * This is the only place the template reads VITE_LOG_LEVEL. Consumers should
 * call `getLogLevel` and pass the function into
 * `createPrimitiveApp({ getLogLevel })` and any app-created loggers.
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
const requiredVars = ["appId", "apiUrl", "wsUrl"] as const;
const missingVars = requiredVars.filter(
  (key) => !config[key as (typeof requiredVars)[number]]
);

if (missingVars.length > 0) {
  console.error("Missing required environment variables:", missingVars);

  console.error(
    "Please check your .env file and ensure all VITE_ prefixed variables are set"
  );
}
