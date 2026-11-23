<script setup lang="ts">
/**
 * AppUpdateBanner — tells the user a newer version of the app exists.
 *
 * It shows, fixed to the bottom of the screen, when:
 * - the app's client version policy (`[clients.web]` in app.toml) has a
 *   `latest` above this build's version (`updateAvailable`), or a
 *   `minRecommended` above it (`updateRecommended`); or
 * - the origin now serves another build than the page is running: the page's
 *   build id differs from the `buildId` in `/version.json`, checked on mount,
 *   on each return to the foreground and hourly.
 *
 * Reload reloads the page. Dismiss hides the banner until a new reason
 * appears (a raised `latest` or `minRecommended`, or another served build),
 * across reloads. `updateRequired` shows `AppUpdateGate.vue` instead.
 *
 * To remove it: delete this file and its two lines in src/App.vue (the
 * import and the `<AppUpdateBanner />` tag).
 */
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { Button } from "@/components/ui/button";
import { config } from "@/config/envConfig";
import {
  APP_BUILD_ID,
  BUILD_CHECK_INTERVAL_MS,
  browserStorage,
  dismissalStore,
  isDismissed,
  noticeKind,
  noticeReasons,
  readServedBuildId,
  saveDismissed,
  scheduleBuildChecks,
  watchAppVersion,
  type AppUpdateState,
} from "@/lib/appUpdate";
import { getAppClient } from "@/lib/client";
import { appBaseLogger } from "@/lib/logger";

const logger = appBaseLogger.forScope("AppUpdateBanner");

const state = ref<AppUpdateState | null>(null);
const servedBuildId = ref<string | null>(null);
const store = dismissalStore(config.appId, browserStorage());
// Bumped on each dismissal so `shown` re-reads the store.
const dismissals = ref(0);

const reasons = computed(() =>
  noticeReasons(state.value, APP_BUILD_ID, servedBuildId.value)
);
const shown = computed(() => {
  void dismissals.value;
  return reasons.value.length > 0 && !isDismissed(store, reasons.value);
});
const message = computed(() =>
  noticeKind(reasons.value) === "recommended"
    ? `An update to ${config.appName} is recommended. Reload to get the latest version.`
    : `A new version of ${config.appName} is available.`
);

let unmounted = false;
let stopWatch: (() => void) | null = null;
let stopBuildChecks: (() => void) | null = null;

async function checkServedBuild(): Promise<void> {
  const served = await readServedBuildId((text) => logger.warn(text));
  if (served !== null && !unmounted) servedBuildId.value = served;
}

onMounted(async () => {
  // Without a build id (`vite` dev) there is no version file to compare.
  if (APP_BUILD_ID) {
    stopBuildChecks = scheduleBuildChecks({
      check: () => void checkServedBuild(),
      intervalMs: BUILD_CHECK_INTERVAL_MS,
      target: document,
      visibility: () => document.visibilityState,
    });
  }
  try {
    const client = await getAppClient();
    if (unmounted) return;
    stopWatch = watchAppVersion(client.appVersion, (next) => {
      state.value = next;
    });
  } catch (error) {
    logger.warn("The app version status is not available:", error);
  }
});

onBeforeUnmount(() => {
  unmounted = true;
  stopWatch?.();
  stopBuildChecks?.();
});

function reload(): void {
  window.location.reload();
}

function dismiss(): void {
  saveDismissed(store, reasons.value);
  dismissals.value += 1;
}
</script>

<template>
  <div
    v-if="shown"
    data-testid="app-update-banner"
    role="status"
    class="fixed inset-x-0 bottom-20 z-50 mx-auto flex w-[calc(100%-2rem)] max-w-xl flex-wrap items-center gap-3 rounded-lg border bg-background px-4 py-3 text-sm text-foreground shadow-lg md:bottom-4"
  >
    <p class="min-w-0 flex-1">{{ message }}</p>
    <div class="flex shrink-0 gap-2">
      <Button
        data-testid="app-update-banner-dismiss"
        variant="ghost"
        size="sm"
        @click="dismiss"
      >
        Dismiss
      </Button>
      <Button data-testid="app-update-banner-reload" size="sm" @click="reload">
        Reload
      </Button>
    </div>
  </div>
</template>
