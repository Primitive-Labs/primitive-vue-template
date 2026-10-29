import { createApp } from "vue";
import { createPinia } from "pinia";
import App from "./App.vue";
import router from "./router/routes";
import { config, getJsBaoConfig } from "./config/envConfig";
import { initializeAppClient } from "./lib/client";
import { useUserStore } from "./stores/userStore";
import "./style.css";

async function bootstrap() {
  // Create Vue app and Pinia
  const app = createApp(App);
  const pinia = createPinia();
  app.use(pinia);

  // The app's client: created on first use from these options
  initializeAppClient(getJsBaoConfig());

  // Initialize user store (handles auth state)
  const userStore = useUserStore();
  await userStore.initialize();

  // Set browser tab title from config
  document.title = config.appName;

  // Install router and mount
  app.use(router);
  app.mount("#app");
}

// Top-level entry: nothing can await it. A failed bootstrap is left to surface
// as an unhandled rejection so a broken start fails loudly.
void bootstrap();

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("/sw.js")
      .catch((err) => console.error("[SW] registration failed", err));
  });
}
