<script setup lang="ts">
/**
 * Logs the current user out, then goes to the sign-in page.
 *
 * This component is intentionally "headless": it performs the logout side-effect
 * on mount and renders only a loading indicator while the request is in flight.
 */
import { onMounted } from "vue";
import { useRouter } from "vue-router";
import { appBaseLogger } from "@/lib/logger";
import { useUserStore } from "@/stores/userStore";
import PrimitiveLogoSpinner from "@/components/shared/PrimitiveLogoSpinner.vue";

const user = useUserStore();
const router = useRouter();
const logger = appBaseLogger.forScope("PrimitiveLogout");

onMounted(async () => {
  const flowLogger = logger.forScope("onMounted");
  const target = router.resolve({ name: "login" }).href;
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
  <PrimitiveLogoSpinner />
</template>
