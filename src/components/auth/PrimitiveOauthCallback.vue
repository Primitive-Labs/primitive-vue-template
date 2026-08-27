<script setup lang="ts">
/**
 * Handles the OAuth and magic link callback redirect flows.
 *
 * On successful sign-in, new-user onboarding (profile completion + passkey
 * prompt) is delegated to the shared onboarding route so every sign-in method
 * funnels through the same step — see `PrimitiveOnboarding.vue`. This component
 * only handles the callback itself (waitlist, access-denied, expired links,
 * errors) and then hands off.
 */
import { AlertTriangle, Clock, Loader2, Lock, Mail } from "@lucide/vue";
import type { Component } from "vue";
import { computed, onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { getPendingInviteToken } from "@/lib/inviteToken";
import { appBaseLogger } from "@/lib/logger";
import { buildRouteOrUrl, resolveRouteOrUrl } from "@/lib/routeOrUrl";
import { isIOS } from "@/lib/utils";
import { jsBaoClientService } from "primitive-app";
import { AUTH_CODES, useUserStore } from "@/stores/userStore";
import { Button } from "../ui/button";
import PrimitiveLogoSpinner from "@/components/shared/PrimitiveLogoSpinner.vue";

type CallbackState =
  | "processing"
  | "waitlisted"
  | "access-denied"
  | "link-expired"
  | "resending-link"
  | "link-resent"
  | "redirecting"
  | "error";

interface Props {
  /**
   * Absolute/path URL to continue to after successful OAuth callback.
   * Either `continueURL` or `continueRoute` must be provided.
   */
  continueURL?: string;
  /**
   * Named route to continue to after successful OAuth callback.
   * Either `continueURL` or `continueRoute` must be provided.
   */
  continueRoute?: string;
  /**
   * Absolute/path login URL used when redirecting on error.
   * Either `loginUrl` or `loginRoute` must be provided.
   */
  loginUrl?: string;
  /**
   * Named login route used when redirecting on error.
   * Either `loginUrl` or `loginRoute` must be provided.
   */
  loginRoute?: string;
  /**
   * Named onboarding route that runs profile completion + passkey prompt for
   * new users. When set, successful sign-ins are routed here (with the continue
   * URL, `isNewUser`, and `promptAddPasskey` passed as query params) before
   * landing on the continue URL. Either `onboardingRoute` or `onboardingUrl`
   * may be provided; when neither is set, sign-in continues straight to the
   * continue URL with no onboarding.
   */
  onboardingRoute?: string;
  /**
   * Absolute/path onboarding URL. Alternative to `onboardingRoute`.
   */
  onboardingUrl?: string;
  /**
   * Optional loading component to display while handling the OAuth callback.
   * Defaults to `PrimitiveLogoSpinner` when not provided.
   */
  loadingComponent?: Component;
}

const props = defineProps<Props>();

const user = useUserStore();
const router = useRouter();
const logger = appBaseLogger.forScope("PrimitiveOauthCallback");

// State
const callbackState = ref<CallbackState>("processing");
const errorMessage = ref<string | null>(null);
const redirectTo = ref<string>("/");

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
    const continueTarget = buildRouteOrUrl(
      props.continueURL,
      props.continueRoute
    );
    const loginTarget = buildRouteOrUrl(props.loginUrl, props.loginRoute);

    const defaultContinueUrl = resolveRouteOrUrl(router, continueTarget);
    const loginUrl = resolveRouteOrUrl(router, loginTarget);

    callbackLogger.debug("Callback configured URLs:", {
      href: typeof window !== "undefined" ? window.location.href : "",
      defaultContinueUrl,
      loginUrl,
    });

    const result = await user.handleOAuthCallback(defaultContinueUrl, loginUrl);

    callbackLogger.debug("Callback result:", result);

    if (!result.ok) {
      // Check for waitlisted state
      if (
        result.waitlisted ||
        result.errorCode === AUTH_CODES.ADDED_TO_WAITLIST
      ) {
        callbackState.value = "waitlisted";
        return;
      }

      // Check for invitation required (invite-only mode, no waitlist)
      // Detect by error code or by message content
      const msgLower = result.errorMessage?.toLowerCase() || "";
      if (
        result.errorCode === AUTH_CODES.INVITATION_REQUIRED ||
        msgLower.includes("invitation") ||
        msgLower.includes("invite-only") ||
        msgLower.includes("invite only")
      ) {
        accessDeniedMessage.value =
          "This app is invite-only. You need an invitation to sign in.";
        callbackState.value = "access-denied";
        redirectTo.value = result.redirectTo;
        return;
      }

      // Check for domain not allowed
      // Detect by error code or by message content
      if (
        result.errorCode === AUTH_CODES.DOMAIN_NOT_ALLOWED ||
        msgLower.includes("domain") ||
        msgLower.includes("email domain")
      ) {
        accessDeniedMessage.value =
          "You need to sign in with an approved email domain to access this app.";
        callbackState.value = "access-denied";
        redirectTo.value = result.redirectTo;
        return;
      }

      // Check for expired/used magic link token
      if (result.tokenExpiredOrUsed) {
        expiredLinkEmail.value = result.email || null;
        redirectTo.value = result.redirectTo;
        callbackState.value = "link-expired";
        return;
      }

      errorMessage.value = "Authentication failed";
      callbackState.value = "error";
      redirectTo.value = result.redirectTo;
      return;
    }

    redirectTo.value = result.redirectTo;

    callbackLogger.debug("Sign-in succeeded; handing off to onboarding", {
      isNewUser: result.isNewUser,
      promptAddPasskey: result.promptAddPasskey,
    });

    // Onboarding (profile completion + passkey prompt) runs on the shared
    // onboarding route so every sign-in method funnels through the same step.
    goToOnboarding({
      continueUrl: result.redirectTo,
      isNewUser: result.isNewUser ?? false,
      promptAddPasskey: result.promptAddPasskey,
    });
  } catch (err: unknown) {
    callbackLogger.error("Callback error:", err);
    handleError(err);
  }
}

/**
 * Hand off to the shared onboarding route, passing sign-in context as query
 * params (so it survives a refresh). When no onboarding target is configured,
 * continue straight to the app.
 */
function goToOnboarding(opts: {
  continueUrl: string;
  isNewUser: boolean;
  promptAddPasskey?: boolean;
}): void {
  callbackState.value = "redirecting";

  const query: Record<string, string> = {
    continueURL: opts.continueUrl,
    isNewUser: opts.isNewUser ? "1" : "0",
  };
  if (opts.promptAddPasskey) query.promptAddPasskey = "1";

  if (props.onboardingRoute) {
    router.push({ name: props.onboardingRoute, query });
    return;
  }

  if (props.onboardingUrl && typeof window !== "undefined") {
    const url = new URL(props.onboardingUrl, window.location.origin);
    for (const [k, v] of Object.entries(query)) {
      url.searchParams.set(k, v);
    }
    router.push(url.pathname + url.search + url.hash);
    return;
  }

  // No onboarding route configured — continue straight into the app.
  router.push(opts.continueUrl);
}

function handleError(err: unknown): void {
  // Check for specific auth error codes
  if (err && typeof err === "object" && "code" in err) {
    const code = (err as { code: string }).code;

    if (code === AUTH_CODES.ADDED_TO_WAITLIST) {
      callbackState.value = "waitlisted";
      return;
    }

    if (code === AUTH_CODES.INVITATION_REQUIRED) {
      errorMessage.value =
        "This app is invite-only. You need an invitation to sign in.";
      callbackState.value = "error";
      return;
    }

    if (code === AUTH_CODES.DOMAIN_NOT_ALLOWED) {
      errorMessage.value = "Your email domain is not allowed for this app.";
      callbackState.value = "error";
      return;
    }
  }

  errorMessage.value =
    err instanceof Error ? err.message : "An error occurred during sign-in";
  callbackState.value = "error";
}

async function handleResendLink(): Promise<void> {
  if (!expiredLinkEmail.value) {
    goToLogin();
    return;
  }

  const resendLogger = logger.forScope("handleResendLink");
  resendLogger.debug("Resending magic link to:", expiredLinkEmail.value);

  isResendingLink.value = true;
  resendError.value = null;

  try {
    // Get the base redirect URI from js-bao config
    const config = jsBaoClientService.getConfig();
    const baseRedirectUri = config?.oauthRedirectUri;

    if (!baseRedirectUri) {
      throw new Error("Redirect URI not configured");
    }

    // Encode state with email and continue URL (same as login page does)
    // This allows the resend flow to work if this new link also expires.
    // inviteToken is included so a pending invitation survives the resend.
    const inviteToken = getPendingInviteToken();
    const state = btoa(
      JSON.stringify({
        continueUrl: redirectTo.value,
        email: expiredLinkEmail.value,
        ...(inviteToken ? { inviteToken } : {}),
      })
    );
    const separator = baseRedirectUri.includes("?") ? "&" : "?";
    const redirectUriWithState = `${baseRedirectUri}${separator}state=${encodeURIComponent(state)}`;

    await user.requestEmailSignIn(expiredLinkEmail.value, redirectUriWithState);
    resendLogger.debug("Sign-in email resent successfully");
    callbackState.value = "link-resent";
  } catch (err: unknown) {
    resendLogger.error("Failed to resend magic link:", err);
    resendError.value =
      err instanceof Error ? err.message : "Failed to send link";
  } finally {
    isResendingLink.value = false;
  }
}

function goToLogin(): void {
  const loginTarget = buildRouteOrUrl(props.loginUrl, props.loginRoute);
  const loginUrl = resolveRouteOrUrl(router, loginTarget);
  router.push(loginUrl);
}

// Validation helpers
function validateRouteExists(routeName: string, propName: string): boolean {
  try {
    router.resolve({ name: routeName });
    return true;
  } catch {
    logger.error(
      `Invalid ${propName}: route "${routeName}" does not exist. ` +
        `Check that the route is defined in your router configuration.`
    );
    return false;
  }
}

// Lifecycle
onMounted(() => {
  void user.loadAuthConfig();

  // Validate route props early to catch configuration errors
  if (props.continueRoute) {
    validateRouteExists(props.continueRoute, "continueRoute");
  }
  if (props.loginRoute) {
    validateRouteExists(props.loginRoute, "loginRoute");
  }
  if (props.onboardingRoute) {
    validateRouteExists(props.onboardingRoute, "onboardingRoute");
  }

  handleCallback();
});
</script>

<template>
  <!-- Processing State -->
  <div
    v-if="callbackState === 'processing' || callbackState === 'redirecting'"
    class="min-h-screen flex items-center justify-center"
  >
    <component :is="props.loadingComponent || PrimitiveLogoSpinner" />
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
