const PROXY_PREFIX = "/proxy";
// Supported proxy path prefixes - requests matching these are forwarded to the API
const PROXY_AUTH_PREFIX = `${PROXY_PREFIX}/auth/`;
const PROXY_OAUTH_PREFIX = `${PROXY_PREFIX}/oauth/`;

// Environment variable availability helper
const getEnvAvailability = (env) => ({
  VITE_API_URL: !!env.VITE_API_URL,
  VITE_WS_URL: !!env.VITE_WS_URL,
  VITE_APP_ID: !!env.VITE_APP_ID,
  VITE_OAUTH_REDIRECT_URI: !!env.VITE_OAUTH_REDIRECT_URI,
  VITE_PERF_ENABLED: !!env.VITE_PERF_ENABLED,
  VITE_ENVIRONMENT: !!env.VITE_ENVIRONMENT,
  VITE_USE_REFRESH_PROXY: !!env.VITE_USE_REFRESH_PROXY,
  VITE_REFRESH_PROXY_BASE_URL: !!env.VITE_REFRESH_PROXY_BASE_URL,
  VITE_REFRESH_PROXY_COOKIE_MAX_AGE: !!env.VITE_REFRESH_PROXY_COOKIE_MAX_AGE,
});

const toOrigin = (value) => {
  if (!value || typeof value !== "string") return null;
  try {
    const parsed = new URL(value);
    return parsed.origin;
  } catch {
    try {
      const parsed = new URL(value, "https://placeholder.example");
      return `${parsed.protocol}//${parsed.host}`;
    } catch {
      return null;
    }
  }
};

const ensureSingleLeadingSlash = (value) => {
  if (!value || typeof value !== "string") return "/";
  if (!value.startsWith("/")) {
    return ensureSingleLeadingSlash(`/${value}`);
  }
  while (value.startsWith("//")) {
    value = value.slice(1);
  }
  return value === "" ? "/" : value;
};

const parseCookies = (header) => {
  if (!header) return {};
  return header.split(/;\s*/).reduce((acc, item) => {
    const [name, ...rest] = item.split("=");
    if (!name) return acc;
    acc[name.trim()] = rest.join("=");
    return acc;
  }, {});
};

const getSetCookies = (headers) => {
  if (!headers) return [];
  if (typeof headers.getSetCookie === "function") {
    return headers.getSetCookie();
  }
  const value = headers.get("Set-Cookie");
  return value ? [value] : [];
};

const findCookieValue = (cookies, name) => {
  if (!cookies || !name) return null;
  const prefix = `${name}=`;
  for (const cookie of cookies) {
    if (!cookie) continue;
    const segments = cookie.split(";");
    for (const segment of segments) {
      const trimmed = segment.trim();
      if (trimmed.startsWith(prefix)) {
        return trimmed.substring(prefix.length);
      }
    }
  }
  return null;
};

// Logs name a request by origin and path only. The query string can carry an
// OAuth code or a magic-link token, and headers carry cookies and bearer
// tokens, so neither is ever written to the Worker's logs.
const describeUrlForLog = (value) => {
  try {
    const parsed = new URL(value);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return "[unparseable url]";
  }
};

const appendVary = (existing, value) => {
  if (!value) return existing || undefined;
  if (!existing) return value;
  const parts = existing.split(",").map((p) => p.trim().toLowerCase());
  if (parts.includes(value.toLowerCase())) {
    return existing;
  }
  return `${existing}, ${value}`;
};

const serializeCookie = ({
  name,
  value,
  maxAge,
  path,
  sameSite = "Lax",
  secure = true,
}) => {
  const parts = [`${name}=${value}`];
  parts.push("HttpOnly");
  if (secure) parts.push("Secure");
  if (sameSite) parts.push(`SameSite=${sameSite}`);
  if (path) parts.push(`Path=${path}`);
  if (typeof maxAge === "number") {
    parts.push(`Max-Age=${maxAge}`);
    if (maxAge === 0) {
      parts.push("Expires=Thu, 01 Jan 1970 00:00:00 GMT");
    }
  }
  return parts.join("; ");
};

const getProxyConfig = (env) => {
  const apiOrigin = toOrigin(env.API_ORIGIN || env.VITE_API_URL);
  const appId = env.APP_ID || env.VITE_APP_ID;
  const cookieName = appId ? `rt-${appId}` : null;
  const rawMaxAge = env.REFRESH_PROXY_COOKIE_MAX_AGE;
  const parsedMaxAge =
    typeof rawMaxAge === "string" ? Number.parseInt(rawMaxAge, 10) : NaN;
  const cookieMaxAge =
    Number.isFinite(parsedMaxAge) && parsedMaxAge > 0 ? parsedMaxAge : 604800; // 7 days default
  const cookiePath = ensureSingleLeadingSlash(
    env.REFRESH_PROXY_COOKIE_PATH || PROXY_PREFIX
  );

  return {
    apiOrigin,
    appId,
    cookieName,
    cookiePath,
    cookieMaxAge,
  };
};

const resolveCookieMaxAge = (request, defaultMaxAge) => {
  const header = request.headers.get("X-Refresh-Cookie-Max-Age");
  if (!header) return defaultMaxAge;
  const parsed = Number.parseInt(header, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return defaultMaxAge;
  return parsed;
};

const cloneUpstreamHeaders = (upstreamHeaders, omit = []) => {
  const headers = new Headers();
  const omitLower = omit.map((h) => h.toLowerCase());
  for (const [key, value] of upstreamHeaders) {
    if (omitLower.includes(key.toLowerCase())) continue;
    headers.set(key, value);
  }
  return headers;
};

const buildProxyResponse = async ({
  upstreamResponse,
  cookieName,
  cookiePath,
  cookieMaxAge,
  shouldExpire,
  request,
}) => {
  const body = await upstreamResponse.text();
  const headers = cloneUpstreamHeaders(upstreamResponse.headers, [
    "set-cookie",
  ]);

  const varyHeader = appendVary(upstreamResponse.headers.get("Vary"), "Cookie");
  if (varyHeader) headers.set("Vary", varyHeader);

  const setCookies = getSetCookies(upstreamResponse.headers);
  const refreshCookieValue = cookieName
    ? findCookieValue(setCookies, cookieName)
    : null;
  const maxAgeOverride = resolveCookieMaxAge(request, cookieMaxAge);
  const requestIsSecure = new URL(request.url).protocol === "https:";

  if (refreshCookieValue && cookieName) {
    headers.append(
      "Set-Cookie",
      serializeCookie({
        name: cookieName,
        value: refreshCookieValue,
        maxAge: maxAgeOverride,
        path: cookiePath,
        secure: requestIsSecure,
      })
    );
  } else if (cookieName && (shouldExpire || upstreamResponse.status === 401)) {
    headers.append(
      "Set-Cookie",
      serializeCookie({
        name: cookieName,
        value: "",
        maxAge: 0,
        path: cookiePath,
        secure: requestIsSecure,
      })
    );
  }

  const contentType = upstreamResponse.headers.get("content-type") || "";
  if (
    !headers.has("Cache-Control") &&
    contentType.includes("application/json")
  ) {
    headers.set("Cache-Control", "no-store");
  }

  return new Response(body, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers,
  });
};

const ensureOriginEndsWithSlash = (value) => {
  if (!value || typeof value !== "string") return "/";
  return value.endsWith("/") ? value : `${value}/`;
};

const buildUpstreamUrl = (origin, appId, path) => {
  const normalizedOrigin = ensureOriginEndsWithSlash(origin || "");
  const normalizedPath = path.startsWith("/") ? path.slice(1) : path;
  return `${normalizedOrigin}app/${appId}/api/${normalizedPath}`;
};

const forwardProxyRequest = async ({ request, url, headers }) => {
  const init = {
    method: request.method,
    headers,
    redirect: "manual",
  };

  if (!["GET", "HEAD"].includes(request.method.toUpperCase())) {
    init.body = request.body;
  }
  console.log("[WORKER][proxy] Forwarding request", {
    url: describeUrlForLog(url),
    method: request.method,
  });
  const response = await fetch(url, init);
  console.log("[WORKER][proxy] Upstream response", {
    url: describeUrlForLog(url),
    status: response.status,
  });
  return response;
};

/**
 * Generic proxy handler for auth and oauth endpoints.
 * Forwards requests to the upstream API and handles refresh token cookie management.
 */
const handleGenericProxy = async (request, env, config, url) => {
  const { cookieName, cookiePath, cookieMaxAge, apiOrigin, appId } = config;
  if (!apiOrigin || !appId || !cookieName) {
    return new Response("Proxy not configured", { status: 500 });
  }

  // Extract the path suffix after /proxy/
  // e.g., /proxy/auth/magic-link/verify → auth/magic-link/verify
  const proxyPath = url.pathname.substring(PROXY_PREFIX.length + 1);

  // Build upstream URL, preserving query params (critical for OAuth callback code/state)
  const upstreamUrl = new URL(buildUpstreamUrl(apiOrigin, appId, proxyPath));
  upstreamUrl.search = url.search;

  // Forward relevant headers
  const upstreamHeaders = new Headers();
  const forwardHeaders = ["content-type", "accept", "cookie", "authorization"];
  for (const [key, value] of request.headers) {
    if (forwardHeaders.includes(key.toLowerCase())) {
      upstreamHeaders.set(key, value);
    }
  }

  // Ensure we have Accept header for JSON responses
  if (!upstreamHeaders.has("Accept")) {
    upstreamHeaders.set("Accept", "application/json");
  }

  // For POST requests without Content-Type, default to JSON
  if (request.method === "POST" && !upstreamHeaders.has("Content-Type")) {
    upstreamHeaders.set("Content-Type", "application/json");
  }

  // If we have a refresh cookie, ensure it's forwarded
  const cookies = parseCookies(request.headers.get("Cookie"));
  const refreshCookieValue = cookies[cookieName] || null;
  if (refreshCookieValue && !upstreamHeaders.has("Cookie")) {
    upstreamHeaders.set("Cookie", `${cookieName}=${refreshCookieValue}`);
  }

  console.log("[WORKER][generic-proxy] Forwarding request", {
    proxyPath,
    upstreamUrl: describeUrlForLog(upstreamUrl.toString()),
    method: request.method,
  });

  try {
    const upstreamResponse = await forwardProxyRequest({
      request,
      url: upstreamUrl.toString(),
      headers: upstreamHeaders,
    });

    // Determine if this is a logout request (should expire cookie)
    const isLogout = proxyPath.includes("logout");

    return buildProxyResponse({
      upstreamResponse,
      cookieName,
      cookiePath,
      cookieMaxAge,
      shouldExpire: isLogout,
      request,
    });
  } catch (error) {
    console.error(
      "[WORKER][generic-proxy] upstream error",
      error instanceof Error
        ? `${error.name}: ${error.message.replace(/\?[^\s"']*/g, "")}`
        : "unknown error"
    );
    return new Response("Upstream error", { status: 502 });
  }
};

export default {
  async fetch(request, env) {
    console.log(
      "[WORKER] Worker started, request:",
      request.method,
      describeUrlForLog(request.url)
    );

    const url = new URL(request.url);
    if (url.pathname.startsWith(PROXY_PREFIX)) {
      const config = getProxyConfig(env);
      console.log("[WORKER] Proxy request detected", {
        pathname: url.pathname,
        configAppId: config.appId,
        apiOrigin: config.apiOrigin,
      });

      // Check if request matches allowed proxy prefixes
      const isAuthRoute = url.pathname.startsWith(PROXY_AUTH_PREFIX);
      const isOAuthRoute = url.pathname.startsWith(PROXY_OAUTH_PREFIX);

      if (isAuthRoute || isOAuthRoute) {
        // Use generic proxy handler for all auth/* and oauth/* routes
        return handleGenericProxy(request, env, config, url);
      }

      return new Response("Not Found", { status: 404 });
    }

    // Test endpoint to verify worker is working
    if (url.pathname === "/worker-test") {
      return new Response(
        JSON.stringify({
          message: "Worker is working!",
          env_vars: getEnvAvailability(env),
        }),
        {
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    // Test HTML injection endpoint
    if (url.pathname === "/html-test") {
      const testHtml = `<!DOCTYPE html>
<html>
<head>
    <title>Test</title>
</head>
<body>
    <h1>Test HTML</h1>
</body>
</html>`;

      return new Response(testHtml, {
        headers: { "Content-Type": "text/html" },
      });
    }

    // Handle API routes
    if (url.pathname.startsWith("/api/")) {
      if (url.pathname === "/api/version") {
        let meta = {
          version: env.BUILD_VERSION || "",
          commit: env.BUILD_COMMIT || "",
          time: env.BUILD_TIME || "",
        };
        try {
          if (!meta.version || !meta.commit) {
            const assetReq = new Request(new URL("/version.json", url.origin), {
              headers: { "cache-control": "no-store" },
            });
            const assetRes = await env.ASSETS.fetch(assetReq);
            if (assetRes.ok) {
              meta = await assetRes.json();
            }
          }
        } catch {}
        return new Response(JSON.stringify(meta), {
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "no-store, no-cache, must-revalidate",
          },
        });
      }
      return new Response("API endpoint", { status: 200 });
    }

    // Get the response from Assets
    const response = await env.ASSETS.fetch(request);
    console.log(
      "[WORKER] Got response from ASSETS:",
      response.status,
      response.headers.get("content-type")
    );

    return response;
  },
};
