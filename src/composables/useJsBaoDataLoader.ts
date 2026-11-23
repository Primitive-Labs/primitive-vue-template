import debounce from "lodash.debounce";
import type { ComputedRef, Ref } from "vue";
import {
  computed,
  onMounted,
  onUnmounted,
  ref,
  toRaw,
  unref,
  watch,
} from "vue";
import { getAppClient } from "../lib/client";
import { appBaseLogger } from "../lib/logger";

const logger = appBaseLogger.forScope("useJsBaoDataLoader");

type ModelClass = {
  subscribe: (cb: () => void) => () => void;
};

type MaybeRefBoolean = boolean | Ref<boolean> | ComputedRef<boolean>;
type MaybeRefQuery<Q> = Q | null | Ref<Q | null> | ComputedRef<Q | null>;

export interface UseJsBaoDataLoaderOptions<
  Data,
  Q extends Record<string, unknown> = Record<string, unknown>,
> {
  /**
   * Models to subscribe to: a change to any of them reloads. Each exposes
   * `subscribe(cb) => unsubscribe` (every generated model does, db3 records
   * included).
   */
  subscribeTo: ModelClass[];

  /**
   * Query params that the caller can interpret however they like.
   * Accepts a plain value, a ref, or a computed.
   * `null` disables query-driven reloads.
   */
  queryParams: MaybeRefQuery<Q>;

  /**
   * Readiness gate (e.g. "the db3 this view reads is open"). While `false`,
   * no loads run, `data` is `null` and `initialDataLoaded` is `false`.
   * Defaults to `true`.
   */
  ready?: MaybeRefBoolean;

  /**
   * The actual data loading function. Receives the current query params directly.
   */
  loadData: (queryParams: Q | null) => Promise<Data>;

  /**
   * Optional per-instance pause flag. While true, no loads run. A reload asked
   * for while paused (a model change, a db3 event, a query change, `reload()`)
   * is kept, and runs once when the flag goes back to false.
   */
  pauseUpdates?: MaybeRefBoolean;

  /**
   * Whether to reload when the app client reports that a db3 became ready
   * (`db3:ready`), was deleted or lost (`db3:gone`), or was evicted from the
   * local cache (`db3:evicted`): the records a view can read changed without
   * a model change.
   * @default true
   */
  reloadOnDb3Events?: MaybeRefBoolean;

  /**
   * Debounce delay (ms) for scheduled reloads.
   */
  debounceMs?: number;

  /**
   * Delay (ms) before `showSkeleton` flips to `true` while data is still
   * loading. If the load completes before this delay, the skeleton never
   * shows — useful to avoid skeleton flashes on warm SPA navigations where
   * local queries resolve in a few milliseconds. Defaults to 100ms.
   */
  skeletonDelayMs?: number;

  /**
   * Optional error handler.
   */
  onError?: (error: unknown) => void;
}

export interface UseJsBaoDataLoaderResult<Data> {
  /**
   * Latest successfully loaded data. Starts as `null`, and goes back to `null`
   * when `ready` becomes `false` or the query changes, until the next load
   * lands — so a view never shows one query's rows under another's.
   */
  data: Ref<Data | null>;

  /**
   * Becomes `true` after the first successful load while `ready` is `true`.
   * Reset back to `false` whenever `ready` becomes `false` or the query
   * changes.
   */
  initialDataLoaded: Ref<boolean>;

  /**
   * `true` while a load whose result the loader will publish is running.
   */
  isLoading: Ref<boolean>;

  /**
   * The error the latest load threw, or `null`. Cleared by the next
   * successful load, and when `ready` becomes `false` or the query changes.
   */
  error: Ref<unknown>;

  /**
   * Becomes `true` only after `skeletonDelayMs` has elapsed without a
   * successful load. Use this to gate skeletons — it suppresses the brief
   * skeleton flash on fast warm-cache loads. Resets when data loads or
   * when `ready` becomes `false`.
   */
  showSkeleton: Ref<boolean>;

  /**
   * Manually schedule a reload (subject to debounce, readiness, and pause).
   */
  reload: () => void;
}

function toBoolean(source: MaybeRefBoolean | undefined, defaultValue: boolean) {
  if (source === undefined) return defaultValue;
  return Boolean(unref(source));
}

function stableStringify(value: unknown): string {
  const seen = new WeakSet();
  const stringify = (val: unknown): unknown => {
    if (val && typeof val === "object") {
      if (seen.has(val)) return "[Circular]";
      seen.add(val);
      if (Array.isArray(val)) {
        return val.map(stringify);
      }
      const keys = Object.keys(val).sort();
      const obj: Record<string, unknown> = {};
      for (const k of keys) {
        obj[k] = stringify((val as Record<string, unknown>)[k]);
      }
      return obj;
    }
    return val;
  };
  try {
    return JSON.stringify(stringify(value));
  } catch {
    return "__non_serializable__";
  }
}

/**
 * Reactive data-loading composable with subscriptions and debounced reloads.
 *
 * This helper centralizes a common pattern in the app:
 * - Wait until `ready` is true.
 * - Load data (optionally based on reactive `queryParams`).
 * - Reload on model changes and on the client's db3 events.
 *
 * ```ts
 * const { data, showSkeleton } = useJsBaoDataLoader({
 *   subscribeTo: [Note],
 *   queryParams: null,
 *   loadData: async () => (await Note.query({})).data,
 * });
 * ```
 *
 * @param options Configuration describing what to load, when to load, and what to watch.
 * @returns A `{ data, initialDataLoaded, isLoading, error, showSkeleton, reload }`
 *   bundle for consumption in components.
 */
export function useJsBaoDataLoader<
  Data,
  Q extends Record<string, unknown> = Record<string, unknown>,
>(options: UseJsBaoDataLoaderOptions<Data, Q>): UseJsBaoDataLoaderResult<Data> {
  const {
    subscribeTo,
    queryParams,
    ready,
    loadData,
    pauseUpdates,
    reloadOnDb3Events = true,
    debounceMs = 50,
    skeletonDelayMs = 100,
    onError,
  } = options;

  const data = ref(null) as Ref<Data | null>;
  const initialDataLoaded = ref(false);
  const isLoading = ref(false);
  const lastError = ref<unknown>(null);
  // A reload was asked for while paused. Ending the pause runs it, once.
  let reloadPendingWhilePaused = false;
  // True once the skeleton-delay timer fires while a load is in flight. Only
  // relevant once `ready`; see `showSkeleton` below.
  const skeletonDelayElapsed = ref(false);
  // #3023 — the load that started last is the one whose result lands. The
  // subscriptions below are deliberately live from the start, so two loads can
  // be in flight at once: a change that arrives while the first load is still
  // reading schedules a second one, and without this counter the slower first
  // load could finish last and put its stale (usually empty) result back.
  let loadGeneration = 0;
  // The generation the next scheduled load will claim, taken the moment that
  // load is SCHEDULED rather than when it starts. The reload a change asks for
  // waits out the debounce first, and a first load that resolves inside that
  // window would otherwise still count as current: it would publish the empty
  // result the reload exists to replace, and set `initialDataLoaded` — which
  // is what a one-shot consumer (an "is this db3 empty?" bootstrap) reads.
  let scheduledGeneration: number | null = null;

  /**
   * Retire whatever is in flight: a newer load has been decided on, so no
   * result from before it may land. Idempotent — a burst of changes that the
   * debounce coalesces into one reload reserves one generation.
   */
  const supersedeInFlightLoads = () => {
    if (scheduledGeneration === null) scheduledGeneration = ++loadGeneration;
  };

  let skeletonTimer: ReturnType<typeof setTimeout> | null = null;

  const armSkeletonTimer = (): void => {
    if (skeletonTimer !== null) return;
    if (initialDataLoaded.value) return;
    skeletonTimer = setTimeout(() => {
      skeletonTimer = null;
      if (!initialDataLoaded.value) skeletonDelayElapsed.value = true;
    }, skeletonDelayMs);
  };

  const disarmSkeletonTimer = (): void => {
    if (skeletonTimer !== null) {
      clearTimeout(skeletonTimer);
      skeletonTimer = null;
    }
    skeletonDelayElapsed.value = false;
  };

  const isReady = computed(() => toBoolean(ready, true));

  // Whether consumers should render a loading skeleton. This owns the full
  // loading model so templates can just check `showSkeleton`:
  //  - loaded             → never show
  //  - not ready yet      → show immediately (the dominant initial-load wait,
  //                         which the delay timer does not cover because no
  //                         load runs until `ready`)
  //  - ready, loading     → show only after the delay timer fires, so fast
  //                         warm reloads don't flash a skeleton
  const showSkeleton = computed(() => {
    if (initialDataLoaded.value) return false;
    if (!isReady.value) return true;
    return skeletonDelayElapsed.value;
  });
  const isPaused = computed(() => toBoolean(pauseUpdates, false));

  const queryValue = computed<Q | null>(() => unref(queryParams) ?? null);

  const querySignature = computed(() => {
    const value = queryValue.value;
    return value === null ? null : stableStringify(value);
  });

  const performLoad = async (reason: string) => {
    if (!isReady.value) {
      logger.debug("loadData skipped: not ready", {
        reason,
        queryParams: toRaw(queryValue.value),
      });
      // Any load still in flight was superseded when this one was scheduled.
      isLoading.value = false;
      return;
    }
    if (isPaused.value) {
      logger.debug("loadData skipped: paused; it runs when the pause ends", {
        reason,
        queryParams: toRaw(queryValue.value),
      });
      reloadPendingWhilePaused = true;
      isLoading.value = false;
      return;
    }

    logger.debug("loadData start", {
      reason,
      queryParams: toRaw(queryValue.value),
    });
    if (!initialDataLoaded.value) armSkeletonTimer();
    const generation = scheduledGeneration ?? ++loadGeneration;
    scheduledGeneration = null;
    isLoading.value = true;
    try {
      const result = await loadData(queryValue.value);
      if (generation !== loadGeneration) {
        logger.debug("loadData result dropped: a newer load started", {
          reason,
        });
        return;
      }
      data.value = result;
      lastError.value = null;
      isLoading.value = false;
      initialDataLoaded.value = true;
      disarmSkeletonTimer();
      logger.debug("loadData success", {
        reason,
        queryParams: toRaw(queryValue.value),
        data: result,
      });
    } catch (error) {
      if (generation !== loadGeneration) {
        // #3023 — a newer load overtook this one, and its result is what the
        // view shows. A failure this late is a failure of a request nobody is
        // waiting for any more: reporting it would put the caller into an
        // error state over data that did load.
        logger.debug("loadData error dropped: a newer load started", {
          reason,
          error,
        });
        return;
      }
      lastError.value = error;
      isLoading.value = false;
      if (onError) {
        try {
          onError(error);
        } catch (handlerError) {
          logger.warn("onError handler threw", { handlerError });
        }
      }
      logger.error("loadData error", {
        reason,
        queryParams: toRaw(queryValue.value),
        error,
      });
    }
  };

  const runScheduledLoad = debounce((reason: string) => {
    logger.debug("Reload scheduled", { reason });
    void performLoad(reason);
  }, debounceMs);

  const scheduleReload = (reason: string) => {
    if (isPaused.value) {
      // Kept, not dropped: the pause ending runs one reload for every change
      // that arrived meanwhile.
      reloadPendingWhilePaused = true;
      return;
    }
    // Synchronously, ahead of the debounce: from here on the load in flight is
    // stale, whether or not the reload has started (#3023).
    supersedeInFlightLoads();
    runScheduledLoad(reason);
  };

  /**
   * Forget what is shown: the rows belong to a query or a db3 the view no
   * longer reads. Any load in flight or scheduled is retired with them.
   */
  const clearData = () => {
    runScheduledLoad.cancel();
    loadGeneration++;
    scheduledGeneration = null;
    data.value = null;
    lastError.value = null;
    isLoading.value = false;
    initialDataLoaded.value = false;
  };

  const reload = () => {
    scheduleReload("Manual");
  };

  const unsubscribeFns: Array<() => void> = [];

  onMounted(async () => {
    // Subscribe to model changes
    for (const model of subscribeTo) {
      try {
        const unsubscribe = model.subscribe(() => {
          // #3023 — deliberately NOT gated on the first load having finished.
          // The initial sync of a db3 opened with an empty local replica
          // lands while that load is still reading, so a gate here left the
          // view on the empty result with nothing left to move it.
          if (!isReady.value) return;
          scheduleReload("Subscribed models changed");
        });
        unsubscribeFns.push(unsubscribe);
      } catch (error) {
        logger.warn("Failed to subscribe to model", { error });
      }
    }

    // Reload when a db3 this view may read becomes ready, gone or evicted.
    if (toBoolean(reloadOnDb3Events, true)) {
      try {
        const client = await getAppClient();
        for (const event of ["db3:ready", "db3:gone", "db3:evicted"] as const) {
          const handler = () => {
            if (!isReady.value) return;
            scheduleReload(`Client event ${event}`);
          };
          client.on(event, handler);
          unsubscribeFns.push(() => client.off(event, handler));
        }
        logger.debug("Subscribed to the client's db3 events");
      } catch (error) {
        logger.warn("Failed to subscribe to the client's db3 events", {
          error,
        });
      }
    }
  });

  onUnmounted(() => {
    disarmSkeletonTimer();
    for (const unsubscribe of unsubscribeFns) {
      try {
        unsubscribe();
      } catch {
        // Ignore unsubscribe errors
      }
    }
  });

  watch(
    isReady,
    (ready) => {
      if (!ready) {
        logger.debug("ready became false; resetting state");
        clearData();
        disarmSkeletonTimer();
        return;
      }

      logger.debug("ready became true; scheduling initial load");
      scheduleReload("Became ready");
    },
    { immediate: true }
  );

  // Synchronous, so every resume is seen: a batched watcher misses a pause
  // that begins and ends in one turn (no net change by flush time), and the
  // change asked for during it would stay pending until some later resume.
  watch(
    isPaused,
    (paused) => {
      if (paused || !reloadPendingWhilePaused) return;
      reloadPendingWhilePaused = false;
      if (!isReady.value) return;
      logger.debug("updates resumed; reloading what changed while paused");
      scheduleReload("Resumed after a change while paused");
    },
    { flush: "sync" }
  );

  watch(querySignature, (signature) => {
    if (signature === null) {
      logger.debug("queryParams disabled (null)");
      return;
    }
    if (!isReady.value) {
      logger.debug("queryParams changed but not ready; ignoring", {
        signature,
      });
      return;
    }

    // The rows on screen answer the previous query.
    clearData();
    logger.debug("queryParams changed; scheduling reload", { signature });
    scheduleReload("Queries changed");
  });

  return {
    data,
    initialDataLoaded,
    isLoading,
    error: lastError,
    showSkeleton,
    reload,
  };
}
