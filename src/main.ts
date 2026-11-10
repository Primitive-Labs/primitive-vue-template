import { createApp } from "vue";
import { createPinia } from "pinia";
import App from "./App.vue";
import router from "./router/routes";
import { config, getJsBaoConfig } from "./config/envConfig";
import { initializeAppClient } from "./lib/client";
import { ensureServiceWorkerControl } from "./serviceWorkerControl";
import { useUserStore } from "./stores/userStore";
import "./style.css";

async function bootstrap() {
  // Register the service worker now: it adds the user's auth to blob
  // downloads, so a blob's `downloadUrl` works as an `<img>` source. The app
  // mounts once it controls the page (or after a short wait), so the first
  // view's images go through it on a first visit too.
  const controlled = ensureServiceWorkerControl();

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
  await controlled;
  app.mount("#app");
}

// Top-level entry: nothing can await it. A failed bootstrap is left to surface
// as an unhandled rejection so a broken start fails loudly.
void bootstrap();
