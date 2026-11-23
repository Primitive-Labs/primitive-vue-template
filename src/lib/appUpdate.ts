/**
 * @module appUpdate
 *
 * What the update banner (`AppUpdateBanner.vue`) and the update gate
 * (`AppUpdateGate.vue`) decide, kept apart from Vue and from the client so it
 * can be tested on its own.
 *
 * - `APP_VERSION` and `APP_BUILD_ID` are stamped in by the build
 *   (`vite-plugins/appVersion.ts`) from the app's `package.json`.
 * - `watchAppVersion` hands a component the client's version status as it is
 *   now and every change after.
 * - `noticeReasons` says why the banner shows; the dismissal store remembers
 *   which reasons the user dismissed.
 * - `readServedBuildId` and `scheduleBuildChecks` notice that the origin now
 *   serves a newer build than the page is running.
 */

/** This build's app version (`package.json` `version`), or undefined when it has none. */
export const APP_VERSION: string | undefined =
  import.meta.env.VITE_APP_VERSION || undefined;

/** This build's id; empty in `vite` dev, where there is no version file. */
export const APP_BUILD_ID: string = import.meta.env.VITE_APP_BUILD_ID ?? "";

/** Where the origin serves the version file of the build it now hands out. */
export const VERSION_FILE_PATH = "/version.json";

/** How often the banner checks the served build, besides mount and foreground. */
export const BUILD_CHECK_INTERVAL_MS = 3_600_000;

/** One platform's entry of the app's client version policy. */
export interface AppUpdatePolicyEntry {
  latest?: string;
  minRecommended?: string;
  minRequired?: string;
  updateUrl?: string;
}

/** The part of the client's `AppVersionState` the components read. */
export interface AppUpdateState {
  status: string;
  policy: AppUpdatePolicyEntry | null;
  refused?: boolean;
}

/** What `client.appVersion` offers; a structural type, so this module imports no client. */
export interface AppVersionSource<S> {
  onStatusChange(listener: (state: S) => void): () => void;
  getStatus(): Promise<S>;
}

/**
 * Hand `apply` the client's version state now and on every change, until the
 * returned function is called.
 *
 * The client does not replay its state to a new subscriber, so this both
 * subscribes and reads the state once. The read is dropped when a change
 * notification arrived first, because the notification is newer.
 */
export function watchAppVersion<S>(
  source: AppVersionSource<S>,
  apply: (state: S) => void
): () => void {
  let stopped = false;
  let notified = false;
  const unsubscribe = source.onStatusChange((state) => {
    if (stopped) return;
    notified = true;
    apply(state);
  });
  source.getStatus().then(
    (state) => {
      if (!stopped && !notified) apply(state);
    },
    () => undefined
  );
  return () => {
    stopped = true;
    unsubscribe();
  };
}

/** What reading the served version file gave. */
export type VersionFileRead =
  { ok: true; buildId: string } | { ok: false; reason: string };

/** Read an answer for `/version.json`: its `buildId`, or why there is none. */
export function readVersionFile(answer: {
  status: number;
  body: string;
}): VersionFileRead {
  if (answer.status !== 200) {
    return { ok: false, reason: `the answer was HTTP ${answer.status}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(answer.body);
  } catch {
    return { ok: false, reason: "the answer is not JSON" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: "the answer is not a JSON object" };
  }
  const buildId = (parsed as { buildId?: unknown }).buildId;
  if (typeof buildId !== "string" || buildId.length === 0) {
    return { ok: false, reason: "the answer has no buildId" };
  }
  return { ok: true, buildId };
}

let versionFileWarned = false;

/**
 * Fetch `/version.json` from the page's origin and return the build id it
 * serves, or null when it cannot be read. The first failure in a page's life
 * is passed to `warn`; later ones are silent.
 */
export async function readServedBuildId(
  warn: (message: string) => void,
  fetchImpl: typeof fetch = fetch
): Promise<string | null> {
  let read: VersionFileRead;
  try {
    const response = await fetchImpl(VERSION_FILE_PATH, { cache: "no-store" });
    read = readVersionFile({
      status: response.status,
      body: await response.text(),
    });
  } catch (error) {
    read = {
      ok: false,
      reason: `the request failed (${error instanceof Error ? error.message : String(error)})`,
    };
  }
  if (read.ok) return read.buildId;
  if (!versionFileWarned) {
    versionFileWarned = true;
    warn(
      `Could not read ${VERSION_FILE_PATH}: ${read.reason}. The new-build banner stays off until it can be read.`
    );
  }
  return null;
}

/**
 * Why the banner shows, one string per reason:
 * `available:<latest>` for `updateAvailable`,
 * `recommended:<minRecommended>:<latest>` for `updateRecommended`, and
 * `build:<servedBuildId>` when the origin serves another build than the page
 * runs. Nothing while `updateRequired` (the gate shows instead), and no build
 * reason without both build ids.
 */
export function noticeReasons(
  state: AppUpdateState | null,
  pageBuildId: string,
  servedBuildId: string | null
): string[] {
  if (state?.status === "updateRequired") return [];
  const reasons: string[] = [];
  const entry = state?.policy ?? {};
  if (state?.status === "updateAvailable") {
    reasons.push(`available:${entry.latest ?? ""}`);
  } else if (state?.status === "updateRecommended") {
    reasons.push(
      `recommended:${entry.minRecommended ?? ""}:${entry.latest ?? ""}`
    );
  }
  if (pageBuildId && servedBuildId && pageBuildId !== servedBuildId) {
    reasons.push(`build:${servedBuildId}`);
  }
  return reasons;
}

/** Which wording the banner uses for `reasons`. */
export function noticeKind(reasons: string[]): "available" | "recommended" {
  return reasons.some((reason) => reason.startsWith("recommended:"))
    ? "recommended"
    : "available";
}

/** The part of `localStorage` the dismissal store uses. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Where one app's dismissed reasons are kept. */
export interface DismissalStore {
  readonly key: string;
  readonly storage: StorageLike | null;
  /** What was last dismissed in this page, used when the storage fails. */
  memory: string[] | null;
  storageFailed: boolean;
}

/**
 * The dismissal store for `appId`. Pass `null` for `storage` when there is
 * none; a dismissal then lasts until the page is reloaded.
 */
export function dismissalStore(
  appId: string,
  storage: StorageLike | null
): DismissalStore {
  return {
    key: `primitive.appUpdate.dismissed:${appId}`,
    storage,
    memory: null,
    storageFailed: storage === null,
  };
}

function storedReasons(text: string | null): string[] {
  if (text === null) return [];
  try {
    const parsed: unknown = JSON.parse(text);
    if (
      Array.isArray(parsed) &&
      parsed.every((item) => typeof item === "string")
    ) {
      return parsed;
    }
  } catch {
    // A damaged entry reads as nothing dismissed.
  }
  return [];
}

/** The reasons last dismissed for this app. */
export function loadDismissed(store: DismissalStore): string[] {
  if (!store.storageFailed && store.storage) {
    try {
      return storedReasons(store.storage.getItem(store.key));
    } catch {
      store.storageFailed = true;
    }
  }
  return store.memory ? [...store.memory] : [];
}

/** Record `reasons` as dismissed, replacing what was dismissed before. */
export function saveDismissed(store: DismissalStore, reasons: string[]): void {
  store.memory = [...reasons];
  if (store.storageFailed || !store.storage) return;
  try {
    store.storage.setItem(store.key, JSON.stringify(reasons));
  } catch {
    store.storageFailed = true;
  }
}

/** True when every one of `reasons` was dismissed (and there is at least one). */
export function isDismissed(store: DismissalStore, reasons: string[]): boolean {
  if (reasons.length === 0) return false;
  const dismissed = new Set(loadDismissed(store));
  return reasons.every((reason) => dismissed.has(reason));
}

/** `window.localStorage`, or null where it cannot be used. */
export function browserStorage(): StorageLike | null {
  try {
    return typeof window !== "undefined" && window.localStorage
      ? window.localStorage
      : null;
  } catch {
    return null;
  }
}

/**
 * Run `check` now, each time the page returns to the foreground, and every
 * `intervalMs`, until the returned function is called.
 */
export function scheduleBuildChecks(options: {
  check: () => void;
  intervalMs: number;
  target: EventTarget;
  visibility: () => DocumentVisibilityState;
}): () => void {
  const { check, intervalMs, target, visibility } = options;
  const onVisibility = () => {
    if (visibility() === "visible") check();
  };
  target.addEventListener("visibilitychange", onVisibility);
  const timer = setInterval(check, intervalMs);
  check();
  return () => {
    target.removeEventListener("visibilitychange", onVisibility);
    clearInterval(timer);
  };
}
