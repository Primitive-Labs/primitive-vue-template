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
import { appBaseLogger } from "../lib/logger";
import { jsBaoClientService } from "primitive-app";

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
   * Models to subscribe to for automatic reloads after the first successful load.
   * Each model is expected to expose a `subscribe(cb) => unsubscribe` API.
   */
  subscribeTo: ModelClass[];

  /**
   * Query params that the caller can interpret however they like.
   * Accepts a plain value, a ref, or a computed.
   * `null` disables query-driven reloads.
   */
  queryParams: MaybeRefQuery<Q>;

  /**
   * Document readiness gate. While `false`, no loads will run and
   * `initialDataLoaded` will be reset to `false`.
   */
  documentReady: MaybeRefBoolean;

  /**
   * The actual data loading function. Receives the current query params directly.
   */
  loadData: (queryParams: Q | null) => Promise<Data>;

  /**
   * Optional per-instance pause flag. While true, no loads or scheduled
   * reloads will run.
   */
  pauseUpdates?: MaybeRefBoolean;

  /**
   * Whether to reload when the js-bao client emits documentLoaded or
   * documentClosed events. This handles cases where available data changes
   * due to documents syncing from server or being closed.
   * @default true
   */
  reloadOnDocumentEvents?: MaybeRefBoolean;

  /**
   * Debounce delay (ms) for scheduled reloads.
   */
  debounceMs?: number;

  /**
   * Delay (ms) before `showSkeleton` flips to `true` while data is still
   * loading. If the load completes before this delay, the skeleton never
   * shows — useful to avoid skeleton flashes on warm SPA navigations where
   * document queries resolve in a few milliseconds. Defaults to 100ms.
   */
  skeletonDelayMs?: number;

  /**
   * Optional error handler.
   */
  onError?: (error: unknown) => void;
}

export interface UseJsBaoDataLoaderResult<Data> {
  /**
   * Latest successfully loaded data. Starts as `null`.
   */
  data: Ref<Data | null>;

  /**
   * Becomes `true` after the first successful load while `documentReady`
   * is `true`. Reset back to `false` whenever `documentReady` becomes `false`.
   */
  initialDataLoaded: Ref<boolean>;

  /**
   * Becomes `true` only after `skeletonDelayMs` has elapsed without a
   * successful load. Use this to gate skeletons — it suppresses the brief
   * skeleton flash on fast warm-cache loads. Resets when data loads or
   * when `documentReady` becomes `false`.
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
 * - Wait until `documentReady` is true.
 * - Load data (optionally based on reactive `queryParams`).
 * - Subscribe to model changes and client document events to reload.
 *
 * @param options Configuration describing what to load, when to load, and what to watch.
 * @returns A `{ data, initialDataLoaded, reload }` bundle for consumption in components.
 */
export function useJsBaoDataLoader<
  Data,
  Q extends Record<string, unknown> = Record<string, unknown>,
>(options: UseJsBaoDataLoaderOptions<Data, Q>): UseJsBaoDataLoaderResult<Data> {
  const {
    subscribeTo,
    queryParams,
    documentReady,
    loadData,
    pauseUpdates,
    reloadOnDocumentEvents = true,
    debounceMs = 50,
    skeletonDelayMs = 100,
    onError,
  } = options;

  const data = ref(null) as Ref<Data | null>;
  const initialDataLoaded = ref(false);
  // True once the skeleton-delay timer fires while a load is in flight. Only
  // relevant after the document is ready; see `showSkeleton` below.
  const skeletonDelayElapsed = ref(false);
  const subscriptionsEnabled = ref(false);

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

  const isReady = computed(() => toBoolean(documentReady, false));

  // Whether consumers should render a loading skeleton. This owns the full
  // loading model so templates can just check `showSkeleton`:
  //  - loaded             → never show
  //  - document opening   → show immediately (the dominant initial-load wait,
  //                         which the delay timer does not cover because no
  //                         load runs until the document is ready)
  //  - doc ready, loading → show only after the delay timer fires, so fast
  //                         warm reloads don't flash a skeleton
  const showSkeleton = computed(() => {
    if (initialDataLoaded.value) return false;
    if (!isReady.value) return true;
    return skeletonDelayElapsed.value;
  });
  const isPaused = computed(() => toBoolean(pauseUpdates, false));

  const queryValue = computed<Q | null>(
    () => (unref(queryParams) ?? null) as Q | null
  );

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
      return;
    }
    if (isPaused.value) {
      logger.debug("loadData skipped: paused", {
        reason,
        queryParams: toRaw(queryValue.value),
      });
      return;
    }

    logger.debug("loadData start", {
      reason,
      queryParams: toRaw(queryValue.value),
    });
    if (!initialDataLoaded.value) armSkeletonTimer();
    try {
      const result = await loadData(queryValue.value);
      data.value = result as Data;
      if (!initialDataLoaded.value) {
        initialDataLoaded.value = true;
        subscriptionsEnabled.value = true;
      }
      disarmSkeletonTimer();
      logger.debug("loadData success", {
        reason,
        queryParams: toRaw(queryValue.value),
        data: result,
      });
    } catch (error) {
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

  const scheduleReload = debounce((reason: string) => {
    logger.debug("Reload scheduled", { reason });
    void performLoad(reason);
  }, debounceMs);

  const reload = () => {
    scheduleReload("Manual");
  };

  const unsubscribeFns: Array<() => void> = [];

  onMounted(async () => {
    // Subscribe to model changes
    for (const model of subscribeTo) {
      try {
        const unsubscribe = model.subscribe(() => {
          if (!subscriptionsEnabled.value) return;
          if (!isReady.value) return;
          if (isPaused.value) return;
          scheduleReload("Subscribed models changed");
        });
        unsubscribeFns.push(unsubscribe);
      } catch (error) {
        logger.warn("Failed to subscribe to model", { error });
      }
    }

    // Subscribe to js-bao client document events
    if (toBoolean(reloadOnDocumentEvents, true)) {
      try {
        const client = await jsBaoClientService.getClientAsync();

        const handleDocumentLoaded = () => {
          if (!subscriptionsEnabled.value) return;
          if (!isReady.value) return;
          if (isPaused.value) return;
          scheduleReload("Document loaded");
        };

        const handleDocumentClosed = () => {
          if (!subscriptionsEnabled.value) return;
          if (!isReady.value) return;
          if (isPaused.value) return;
          scheduleReload("Document closed");
        };

        client.on("documentLoaded", handleDocumentLoaded);
        client.on("documentClosed", handleDocumentClosed);

        unsubscribeFns.push(() => {
          client.off("documentLoaded", handleDocumentLoaded);
          client.off("documentClosed", handleDocumentClosed);
        });

        logger.debug("Subscribed to js-bao document events");
      } catch (error) {
        logger.warn("Failed to subscribe to js-bao client events", { error });
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
        logger.debug("documentReady became false; resetting state");
        initialDataLoaded.value = false;
        subscriptionsEnabled.value = false;
        disarmSkeletonTimer();
        return;
      }

      if (!isPaused.value) {
        logger.debug("documentReady became true; scheduling initial load");
        scheduleReload("Document became ready");
      } else {
        logger.debug(
          "documentReady became true but updates are paused; not scheduling load"
        );
      }
    },
    { immediate: true }
  );

  watch(querySignature, (signature) => {
    if (signature === null) {
      logger.debug("queryParams disabled (null)");
      return;
    }
    if (!isReady.value) {
      logger.debug("queryParams changed but document not ready; ignoring", {
        signature,
      });
      return;
    }
    if (isPaused.value) {
      logger.debug("queryParams changed but updates are paused; ignoring", {
        signature,
      });
      return;
    }

    logger.debug("queryParams changed; scheduling reload", { signature });
    scheduleReload("Queries changed");
  });

  return {
    data,
    initialDataLoaded,
    showSkeleton,
    reload,
  };
}
