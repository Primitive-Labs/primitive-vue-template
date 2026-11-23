<script setup lang="ts">
/**
 * The page an emailed sign-in link or an OAuth redirect opens.
 *
 * The client applies the callback grammar and signs the user in
 * (`userStore.handleSignInCallback()`); this page shows what happened. On
 * success it hands off to the shared onboarding route (profile completion +
 * passkey prompt, `PrimitiveOnboarding.vue`) with the continue URL,
 * `isNewUser` and `promptAddPasskey` as query params. Otherwise it shows the
 * waitlist, access-denied, link-expired (with a resend to the address the
 * link carried, from any tab or browser) or error state.
 */
import { AlertTriangle, Clock, Loader2, Lock, Mail } from "@lucide/vue";
import { computed, onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { appBaseLogger } from "@/lib/logger";
import { isIOS } from "@/lib/utils";
import { AUTH_CODES, useUserStore } from "@/stores/userStore";
import { Button } from "../ui/button";
import PrimitiveLogoSpinner from "@/components/shared/PrimitiveLogoSpinner.vue";

type CallbackState =
  | "processing"
  | "waitlisted"
  | "access-denied"
  | "link-expired"
  | "link-resent"
  | "redirecting"
  | "error";

const user = useUserStore();
const router = useRouter();
const logger = appBaseLogger.forScope("PrimitiveSignInCallback");

// State
const callbackState = ref<CallbackState>("processing");
const errorMessage = ref<string | null>(null);
// Where the link would have continued: the resend carries it on.
const continueUrl = ref<string>("/");

// Magic link resend state
const expiredLinkEmail = ref<string | null>(null);
const isResendingLink = ref(false);
const resendError = ref<string | null>(null);

// Access denied state
const accessDeniedMessage = ref<string | null>(null);

// Detect iOS for "Open Mail" button (works in Safari, Chrome, and other iOS browsers)
const showOpenMailButton = computed(() => isIOS());

// Methods
async function handleCallback(): Promise<void> {
  const callbackLogger = logger.forScope("handleCallback");

  try {
    const result = await user.handleSignInCallback();
    callbackLogger.debug("Callback result:", result);
    continueUrl.value = result.continueUrl;

    if (!result.ok) {
      if (result.errorCode === AUTH_CODES.ADDED_TO_WAITLIST) {
        callbackState.value = "waitlisted";
        return;
      }

      if (result.errorCode === AUTH_CODES.INVITATION_REQUIRED) {
        accessDeniedMessage.value =
          "This app is invite-only. You need an invitation to sign in.";
        callbackState.value = "access-denied";
        return;
      }

      if (result.errorCode === AUTH_CODES.DOMAIN_NOT_ALLOWED) {
        accessDeniedMessage.value =
          "You need to sign in with an approved email domain to access this app.";
        callbackState.value = "access-denied";
        return;
      }

      if (result.tokenExpiredOrUsed) {
        expiredLinkEmail.value = result.email ?? null;
        callbackState.value = "link-expired";
        return;
      }

      errorMessage.value = result.errorMessage || "Authentication failed";
      callbackState.value = "error";
      return;
    }

    callbackLogger.debug("Sign-in succeeded; handing off to onboarding", {
      isNewUser: result.isNewUser,
      promptAddPasskey: result.promptAddPasskey,
    });

    // Onboarding (profile completion + passkey prompt) runs on the shared
    // onboarding route so every sign-in method funnels through the same step.
    callbackState.value = "redirecting";
    const query: Record<string, string> = {
      continueURL: result.continueUrl,
      isNewUser: result.isNewUser ? "1" : "0",
    };
    if (result.promptAddPasskey) query.promptAddPasskey = "1";
    // Navigation is fire-and-forget: a blocked route resolves to a navigation
    // failure, and a guard that throws should surface as an unhandled rejection.
    void router.push({ name: "onboarding", query });
  } catch (err: unknown) {
    callbackLogger.error("Callback error:", err);
    errorMessage.value =
      err instanceof Error ? err.message : "An error occurred during sign-in";
    callbackState.value = "error";
  }
}

async function handleResendLink(): Promise<void> {
  if (!expiredLinkEmail.value) {
    goToLogin();
    return;
  }

  const resendLogger = logger.forScope("handleResendLink");
  resendLogger.debug("Resending sign-in email to:", expiredLinkEmail.value);

  isResendingLink.value = true;
  resendError.value = null;

  try {
    // The new link carries the same continue URL, so it lands where the
    // expired one would have.
    await user.requestEmailSignIn(expiredLinkEmail.value, {
      continueUrl: continueUrl.value,
    });
    resendLogger.debug("Sign-in email resent successfully");
    callbackState.value = "link-resent";
  } catch (err: unknown) {
    resendLogger.error("Failed to resend sign-in email:", err);
    resendError.value =
      err instanceof Error ? err.message : "Failed to send link";
  } finally {
    isResendingLink.value = false;
  }
}

function goToLogin(): void {
  void router.push({ name: "login" });
}

// Lifecycle
onMounted(() => {
  void user.loadAuthConfig();
  // handleCallback catches and reports every error itself.
  void handleCallback();
});
</script>

<template>
  <!-- Processing State -->
  <div
    v-if="callbackState === 'processing' || callbackState === 'redirecting'"
    class="min-h-screen flex items-center justify-center"
  >
    <PrimitiveLogoSpinner />
  </div>

  <!-- Waitlisted State -->
  <div
    v-else-if="callbackState === 'waitlisted'"
    class="min-h-screen flex items-center justify-center p-6"
  >
    <div class="w-full max-w-sm space-y-6 text-center">
      <div
        class="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-amber-500/10"
      >
        <Clock class="h-8 w-8 text-amber-500" />
      </div>
      <div class="space-y-2">
        <h1 class="text-2xl font-semibold">You're on the waitlist</h1>
        <p class="text-muted-foreground text-sm">
          We've added you to the waitlist. We'll send you an email when your
          access is approved.
        </p>
      </div>
      <Button @click="goToLogin" variant="outline" class="w-full">
        Back to sign in
      </Button>
    </div>
  </div>

  <!-- Access Denied State (invite required, domain not allowed) -->
  <div
    v-else-if="callbackState === 'access-denied'"
    class="min-h-screen flex items-center justify-center p-6"
  >
    <div class="w-full max-w-sm space-y-6 text-center">
      <div
        class="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-muted"
      >
        <Lock class="h-8 w-8 text-muted-foreground" />
      </div>
      <div class="space-y-2">
        <h1 class="text-2xl font-semibold">Access Denied</h1>
        <p class="text-muted-foreground text-sm">
          {{ accessDeniedMessage }}
        </p>
      </div>
      <Button @click="goToLogin" variant="outline" class="w-full">
        Back to sign in
      </Button>
    </div>
  </div>

  <!-- Link Expired/Used State -->
  <div
    v-else-if="callbackState === 'link-expired'"
    class="min-h-screen flex items-center justify-center p-6"
  >
    <div class="w-full max-w-sm space-y-6 text-center">
      <div
        class="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-amber-500/10"
      >
        <AlertTriangle class="h-8 w-8 text-amber-500" />
      </div>
      <div class="space-y-2">
        <h1 class="text-2xl font-semibold">Link expired</h1>
        <p class="text-muted-foreground text-sm">
          This sign-in link has already been used or has expired.
        </p>
        <p v-if="expiredLinkEmail" class="text-muted-foreground text-sm">
          Send a new link to
          <span class="font-medium text-foreground">{{
            expiredLinkEmail
          }}</span>
        </p>
      </div>

      <!-- Error display -->
      <div
        v-if="resendError"
        class="rounded-md bg-destructive/10 p-3 text-sm text-destructive"
      >
        {{ resendError }}
      </div>

      <!-- Resend button (when we have email) -->
      <Button
        v-if="expiredLinkEmail"
        @click="handleResendLink"
        :disabled="isResendingLink"
        class="w-full"
      >
        <Loader2 v-if="isResendingLink" class="mr-2 h-4 w-4 animate-spin" />
        <Mail v-else class="mr-2 h-4 w-4" />
        {{ isResendingLink ? "Sending..." : "Send new link" }}
      </Button>

      <!-- Fallback to login (when no email) -->
      <Button v-else @click="goToLogin" class="w-full">
        <Mail class="mr-2 h-4 w-4" />
        Back to sign in
      </Button>
    </div>
  </div>

  <!-- Link Resent State -->
  <div
    v-else-if="callbackState === 'link-resent'"
    class="min-h-screen flex items-center justify-center p-6"
  >
    <div class="w-full max-w-sm space-y-6 text-center">
      <div
        class="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-green-500/10"
      >
        <Mail class="h-8 w-8 text-green-500" />
      </div>
      <div class="space-y-2">
        <h1 class="text-2xl font-semibold">Check your email</h1>
        <p class="text-muted-foreground text-sm">
          We've sent a new sign-in link to
          <span class="font-medium text-foreground">{{
            expiredLinkEmail
          }}</span>
        </p>
      </div>
      <Button
        v-if="showOpenMailButton"
        as="a"
        href="message://"
        class="w-full gap-2"
      >
        <Mail class="mr-2 h-4 w-4" />
        Open Mail
      </Button>
      <Button @click="goToLogin" variant="outline" class="w-full">
        Back to sign in
      </Button>
    </div>
  </div>

  <!-- Error State -->
  <div
    v-else-if="callbackState === 'error'"
    class="min-h-screen flex items-center justify-center p-6"
  >
    <div class="w-full max-w-sm space-y-6 text-center">
      <div
        class="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-destructive/10"
      >
        <span class="text-3xl">⚠️</span>
      </div>
      <div class="space-y-2">
        <h1 class="text-xl font-semibold">Something went wrong</h1>
        <p class="text-muted-foreground text-sm">
          {{ errorMessage || "An error occurred during sign-in." }}
        </p>
      </div>
      <Button @click="goToLogin" variant="outline" class="w-full">
        Back to sign in
      </Button>
    </div>
  </div>
</template>
