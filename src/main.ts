import { createApp } from "vue";
import { createPinia } from "pinia";
import App from "./App.vue";
import router from "./router/routes";
import { config, getJsBaoConfig, loadIdentity } from "./config/envConfig";
import { HostedConfigError, hostedFailureMessage } from "./config/hostedConfig";
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
  // The app's identity. A hosted build fetches it from the origin, beside the
  // service worker's wait rather than after it; any other build has it already.
  const identity = loadIdentity();

  try {
    await identity;
  } catch (error) {
    showStartupFailure(error);
    return;
  }

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

/**
 * A hosted build opened on an origin that does not serve its identity: say
 * so on the page, as text, and stop before any API request.
 */
function showStartupFailure(error: unknown): void {
  const reason =
    error instanceof HostedConfigError ? error.reason : String(error);
  console.error(`[primitive] hosted config: ${reason}`);
  const root = document.getElementById("app");
  if (root) {
    root.style.cssText =
      "max-width: 40rem; margin: 4rem auto; padding: 0 1rem; font: 16px/1.5 system-ui, sans-serif; white-space: pre-wrap;";
    root.textContent = hostedFailureMessage(error);
  }
}

// Top-level entry: nothing can await it. A failed bootstrap is left to surface
// as an unhandled rejection so a broken start fails loudly.
void bootstrap();
