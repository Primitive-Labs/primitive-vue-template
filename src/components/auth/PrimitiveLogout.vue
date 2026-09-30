<script setup lang="ts">
/**
 * Logs the current user out, then redirects to the configured destination.
 *
 * This component is intentionally "headless": it performs the logout side-effect
 * on mount and renders only a loading indicator while the request is in flight.
 */
import type { Component } from "vue";
import { computed, onMounted } from "vue";
import { useRouter } from "vue-router";
import { appBaseLogger } from "@/lib/logger";
import { buildRouteOrUrl, resolveRouteOrUrl } from "@/lib/routeOrUrl";
import { useUserStore } from "@/stores/userStore";
import PrimitiveLogoSpinner from "@/components/shared/PrimitiveLogoSpinner.vue";

interface Props {
  /**
   * Absolute or path URL to redirect to after logout.
   *
   * Exactly one of `continueURL` or `continueRoute` must be provided.
   * If neither is provided, the component will throw at runtime to
   * force the caller to explicitly choose a logout destination.
   */
  continueURL?: string;
  /**
   * Named route to resolve and redirect to after logout.
   *
   * Exactly one of `continueURL` or `continueRoute` must be provided.
   */
  continueRoute?: string;
  /**
   * Optional loading component to display while logout is in progress.
   * Defaults to `PrimitiveLogoSpinner` when not provided.
   */
  loadingComponent?: Component;
}

const props = defineProps<Props>();
const user = useUserStore();
const router = useRouter();
const logger = appBaseLogger.forScope("PrimitiveLogout");

const continueUrl = computed(() => {
  const target = buildRouteOrUrl(props.continueURL, props.continueRoute);
  return resolveRouteOrUrl(router, target);
});

onMounted(async () => {
  const flowLogger = logger.forScope("onMounted");
  const target = continueUrl.value;
  flowLogger.debug("Starting logout", { continueUrl: target });
  try {
    await user.logout(target);
    flowLogger.debug("Logout request completed");
    await router.push(target);
  } catch (e) {
    flowLogger.error("Logout error", e);
    if (target) {
      try {
        await router.push(target);
      } catch {
        if (typeof window !== "undefined") {
          window.location.href = target;
        }
      }
    }
  }
});
</script>

<template>
  <component :is="props.loadingComponent || PrimitiveLogoSpinner" />
</template>
