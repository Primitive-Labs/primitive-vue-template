function logError(context, error, extra) {
  const info = {
    context,
    message: (error && error.message) || String(error),
    name: error && error.name,
    stack: error && error.stack,
    extra,
  };
  try {
    console.error("[ServiceWorker][Error]", info);
  } catch {}
}

const STATE = {
  appId: null,
  userId: null,
  // token is cached separately in TOKEN_CACHE and refreshed once per minute
  cachePrefix: null,
  globalAdminAppId: null,
};

// Token cache: refresh once per minute instead of on every request
const TOKEN_CACHE = {
  token: null,
  lastFetched: 0,
  refreshIntervalMs: 60000, // 1 minute
};

// Track whether persisted state has been loaded
let stateLoadedPromise = null;

// In-memory metadata example; persist to IndexedDB if you need SW restarts to keep state.
const BLOB_METADATA = new Map();

// IndexedDB helpers for persisting STATE across SW restarts
const IDB_CONFIG = {
  dbName: "js-bao-sw",
  storeName: "kv",
  stateKey: "STATE",
};

function openDb() {
  return new Promise((resolve, reject) => {
    try {
      const request = indexedDB.open(IDB_CONFIG.dbName, 1);
      request.onupgradeneeded = () => {
        try {
          const db = request.result;
          if (!db.objectStoreNames.contains(IDB_CONFIG.storeName)) {
            db.createObjectStore(IDB_CONFIG.storeName);
          }
        } catch (e) {
          logError("idb.upgrade", e);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () =>
        reject(request.error || new Error("IndexedDB open failed"));
    } catch (e) {
      reject(e);
    }
  });
}

function idbGet(key) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        try {
          const tx = db.transaction(IDB_CONFIG.storeName, "readonly");
          const store = tx.objectStore(IDB_CONFIG.storeName);
          const req = store.get(key);
          req.onsuccess = () => resolve(req.result);
          req.onerror = () =>
            reject(req.error || new Error("IndexedDB get failed"));
        } catch (e) {
          reject(e);
        }
      })
  );
}

function idbSet(key, value) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        try {
          const tx = db.transaction(IDB_CONFIG.storeName, "readwrite");
          const store = tx.objectStore(IDB_CONFIG.storeName);
          const req = store.put(value, key);
          req.onsuccess = () => resolve();
          req.onerror = () =>
            reject(req.error || new Error("IndexedDB put failed"));
        } catch (e) {
          reject(e);
        }
      })
  );
}

async function persistState() {
  try {
    const snapshot = {
      appId: STATE.appId,
      userId: STATE.userId,
      // Don't persist token - we fetch it from auth IDB on demand
      cachePrefix: STATE.cachePrefix,
      globalAdminAppId: STATE.globalAdminAppId,
      apiBaseUrl: STATE.apiBaseUrl,
    };
    await idbSet(IDB_CONFIG.stateKey, snapshot);
  } catch (e) {
    logError("persistState", e);
  }
}

// Helper: Open auth IndexedDB
function openAuthDb(appId, namespace = "default") {
  const dbName = `js-bao:auth:${appId}:${namespace}`;
  return new Promise((resolve, reject) => {
    try {
      const request = indexedDB.open(dbName, 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () =>
        reject(request.error || new Error("Auth DB open failed"));
    } catch (e) {
      reject(e);
    }
  });
}

// Helper: Read token from auth IndexedDB
async function getAuthTokenFromIDB(appId) {
  try {
    if (!appId) {
      return null;
    }

    const db = await openAuthDb(appId);

    // Read the "session" token from the "tokens" object store
    const token = await new Promise((resolve, reject) => {
      try {
        const tx = db.transaction("tokens", "readonly");
        const store = tx.objectStore("tokens");
        const req = store.get("session");
        req.onsuccess = () => {
          const record = req.result;
          if (record && record.token) {
            // Check if token is expired
            const now = Date.now();
            if (record.expiresAt && record.expiresAt > now) {
              resolve(record.token);
            } else {
              resolve(null);
            }
          } else {
            resolve(null);
          }
        };
        req.onerror = () => reject(req.error || new Error("Token read failed"));
      } catch (e) {
        reject(e);
      }
    });

    db.close();
    return token;
  } catch {
    // Database doesn't exist or other error - return null
    return null;
  }
}

// Helper: Get cached token or refresh if stale
async function getCachedAuthToken() {
  const now = Date.now();
  const isStale = now - TOKEN_CACHE.lastFetched > TOKEN_CACHE.refreshIntervalMs;

  if (!TOKEN_CACHE.token || isStale) {
    TOKEN_CACHE.token = await getAuthTokenFromIDB(STATE.appId);
    TOKEN_CACHE.lastFetched = now;
  }

  return TOKEN_CACHE.token;
}

async function loadPersistedState() {
  try {
    const saved = await idbGet(IDB_CONFIG.stateKey);
    if (!saved) {
      return;
    }
    // Assign only known fields to avoid prototype pollution
    if (typeof saved.appId !== "undefined") STATE.appId = saved.appId;
    if (typeof saved.userId !== "undefined") STATE.userId = saved.userId;
    // Don't load token from persisted state - we'll fetch it from auth IDB on each request
    if (typeof saved.cachePrefix !== "undefined")
      STATE.cachePrefix = saved.cachePrefix;
    if (typeof saved.globalAdminAppId !== "undefined")
      STATE.globalAdminAppId = saved.globalAdminAppId;
    if (typeof saved.apiBaseUrl !== "undefined")
      STATE.apiBaseUrl = saved.apiBaseUrl;
  } catch (e) {
    logError("loadPersistedState", e);
  }
}

// Ensure state is loaded, loading it if necessary
async function ensureStateLoaded() {
  if (!stateLoadedPromise) {
    stateLoadedPromise = loadPersistedState();
  }
  await stateLoadedPromise;
}

self.addEventListener("message", (event) => {
  const data = (event && event.data) ?? {};
  const type = data && data.type;
  const payload =
    data && typeof data.payload === "object" && data.payload !== null
      ? data.payload
      : {};
  if (!type) return;

  if (type === "jsBao:init") {
    const appIdChanged = payload.appId && payload.appId !== STATE.appId;
    STATE.appId = payload.appId ?? STATE.appId;
    STATE.userId = payload.userId ?? STATE.userId;
    STATE.cachePrefix = payload.blobs?.cachePrefix ?? STATE.cachePrefix;
    STATE.globalAdminAppId = payload.globalAdminAppId ?? STATE.globalAdminAppId;
    STATE.apiBaseUrl = payload.apiBaseUrl ?? STATE.apiBaseUrl;

    // Invalidate token cache if appId changed
    if (appIdChanged) {
      TOKEN_CACHE.token = null;
      TOKEN_CACHE.lastFetched = 0;
    }

    try {
      if (event && typeof event.waitUntil === "function") {
        event.waitUntil(persistState());
      } else {
        persistState();
      }
    } catch (e) {
      logError("message.persistState.init", e);
    }
  } else if (type === "jsBao:getState") {
    // Respond with current STATE (use cached token)
    const ports = event.ports;
    if (ports && ports[0]) {
      (async () => {
        const token = await getCachedAuthToken();
        ports[0].postMessage({
          type: "jsBao:stateResponse",
          payload: { ...STATE, token },
        });
      })();
    }
  }
});

self.addEventListener("install", () => {
  try {
    self.skipWaiting();
  } catch (e) {
    logError("install", e);
  }
});

self.addEventListener("activate", (event) => {
  try {
    event.waitUntil(
      (async () => {
        await self.clients.claim();
      })()
    );
  } catch (e) {
    logError("activate.claim", e);
  }
});

self.addEventListener("error", (e) => logError("error", e));

self.addEventListener("unhandledrejection", (e) =>
  logError("unhandledrejection", e.reason)
);

// Periodic token refresh (every minute)
try {
  setInterval(async () => {
    if (STATE.appId) {
      await getCachedAuthToken();
    }
  }, 60000);
} catch {}

self.addEventListener("fetch", (event) => {
  try {
    const url = new URL(event.request.url);

    // Quick pre-check: only handle blob download requests, of a document or
    // of a database (db3)
    if (
      !url.pathname.includes("/api/documents/") &&
      !url.pathname.includes("/api/db3/")
    )
      return;
    if (!url.pathname.includes("/blobs/")) return;
    if (!url.pathname.endsWith("/download")) return;

    event.respondWith(
      (async () => {
        // Load state if not already loaded
        await ensureStateLoaded();

        const apiOrigin = STATE.apiBaseUrl ?? self.location.origin;

        if (url.origin !== apiOrigin) return fetch(event.request);

        if (!STATE.appId) return fetch(event.request);
        const api = `/app/${STATE.appId}/api/`;
        if (
          !url.pathname.startsWith(`${api}documents/`) &&
          !url.pathname.startsWith(`${api}db3/`)
        )
          return fetch(event.request);

        return handleProxy(event.request);
      })()
    );
  } catch (e) {
    logError("Error in fetch.listener", e);
  }
});

async function handleProxy(request) {
  // Load state if not already loaded
  await ensureStateLoaded();

  if (!STATE.appId) {
    return fetch(request);
  }

  const requestUrl = new URL(request.url);
  const apiBase = STATE.apiBaseUrl
    ? new URL(STATE.apiBaseUrl)
    : new URL(requestUrl.origin);
  const upstreamUrl = new URL(
    `${requestUrl.pathname}${requestUrl.search}`,
    apiBase.origin
  );

  const canonicalKey = buildCanonicalKey(apiBase.origin, requestUrl.pathname);
  const metadata = extractDispositionMetadata(requestUrl);
  if (metadata) {
    BLOB_METADATA.set(canonicalKey, metadata);
  }

  // Use cached auth token (refreshed once per minute)
  const token = await getCachedAuthToken();

  const headers = new Headers(request.headers);
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }
  if (STATE.globalAdminAppId) {
    headers.set("X-Global-Admin-App-Id", STATE.globalAdminAppId);
  }

  const upstreamRequest = new Request(upstreamUrl.toString(), {
    method: request.method,
    headers,
    redirect: request.redirect,
    cache: "no-store",
    credentials: "omit",
    mode: "cors",
  });

  const cacheName =
    STATE.cachePrefix ?? `js-bao-blobs:${STATE.appId}:${STATE.userId}`;
  const cache = await caches.open(cacheName);

  const canonicalRequest = new Request(canonicalKey, { method: "GET" });
  const effectiveMetadata = metadata ?? BLOB_METADATA.get(canonicalKey) ?? null;

  const cached = await cache.match(canonicalRequest);
  if (cached) {
    return applyDisposition(cached, effectiveMetadata);
  }

  const upstream = await fetch(upstreamRequest);
  if (!upstream.ok || request.method !== "GET") {
    logError("[ServiceWorker] handleProxy upstream not ok: ", { upstream });
    return upstream;
  }

  const sanitized = stripDisposition(upstream);
  try {
    await cache.put(canonicalRequest, sanitized.clone());
  } catch (err) {
    logError("[SW] Failed to write blob cache entry", err);
  }

  return applyDisposition(sanitized, effectiveMetadata);
}

function buildCanonicalKey(origin, pathname) {
  return new URL(pathname, origin).toString();
}

function extractDispositionMetadata(url) {
  const disposition = url.searchParams.get("disposition");
  if (!disposition) return null;
  const attachmentFilename =
    url.searchParams.get("attachmentFilename") ?? undefined;
  return { disposition, attachmentFilename };
}

function stripDisposition(response) {
  const headers = new Headers(response.headers);
  headers.delete("Content-Disposition");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function applyDisposition(response, metadata) {
  if (!metadata) return response;

  const headers = new Headers(response.headers);
  headers.delete("Content-Disposition");

  if (metadata.disposition === "inline") {
    headers.set("Content-Disposition", "inline");
  } else if (metadata.disposition === "attachment") {
    const filename = metadata.attachmentFilename;
    if (filename) {
      headers.set(
        "Content-Disposition",
        `attachment; filename="${sanitizeAsciiFilename(filename)}"; filename*=UTF-8''${encodeRFC5987(filename)}`
      );
    } else {
      headers.set("Content-Disposition", "attachment");
    }
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function sanitizeAsciiFilename(filename) {
  return filename.replace(/["\\]/g, "_");
}

function encodeRFC5987(value) {
  return encodeURIComponent(value)
    .replace(
      /['()*]/g,
      (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`
    )
    .replace(/%(7C|60|5E)/g, (_, hex) => `%${hex.toLowerCase()}`);
}

// Global error hooks for extra robustness
try {
  self.addEventListener("error", (event) => {
    logError("global.error", (event && event.error) || event);
  });
  self.addEventListener("unhandledrejection", (event) => {
    logError("global.unhandledrejection", (event && event.reason) || event);
  });
} catch {}

// Load state on script startup
stateLoadedPromise = (async () => {
  try {
    await loadPersistedState();
  } catch (e) {
    logError("script.loadPersistedState", e);
  }
})();
