/**
 * Register the app's service worker (`public/sw.js`) and wait until it
 * controls the page, so the first view's `<img>` and `<video>` blob
 * downloads go through it and carry the signed-in user's auth.
 *
 * Answers `true` at once when the page is already controlled (every visit
 * after the first). Otherwise it registers the worker and answers `true` on
 * the next `controllerchange`, or `false` once `timeoutMs` has passed. It
 * answers `false` without throwing when the browser has no service workers
 * or registration fails, so the app always mounts.
 *
 * Kept free of imports so tests outside the template can load it.
 */
export async function ensureServiceWorkerControl(
  options: { scriptUrl?: string; timeoutMs?: number } = {}
): Promise<boolean> {
  const { scriptUrl = "/sw.js", timeoutMs = 3000 } = options;
  const container =
    typeof navigator === "undefined"
      ? undefined
      : (navigator.serviceWorker as ServiceWorkerContainer | undefined);
  if (!container) return false;
  if (container.controller) return true;

  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (controlled: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      container.removeEventListener("controllerchange", onControllerChange);
      resolve(controlled);
    };
    const onControllerChange = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    container.addEventListener("controllerchange", onControllerChange);
    const failed = (error: unknown) => {
      console.error("[SW] registration failed", error);
      finish(false);
    };
    try {
      container
        .register(scriptUrl)
        .then(() => {
          if (container.controller) finish(true);
        })
        .catch(failed);
    } catch (error) {
      failed(error);
    }
  });
}
