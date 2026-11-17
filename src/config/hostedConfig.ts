/**
 * @module hostedConfig
 *
 * Hosted mode: where a hosted build (`pnpm build:hosted`, Vite mode `hosted`)
 * gets its identity. The build holds no app id, API URL or WebSocket URL.
 * Primitive hosting serves them on the app's own origin at
 * `/__primitive/config.json`, beside the sign-in proxy at `/__primitive`, and
 * the app reads them once at start-up:
 *
 * ```ts
 * const hosted = await loadHostedConfig();
 * // { appId, apiUrl, wsUrl, authProxyBaseUrl }
 * ```
 *
 * The answer is checked here, once, so the rest of the start-up can trust it.
 * Anything else (an SPA fallback's HTML, a 404, a wrong shape) is a
 * `HostedConfigError` whose message names the two ways forward.
 *
 * Kept free of `@/` imports and `import.meta.env` so tests outside the
 * template can load it.
 */

/** Where Primitive hosting serves the app's identity, on the page's own origin. */
export const HOSTED_CONFIG_PATH = "/__primitive/config.json";

/** The identity a hosted origin serves at `HOSTED_CONFIG_PATH`. */
export interface HostedConfig {
  /** The app's id. */
  appId: string;
  /** The API's base URL (`http:` or `https:`). */
  apiUrl: string;
  /** The WebSocket server's URL (`ws:` or `wss:`). */
  wsUrl: string;
  /** The sign-in proxy's absolute base URL, `<origin>/__primitive`. */
  authProxyBaseUrl: string;
}

/** The fields of a `HostedConfig`, in the order they are checked. */
type HostedConfigField = keyof HostedConfig;

/** What to do about a hosted build that cannot start. */
const WAYS_FORWARD =
  "Publish this build to Primitive hosting with `primitive hosting deploy dist`, " +
  "or build with `pnpm build` to host it yourself.";

/** Why a hosted build cannot start: the origin did not answer a valid config. */
export class HostedConfigError extends Error {
  /** The short reason, for the console line. Never holds the response body. */
  readonly reason: string;
  /** The config field that was wrong, when the answer had the wrong shape. */
  readonly field?: HostedConfigField;

  constructor(reason: string, field?: HostedConfigField) {
    super(
      `This is a hosted build: it reads its app from ${HOSTED_CONFIG_PATH}, ` +
        `and ${reason}. ${WAYS_FORWARD}`
    );
    this.name = "HostedConfigError";
    this.reason = reason;
    this.field = field;
  }
}

/** Whether `value` parses as an absolute URL with one of `protocols`. */
function isUrlWith(value: string, protocols: readonly string[]): boolean {
  try {
    return protocols.includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

const URL_RULES: Record<HostedConfigField, readonly string[] | null> = {
  appId: null,
  apiUrl: ["http:", "https:"],
  wsUrl: ["ws:", "wss:"],
  authProxyBaseUrl: ["http:", "https:"],
};

const URL_KINDS: Record<HostedConfigField, string> = {
  appId: "",
  apiUrl: "an http(s) URL",
  wsUrl: "a ws(s) URL",
  authProxyBaseUrl: "an absolute http(s) URL",
};

/**
 * Checks a parsed `config.json` and returns its four fields. Unknown keys are
 * ignored. Throws a `HostedConfigError` naming the first bad field.
 */
export function parseHostedConfig(value: unknown): HostedConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HostedConfigError("its answer is not a JSON object");
  }
  const record = value as Record<string, unknown>;
  const out = {} as HostedConfig;
  for (const field of Object.keys(URL_RULES) as HostedConfigField[]) {
    const raw = record[field];
    if (typeof raw !== "string" || raw.trim() === "") {
      throw new HostedConfigError(`its answer has no "${field}" string`, field);
    }
    const protocols = URL_RULES[field];
    if (protocols && !isUrlWith(raw, protocols)) {
      throw new HostedConfigError(
        `its "${field}" is not ${URL_KINDS[field]}`,
        field
      );
    }
    out[field] = raw;
  }
  return out;
}

/** The parts of the `config.json` response that decide whether it is usable. */
export interface HostedConfigAnswer {
  /** The HTTP status. */
  status: number;
  /** The `Content-Type` header, or null when there was none. */
  contentType: string | null;
  /** The body as text. */
  body: string;
}

/**
 * Reads the `config.json` response: a status other than 200, a body that is
 * not JSON (an SPA fallback's `index.html`) and JSON of the wrong shape each
 * give a `HostedConfigError` with its own reason. The body is never quoted.
 */
export function readHostedConfigAnswer(
  answer: HostedConfigAnswer
): HostedConfig {
  if (answer.status !== 200) {
    throw new HostedConfigError(`the request answered HTTP ${answer.status}`);
  }
  const notHosted =
    "this origin is not a Primitive hosted origin (the answer is not JSON)";
  if (answer.contentType && /html/i.test(answer.contentType)) {
    throw new HostedConfigError(notHosted);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(answer.body);
  } catch {
    throw new HostedConfigError(notHosted);
  }
  return parseHostedConfig(parsed);
}

/**
 * Fetches and checks the origin's identity: one uncached request to
 * `HOSTED_CONFIG_PATH`, an absolute path, so a deep link reads the same file.
 */
export async function loadHostedConfig(): Promise<HostedConfig> {
  let response: Response;
  try {
    response = await fetch(HOSTED_CONFIG_PATH, {
      cache: "no-store",
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    });
  } catch {
    throw new HostedConfigError("the request failed");
  }
  return readHostedConfigAnswer({
    status: response.status,
    contentType: response.headers.get("content-type"),
    body: await response.text(),
  });
}

/** The client's `auth.refreshProxy` option, or undefined for none. */
export type RefreshProxyOption =
  { baseUrl: string; passkey?: boolean } | undefined;

/**
 * The refresh proxy each build hands the client. A hosted build uses the
 * origin's sign-in proxy, as given, with passkey finish calls through it;
 * `enableAuthProxy` does not apply. Any other build uses the self-hosted
 * Worker's `<origin>/proxy` when `enableAuthProxy` is on, and none otherwise.
 */
export function refreshProxyOption(options: {
  hosted: HostedConfig | null;
  enableAuthProxy: boolean;
  pageOrigin: string;
}): RefreshProxyOption {
  if (options.hosted) {
    return { baseUrl: options.hosted.authProxyBaseUrl, passkey: true };
  }
  if (options.enableAuthProxy) {
    return { baseUrl: `${options.pageOrigin}/proxy` };
  }
  return undefined;
}

/** The text a hosted build shows when it cannot start. */
export function hostedFailureMessage(error: unknown): string {
  if (error instanceof HostedConfigError) return error.message;
  return new HostedConfigError("reading it failed").message;
}
