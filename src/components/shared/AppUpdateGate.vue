<script setup lang="ts">
/**
 * AppUpdateGate — stops an unsupported build from being used.
 *
 * It covers the whole screen while the client's version status is
 * `updateRequired`: the app's `[clients.web]` policy has a `minRequired`
 * above this build's version, or the server refused this build. It has one
 * Reload button and cannot be dismissed; it goes away by itself when the
 * status moves off `updateRequired`.
 *
 * While it shows, everything else at the top of `<body>` is made `inert`
 * (the app under `#app` and any open dialog or sheet, including one that
 * opens later), so nothing behind it can be clicked or reached with the
 * keyboard, and focus stays on its Reload button. Only the `inert` it set is
 * removed when it goes.
 *
 * To remove it: delete this file and its two lines in src/App.vue (the
 * import and the `<AppUpdateGate />` tag).
 */
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { buttonVariants } from "@/components/ui/button";
import { config } from "@/config/envConfig";
import { watchAppVersion } from "@/lib/appUpdate";
import { getAppClient } from "@/lib/client";
import { appBaseLogger } from "@/lib/logger";

const logger = appBaseLogger.forScope("AppUpdateGate");

const shown = ref(false);
const overlay = ref<HTMLElement | null>(null);
const reloadButton = ref<HTMLButtonElement | null>(null);

let unmounted = false;
let stopWatch: (() => void) | null = null;

// The body children this gate made inert, and the observer that covers
// children added while it shows.
const madeInert = new Set<Element>();
let observer: MutationObserver | null = null;
const SKIPPED_TAGS = new Set([
  "SCRIPT",
  "STYLE",
  "TEMPLATE",
  "LINK",
  "NOSCRIPT",
]);

function cover(element: Element): void {
  if (element === overlay.value || SKIPPED_TAGS.has(element.tagName)) return;
  if (element.hasAttribute("inert")) return;
  element.setAttribute("inert", "");
  madeInert.add(element);
}

function focusReload(): void {
  reloadButton.value?.focus();
}

// No key reaches a handler behind the gate. `inert` does not stop listeners
// on window or document, such as a dialog's Escape or the sidebar's Ctrl/Cmd+B.
// Stopping propagation leaves the browser's default action alone, so Enter
// and Space still press the focused Reload button. Tab keeps focus on Reload,
// the gate's only control.
function onKey(event: KeyboardEvent): void {
  event.stopImmediatePropagation();
  if (event.type === "keydown" && event.key === "Tab") {
    event.preventDefault();
    focusReload();
  }
}

const KEY_EVENTS = ["keydown", "keyup", "keypress"] as const;

function onFocusIn(event: FocusEvent): void {
  const target = event.target as Node | null;
  if (overlay.value && target && !overlay.value.contains(target)) focusReload();
}

// A press on the gate's backdrop would move focus to <body>; keep it here.
function onMouseDown(event: MouseEvent): void {
  if (event.target !== reloadButton.value) event.preventDefault();
}

// Focus that leaves the gate for nowhere (or for anything else) comes back.
function onFocusOut(event: FocusEvent): void {
  const next = event.relatedTarget as Node | null;
  if (next && overlay.value?.contains(next)) return;
  setTimeout(() => {
    if (shown.value && !unmounted) focusReload();
  }, 0);
}

function isolate(): void {
  for (const child of Array.from(document.body.children)) cover(child);
  observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of Array.from(record.addedNodes)) {
        if (node instanceof Element) cover(node);
      }
    }
  });
  observer.observe(document.body, { childList: true });
  for (const type of KEY_EVENTS) window.addEventListener(type, onKey, true);
  document.addEventListener("focusin", onFocusIn, true);
  focusReload();
}

// One cleanup for hiding and unmounting.
function release(): void {
  observer?.disconnect();
  observer = null;
  for (const type of KEY_EVENTS) window.removeEventListener(type, onKey, true);
  document.removeEventListener("focusin", onFocusIn, true);
  for (const element of madeInert) element.removeAttribute("inert");
  madeInert.clear();
}

watch(shown, async (now) => {
  if (!now) {
    release();
    return;
  }
  await nextTick();
  if (shown.value && !unmounted && !observer) isolate();
});

onMounted(async () => {
  try {
    const client = await getAppClient();
    if (unmounted) return;
    stopWatch = watchAppVersion(client.appVersion, (state) => {
      shown.value = state.status === "updateRequired";
    });
  } catch (error) {
    logger.warn("The app version status is not available:", error);
  }
});

onBeforeUnmount(() => {
  unmounted = true;
  stopWatch?.();
  release();
});

function reload(): void {
  window.location.reload();
}
</script>

<template>
  <Teleport to="body">
    <!-- pointer-events-auto: an open modal dialog sets pointer-events: none on body. -->
    <div
      v-if="shown"
      ref="overlay"
      data-testid="app-update-gate"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="app-update-gate-title"
      aria-describedby="app-update-gate-text"
      class="pointer-events-auto fixed inset-0 z-[1000] flex items-center justify-center bg-background p-6 text-foreground"
      @pointerdown.stop
      @mousedown="onMouseDown"
      @focusin.stop
      @focusout="onFocusOut"
    >
      <div class="flex max-w-md flex-col items-center gap-4 text-center">
        <h2 id="app-update-gate-title" class="text-xl font-semibold">
          Update required
        </h2>
        <p id="app-update-gate-text" class="text-muted-foreground">
          This version of {{ config.appName }} is no longer supported. Reload to
          get the latest version.
        </p>
        <button
          ref="reloadButton"
          type="button"
          data-testid="app-update-gate-reload"
          :class="buttonVariants()"
          @click="reload"
        >
          Reload
        </button>
      </div>
    </div>
  </Teleport>
</template>
