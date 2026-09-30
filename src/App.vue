<script setup lang="ts">
import { useUserStore } from "@/stores/userStore";
import { watch } from "vue";
import { RouterView, useRouter } from "vue-router";

const userStore = useUserStore();
const router = useRouter();

// Handle sign-out events by redirecting to login
// This fires when isAuthenticated changes from true to false
// (either due to explicit logout or auth-failed event)
watch(
  () => userStore.isAuthenticated,
  (isAuth, wasAuth) => {
    if (wasAuth && !isAuth) {
      // A watcher cannot await; a failed redirect surfaces as an unhandled
      // rejection, which is the loud failure wanted here.
      void router.push({ name: "login" });
    }
  }
);
</script>

<template>
  <RouterView />
</template>
