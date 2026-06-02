<script setup lang="ts">
/**
 * Renders the Primitive login form with support for multiple authentication methods.
 *
 * The component resolves a "continue URL" from (in order): the `continueURL`
 * query param, `defaultContinueUrl`, `defaultContinueRoute`, or `/`.
 */
import {
  browserSupportsWebAuthn,
  browserSupportsWebAuthnAutofill,
  startAuthentication,
  WebAuthnAbortService,
} from "@simplewebauthn/browser";
import type { PublicKeyCredentialRequestOptionsJSON } from "@simplewebauthn/types";
import {
  ArrowLeft,
  Clock,
  KeyRound,
  Loader2,
  Lock,
  Mail,
} from "lucide-vue-next";
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { getPendingInviteToken } from "@/lib/inviteToken";
import { appBaseLogger } from "@/lib/logger";
import { isIOS } from "@/lib/utils";
import { jsBaoClientService } from "primitive-app";
import { AUTH_CODES, AuthError, useUserStore } from "@/stores/userStore";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";

/**
 * @componentType
 *
 * Optional links shown under the login button (Terms of Service / Privacy Policy).
 *
 * Provide either an absolute/path URL or a named route for each link.
 */
export interface LoginLinks {
  /**
   * Absolute or path URL to your Terms of Service page.
   */
  termsOfServiceUrl?: string;
  /**
   * Absolute or path URL to your Privacy Policy page.
   */
  privacyPolicyUrl?: string;
  /**
   * Named route to your Terms of Service page (Vue Router).
   */
  termsOfServiceRoute?: string;
  /**
   * Named route to your Privacy Policy page (Vue Router).
   */
  privacyPolicyRoute?: string;
}

type LoginState =
  | "initial"
  | "sending-link"
  | "link-sent"
  | "sending-otp"
  | "otp-code-entry"
  | "verifying-otp"
  | "waitlisted"
  | "error";

/**
 * Email authentication method.
 * - `magic_link`: User receives a clickable link in their email (default)
 * - `one_time_code`: User receives a 6-digit code to enter in the app
 */
type EmailAuthMethod = "magic_link" | "one_time_code";

interface Props {
  /**
   * App name displayed in the sign-in header (e.g., "Sign in to My App").
   */
  appName: string;
  /**
   * Optional Terms of Service / Privacy Policy links displayed under the login button.
   */
  links?: LoginLinks;
  /**
   * Default absolute/path URL to continue to after login when no `continueURL`
   * query parameter is present.
   */
  defaultContinueUrl?: string;
  /**
   * Default named route to continue to after login when no `continueURL` query
   * parameter is present. Used only if `defaultContinueUrl` is not provided.
   */
  defaultContinueRoute?: string;
  /**
   * Which email authentication method to use.
   * - `magic_link` (default): User receives a clickable link in their email
   * - `one_time_code`: User receives a 6-digit code to enter in the app
   */
  emailAuthMethod?: EmailAuthMethod;
}

const props = defineProps<Props>();

const user = useUserStore();
const router = useRouter();
const logger = appBaseLogger.forScope("PrimitiveLogin");

// State
const loginState = ref<LoginState>("initial");
const isLoading = ref(false);
const isGoogleLoading = ref(false);
const error = ref<string | null>(null);
const email = ref("");
const sentEmail = ref("");
const emailInputRef = ref<HTMLInputElement | null>(null);

// OTP state
const otpCode = ref("");
const resendCooldown = ref(0);
let resendTimer: ReturnType<typeof setInterval> | null = null;

// Passkey conditional UI
const supportsPasskeyAutofill = ref(false);

// Computed properties
const authConfig = computed(() => user.authConfig);

/**
 * Determines the effective email auth method to use.
 * Falls back if the requested method isn't enabled.
 */
const effectiveEmailAuthMethod = computed((): EmailAuthMethod | null => {
  const config = authConfig.value;
  if (!config) return null;

  const requested = props.emailAuthMethod ?? "magic_link";

  if (requested === "one_time_code") {
    // OTP requested - use it if enabled, otherwise fall back to magic link
    if (config.otpEnabled) return "one_time_code";
    if (config.magicLinkEnabled) {
      logger.warn("OTP requested but not enabled; falling back to magic link");
      return "magic_link";
    }
    return null;
  }

  // Magic link requested (default)
  if (config.magicLinkEnabled) return "magic_link";
  if (config.otpEnabled) {
    logger.warn("Magic link requested but not enabled; falling back to OTP");
    return "one_time_code";
  }
  return null;
});

const showEmailForm = computed(() => {
  // Show email form if either email auth method is available
  return effectiveEmailAuthMethod.value !== null;
});

const showGoogleButton = computed(() => {
  return authConfig.value?.hasOAuth ?? false;
});

/**
 * Set when the auth config failed to load (e.g. server unreachable, or this
 * app's origin / redirect URI is not registered for the app server-side and
 * the request is rejected by CORS). When set, no sign-in methods are available.
 */
const authConfigError = computed(() => user.authConfigError);

// The origin this app is served from. The browser sends this as the CORS
// `Origin` header on every request to the Primitive server, and the server
// only accepts origins listed in the app's CORS Allowed Origins setting. A
// blocked auth-config request almost always means this origin isn't allowed.
const appOrigin = computed(() => {
  try {
    return window.location.origin;
  } catch {
    return "";
  }
});

// The redirect URI this app is configured with locally (VITE_OAUTH_REDIRECT_URI).
const configuredRedirectUri = computed(
  () => jsBaoClientService.getConfig()?.oauthRedirectUri ?? null
);

const showDivider = computed(() => {
  // Show divider if both email form and Google are available
  return showEmailForm.value && showGoogleButton.value;
});

const isInviteOnly = computed(() => {
  return authConfig.value?.mode === "invite-only";
});

const waitlistEnabled = computed(() => {
  return authConfig.value?.waitlistEnabled ?? false;
});

const continueUrl = computed(() => {
  try {
    const searchParams = new URLSearchParams(window.location.search);
    const fromQuery = searchParams.get("continueURL");
    if (fromQuery) return fromQuery;
  } catch {
    // Ignore query parsing errors and fall through to props-based resolution
  }

  if (props.defaultContinueUrl) {
    return props.defaultContinueUrl;
  }

  if (props.defaultContinueRoute) {
    try {
      const resolved = router.resolve({ name: props.defaultContinueRoute });
      return resolved.href;
    } catch {
      // Error is logged in onMounted validation; fall through to default
    }
  }

  return "/";
});

/**
 * Builds the magic link redirect URI.
 * Uses the same oauthRedirectUri configured for the js-bao client,
 * with the continue URL encoded in a state parameter.
 */
const magicLinkRedirectUri = computed(() => {
  // Get the OAuth redirect URI from the js-bao config
  const config = jsBaoClientService.getConfig();
  const callbackUrl = config?.oauthRedirectUri;

  if (!callbackUrl) {
    // No callback URL configured - magic links won't work
    logger.warn(
      "No oauthRedirectUri configured in js-bao config. Magic links will not work."
    );
    return undefined;
  }

  // Encode continue URL and email in state parameter (base64)
  // Email is included so we can auto-resend if the link expires.
  // inviteToken is included so a pending invitation survives the
  // cross-tab redirect when the user clicks the magic link in email.
  const inviteToken = getPendingInviteToken();
  const state = btoa(
    JSON.stringify({
      continueUrl: continueUrl.value,
      email: email.value,
      ...(inviteToken ? { inviteToken } : {}),
    })
  );
  const separator = callbackUrl.includes("?") ? "&" : "?";
  return `${callbackUrl}${separator}state=${encodeURIComponent(state)}`;
});

const urlError = computed(() => {
  try {
    const searchParams = new URLSearchParams(window.location.search);
    return searchParams.get("error");
  } catch {
    return null;
  }
});

const displayError = computed(() => {
  if (loginState.value === "error") {
    return error.value;
  }
  return urlError.value || error.value;
});

// Email validation
const isValidEmail = computed(() => {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email.value);
});

// Detect iOS for "Open Mail" button (works in Safari, Chrome, and other iOS browsers)
const showOpenMailButton = computed(() => isIOS());

// Methods
function navigate(url?: string, routeName?: string): void {
  if (routeName) {
    router.push({ name: routeName });
  } else if (url) {
    router.push(url);
  }
}

function resetToInitial(): void {
  loginState.value = "initial";
  error.value = null;
  email.value = "";
  sentEmail.value = "";
  otpCode.value = "";
  clearResendTimer();
  // Restart passkey conditional UI if available
  startPasskeyConditionalUI();
}

function clearResendTimer(): void {
  if (resendTimer) {
    clearInterval(resendTimer);
    resendTimer = null;
  }
  resendCooldown.value = 0;
}

function startResendCooldown(seconds: number = 30): void {
  clearResendTimer();
  resendCooldown.value = seconds;
  resendTimer = setInterval(() => {
    resendCooldown.value--;
    if (resendCooldown.value <= 0) {
      clearResendTimer();
    }
  }, 1000);
}

async function handleEmailSubmit(): Promise<void> {
  if (!isValidEmail.value) {
    error.value = "Please enter a valid email address";
    return;
  }

  const method = effectiveEmailAuthMethod.value;
  logger.debug("Submitting email", { email: email.value, method });

  // Cancel any ongoing passkey conditional UI (aborts the pending WebAuthn ceremony)
  WebAuthnAbortService.cancelCeremony();

  if (method === "one_time_code") {
    await handleOtpRequest();
  } else {
    await handleMagicLinkRequest();
  }
}

async function handleMagicLinkRequest(): Promise<void> {
  try {
    loginState.value = "sending-link";
    isLoading.value = true;
    error.value = null;

    await user.requestMagicLink(email.value, magicLinkRedirectUri.value);

    logger.debug("Magic link sent successfully");
    sentEmail.value = email.value;
    loginState.value = "link-sent";
  } catch (e: unknown) {
    handleEmailAuthError(e, "Failed to send sign-in link. Please try again.");
  } finally {
    isLoading.value = false;
  }
}

async function handleOtpRequest(): Promise<void> {
  try {
    loginState.value = "sending-otp";
    isLoading.value = true;
    error.value = null;

    await user.requestOtp(email.value);

    logger.debug("OTP sent successfully");
    sentEmail.value = email.value;
    loginState.value = "otp-code-entry";
    startResendCooldown(30);
  } catch (e: unknown) {
    handleEmailAuthError(e, "Failed to send code. Please try again.");
  } finally {
    isLoading.value = false;
  }
}

async function handleOtpVerify(): Promise<void> {
  if (otpCode.value.length !== 6) {
    error.value = "Please enter the 6-digit code";
    return;
  }

  try {
    loginState.value = "verifying-otp";
    isLoading.value = true;
    error.value = null;

    await user.verifyOtp(sentEmail.value, otpCode.value);

    logger.debug("OTP verified successfully, redirecting");
    router.push(continueUrl.value);
  } catch (e: unknown) {
    logger.error("OTP verification error", e);
    loginState.value = "otp-code-entry";

    if (e instanceof AuthError) {
      if (e.code === "OTP_MAX_ATTEMPTS") {
        error.value = "Too many attempts. Please request a new code.";
        return;
      } else if (e.code === "INVALID_TOKEN") {
        error.value = "Invalid or expired code. Please try again.";
        return;
      } else if (e.code === "RATE_LIMITED") {
        error.value = "Too many attempts. Please wait before trying again.";
        return;
      }
    }

    error.value =
      e instanceof Error ? e.message : "Verification failed. Please try again.";
  } finally {
    isLoading.value = false;
  }
}

async function handleResendOtp(): Promise<void> {
  if (resendCooldown.value > 0) return;

  try {
    isLoading.value = true;
    error.value = null;
    otpCode.value = "";

    await user.requestOtp(sentEmail.value);

    logger.debug("OTP resent successfully");
    startResendCooldown(30);
  } catch (e: unknown) {
    logger.error("OTP resend error", e);

    if (e instanceof AuthError && e.code === "RATE_LIMITED") {
      error.value = "Too many requests. Please wait before trying again.";
    } else {
      error.value = e instanceof Error ? e.message : "Failed to resend code.";
    }
  } finally {
    isLoading.value = false;
  }
}

function handleEmailAuthError(e: unknown, fallbackMessage: string): void {
  logger.error("Email auth error", e);

  if (e instanceof AuthError) {
    if (e.code === AUTH_CODES.ADDED_TO_WAITLIST) {
      sentEmail.value = email.value;
      loginState.value = "waitlisted";
      return;
    } else if (e.code === AUTH_CODES.INVITATION_REQUIRED) {
      error.value =
        "This app is invite-only. You need an invitation to sign in.";
      loginState.value = "error";
      return;
    } else if (e.code === AUTH_CODES.DOMAIN_NOT_ALLOWED) {
      const domain = email.value.split("@")[1] || "your domain";
      error.value = `Email domain @${domain} is not allowed for this app.`;
      loginState.value = "error";
      return;
    } else if (e.code === "OTP_NOT_ENABLED") {
      error.value = "Email code sign-in is not enabled for this app.";
      loginState.value = "error";
      return;
    } else if (e.code === "RATE_LIMITED") {
      error.value = "Too many requests. Please wait before trying again.";
      loginState.value = "error";
      return;
    }
  }

  error.value = e instanceof Error ? e.message : fallbackMessage;
  loginState.value = "error";
}

async function handleGoogleLogin(): Promise<void> {
  logger.debug("Starting Google login", { continueUrl: continueUrl.value });

  try {
    isGoogleLoading.value = true;
    error.value = null;

    // Cancel any ongoing passkey conditional UI
    WebAuthnAbortService.cancelCeremony();

    await user.login(continueUrl.value);
  } catch (e: unknown) {
    logger.error("Google login error", e);
    error.value =
      e instanceof Error
        ? e.message
        : "Failed to initiate login. Please try again.";
    isGoogleLoading.value = false;
  }
}

// Passkey Conditional UI
async function startPasskeyConditionalUI(): Promise<void> {
  const config = authConfig.value;
  if (!config?.hasPasskey) {
    logger.debug("Passkeys not enabled, skipping conditional UI");
    return;
  }

  // Check browser support
  if (!browserSupportsWebAuthn()) {
    logger.debug("Browser does not support WebAuthn");
    return;
  }

  const supportsAutofill = await browserSupportsWebAuthnAutofill();
  supportsPasskeyAutofill.value = supportsAutofill;

  if (!supportsAutofill) {
    logger.debug("Browser does not support WebAuthn autofill");
    return;
  }

  logger.debug("Starting passkey conditional UI");

  try {
    // Get authentication options from server
    const { options, challengeToken } = await user.startPasskeyAuth();

    // Start conditional UI authentication
    const credential = await startAuthentication({
      optionsJSON: options as PublicKeyCredentialRequestOptionsJSON,
      useBrowserAutofill: true,
    });

    logger.debug("Passkey credential received");

    // Complete authentication
    await user.signInWithPasskey(credential, challengeToken);

    logger.debug("Passkey sign-in successful, redirecting");
    router.push(continueUrl.value);
  } catch (e: unknown) {
    // Don't log abort errors - they're expected when user types email instead
    if (e instanceof Error && e.name === "AbortError") {
      logger.debug("Passkey conditional UI aborted");
      return;
    }

    // NotAllowedError is thrown when user cancels or no passkey available
    if (e instanceof Error && e.name === "NotAllowedError") {
      logger.debug("Passkey not available or cancelled");
      return;
    }

    logger.error("Passkey conditional UI error", e);

    // Show error to user - they actively selected a passkey but it failed
    // (e.g., passkey not registered with this app)
    error.value =
      e instanceof Error
        ? e.message
        : "Passkey sign-in failed. Please try again or use another method.";
    loginState.value = "error";
  }
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
  if (props.defaultContinueRoute) {
    validateRouteExists(props.defaultContinueRoute, "defaultContinueRoute");
  }

  // Start passkey conditional UI after auth config is loaded
  if (authConfig.value?.hasPasskey) {
    startPasskeyConditionalUI();
  }
});

// Watch for auth config changes to start passkey conditional UI
watch(
  () => authConfig.value?.hasPasskey,
  (hasPasskey) => {
    if (hasPasskey && loginState.value === "initial") {
      startPasskeyConditionalUI();
    }
  }
);

onUnmounted(() => {
  // Clean up passkey conditional UI
  WebAuthnAbortService.cancelCeremony();
  // Clean up OTP resend timer
  clearResendTimer();
});
</script>

<template>
  <div class="flex flex-col gap-4 p-6 md:p-10 min-h-0 h-full">
    <slot name="header" />

    <div class="flex-1 flex items-center justify-center min-h-0">
      <div class="w-full max-w-xs">
        <!-- Initial State: Login Form -->
        <div
          v-if="loginState === 'initial' || loginState === 'error'"
          class="flex flex-col gap-6"
        >
          <!-- Header -->
          <div class="text-center space-y-1">
            <h1 class="text-2xl font-semibold tracking-tight">
              Sign in to {{ props.appName }}
            </h1>
          </div>

          <!-- Auth config failed to load — the request to the Primitive server
               was blocked, almost always because this app's address isn't in
               the app's CORS "Allowed Origins" on the server. CORS origins and
               OAuth redirect URIs are *separate* server settings; both must
               match how this app is actually served. -->
          <div
            v-if="authConfigError"
            class="rounded-md border border-destructive/30 bg-destructive/10 p-4 text-sm space-y-3"
          >
            <p class="font-medium text-destructive">Sign-in is unavailable</p>
            <p class="text-muted-foreground">
              {{ authConfigError }}
            </p>

            <!-- What this running app is using (local) -->
            <div class="space-y-1 text-xs text-muted-foreground">
              <p class="font-medium text-foreground">This app (local)</p>
              <p class="flex flex-wrap gap-x-1">
                <span class="font-medium">Served from (CORS origin):</span>
                <code class="break-all">{{ appOrigin }}</code>
              </p>
              <p v-if="configuredRedirectUri" class="flex flex-wrap gap-x-1">
                <span class="font-medium">VITE_OAUTH_REDIRECT_URI:</span>
                <code class="break-all">{{ configuredRedirectUri }}</code>
              </p>
            </div>

            <!-- Separate server settings that must match (can't be read here —
                 the request to fetch them was blocked by the same CORS rule) -->
            <div class="space-y-1 text-xs text-muted-foreground">
              <p class="font-medium text-foreground">
                Primitive app (server) — these must match
              </p>
              <ul class="list-disc space-y-1 pl-4">
                <li>
                  <span class="font-medium">CORS Allowed Origins</span> must
                  include <code class="break-all">{{ appOrigin }}</code>
                </li>
                <li>
                  <span class="font-medium">Redirect URIs</span> must include
                  your <code>VITE_OAUTH_REDIRECT_URI</code>
                </li>
              </ul>
              <p>
                These are separate settings. Update them in the
                <a
                  href="https://admin.primitiveapi.com"
                  target="_blank"
                  rel="noopener noreferrer"
                  class="underline underline-offset-2 hover:text-primary"
                >
                  Primitive Console
                </a>
                (or via <code>primitive apps update</code>).
              </p>
            </div>
          </div>

          <!-- Invite-only notice -->
          <div
            v-if="isInviteOnly && showEmailForm"
            class="flex items-start gap-3 rounded-md bg-muted p-4 text-sm text-muted-foreground"
          >
            <Lock class="h-4 w-4 mt-0.5 shrink-0" />
            <p v-if="waitlistEnabled">
              This app is invite-only. If you don't have an invitation, you'll
              be added to the waitlist.
            </p>
            <p v-else>
              This app is invite-only. You'll need an invitation to sign in.
            </p>
          </div>

          <!-- Error display -->
          <div
            v-if="displayError"
            class="rounded-md bg-destructive/10 p-4 text-sm text-destructive"
          >
            {{ displayError }}
          </div>

          <!-- Email form (when magic link or passkey is enabled) -->
          <form
            v-if="showEmailForm"
            @submit.prevent="handleEmailSubmit"
            class="flex flex-col gap-4"
          >
            <div class="space-y-2">
              <Label for="email">Email address</Label>
              <Input
                id="email"
                ref="emailInputRef"
                v-model="email"
                type="email"
                placeholder="you@example.com"
                :autocomplete="
                  authConfig?.hasPasskey ? 'username webauthn' : 'email'
                "
                :disabled="isLoading"
                class="h-12"
              />
            </div>

            <Button
              type="submit"
              :disabled="isLoading || !isValidEmail"
              class="w-full h-12 font-medium"
            >
              <template v-if="isLoading">
                <Loader2 class="animate-spin mr-2 h-4 w-4" />
                Sending...
              </template>
              <template v-else> Continue </template>
            </Button>
          </form>

          <!-- Divider -->
          <div
            v-if="showDivider"
            class="relative flex items-center justify-center"
          >
            <div class="absolute inset-0 flex items-center">
              <div class="w-full border-t border-muted" />
            </div>
            <span
              class="relative bg-background px-4 text-xs text-muted-foreground"
            >
              or
            </span>
          </div>

          <!-- Google sign-in button -->
          <Button
            v-if="showGoogleButton"
            @click="handleGoogleLogin"
            :disabled="isGoogleLoading"
            variant="outline"
            class="w-full h-12 font-medium"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              class="mr-2 h-4 w-4"
            >
              <path
                d="M12.48 10.92v3.28h7.84c-.24 1.84-.853 3.187-1.787 4.133-1.147 1.147-2.933 2.4-6.053 2.4-4.827 0-8.6-3.893-8.6-8.72s3.773-8.72 8.6-8.72c2.6 0 4.507 1.027 5.907 2.347l2.307-2.307C18.747 1.44 16.133 0 12.48 0 5.867 0 .307 5.387.307 12s5.56 12 12.173 12c3.573 0 6.267-1.173 8.373-3.36 2.16-2.16 2.84-5.213 2.84-7.667 0-.76-.053-1.467-.173-2.053H12.48z"
                fill="currentColor"
              />
            </svg>
            {{ isGoogleLoading ? "Redirecting..." : "Sign in with Google" }}
          </Button>

          <!-- No auth methods configured error -->
          <div
            v-if="!showEmailForm && !showGoogleButton && authConfig"
            class="rounded-md bg-destructive/10 p-4 text-sm space-y-2"
          >
            <p class="font-medium text-destructive">
              No authentication methods configured
            </p>
            <p class="text-muted-foreground">
              Update your app settings in the
              <a
                href="https://admin.primitiveapi.com"
                target="_blank"
                rel="noopener noreferrer"
                class="underline underline-offset-2 hover:text-primary"
              >
                Primitive Console
              </a>
              to enable sign-in.
            </p>
          </div>

          <!-- Terms and Privacy links -->
          <div
            v-if="
              props.links &&
              (props.links.termsOfServiceUrl ||
                props.links.privacyPolicyUrl ||
                props.links.termsOfServiceRoute ||
                props.links.privacyPolicyRoute)
            "
            class="text-muted-foreground text-center text-xs text-balance"
          >
            By clicking continue, you agree to our
            <template
              v-if="
                props.links.termsOfServiceUrl || props.links.termsOfServiceRoute
              "
            >
              <a
                href="#"
                @click.prevent="
                  navigate(
                    props.links?.termsOfServiceUrl,
                    props.links?.termsOfServiceRoute
                  )
                "
                class="underline underline-offset-4 hover:text-primary"
              >
                Terms of Service
              </a>
            </template>
            <template
              v-if="
                (props.links.termsOfServiceUrl ||
                  props.links.termsOfServiceRoute) &&
                (props.links.privacyPolicyUrl || props.links.privacyPolicyRoute)
              "
            >
              and
            </template>
            <template
              v-if="
                props.links.privacyPolicyUrl || props.links.privacyPolicyRoute
              "
            >
              <a
                href="#"
                @click.prevent="
                  navigate(
                    props.links?.privacyPolicyUrl,
                    props.links?.privacyPolicyRoute
                  )
                "
                class="underline underline-offset-4 hover:text-primary"
              >
                Privacy Policy
              </a>
            </template>
            .
          </div>
        </div>

        <!-- Link Sent State (Magic Link) -->
        <div
          v-else-if="loginState === 'link-sent'"
          class="flex flex-col items-center gap-6 text-center"
        >
          <div
            class="flex h-16 w-16 items-center justify-center rounded-full bg-primary/10"
          >
            <Mail class="h-8 w-8 text-primary" />
          </div>

          <div class="space-y-2">
            <h2 class="text-xl font-semibold">Check your email</h2>
            <p class="text-muted-foreground text-sm">
              We sent a sign-in link to
              <span class="font-medium text-foreground">{{ sentEmail }}</span>
            </p>
            <p class="text-muted-foreground text-xs">
              Click the link in the email to continue. The link expires in 15
              minutes.
            </p>
          </div>

          <Button
            v-if="showOpenMailButton"
            as="a"
            href="message://"
            class="w-full gap-2"
          >
            <Mail class="h-4 w-4" />
            Open Mail
          </Button>

          <Button
            variant="ghost"
            @click="resetToInitial"
            class="gap-2 text-muted-foreground"
          >
            <ArrowLeft class="h-4 w-4" />
            Back to sign in
          </Button>
        </div>

        <!-- OTP Code Entry State -->
        <div
          v-else-if="loginState === 'otp-code-entry'"
          class="flex flex-col gap-6"
        >
          <div class="flex flex-col items-center gap-4 text-center">
            <div
              class="flex h-16 w-16 items-center justify-center rounded-full bg-primary/10"
            >
              <KeyRound class="h-8 w-8 text-primary" />
            </div>

            <div class="space-y-2">
              <h2 class="text-xl font-semibold">Enter your code</h2>
              <p class="text-muted-foreground text-sm">
                We sent a 6-digit code to
                <span class="font-medium text-foreground">{{ sentEmail }}</span>
              </p>
            </div>
          </div>

          <!-- Error display -->
          <div
            v-if="error"
            class="rounded-md bg-destructive/10 p-4 text-sm text-destructive"
          >
            {{ error }}
          </div>

          <form @submit.prevent="handleOtpVerify" class="flex flex-col gap-4">
            <div class="space-y-2">
              <Label for="otp-code">Verification code</Label>
              <Input
                id="otp-code"
                v-model="otpCode"
                type="text"
                inputmode="numeric"
                pattern="[0-9]*"
                maxlength="6"
                placeholder="000000"
                autocomplete="one-time-code"
                :disabled="isLoading"
                class="h-12 text-center text-lg tracking-widest font-mono"
              />
            </div>

            <Button
              type="submit"
              :disabled="isLoading || otpCode.length !== 6"
              class="w-full h-12 font-medium"
            >
              <template v-if="isLoading">
                <Loader2 class="animate-spin mr-2 h-4 w-4" />
                Verifying...
              </template>
              <template v-else> Verify </template>
            </Button>
          </form>

          <div class="flex flex-col items-center gap-2">
            <Button
              variant="ghost"
              :disabled="resendCooldown > 0 || isLoading"
              @click="handleResendOtp"
              class="text-sm text-muted-foreground"
            >
              <template v-if="resendCooldown > 0">
                Resend code in {{ resendCooldown }}s
              </template>
              <template v-else> Resend code </template>
            </Button>

            <Button
              variant="ghost"
              @click="resetToInitial"
              class="gap-2 text-muted-foreground"
            >
              <ArrowLeft class="h-4 w-4" />
              Back to sign in
            </Button>
          </div>
        </div>

        <!-- Waitlisted State -->
        <div
          v-else-if="loginState === 'waitlisted'"
          class="flex flex-col items-center gap-6 text-center"
        >
          <div
            class="flex h-16 w-16 items-center justify-center rounded-full bg-amber-500/10"
          >
            <Clock class="h-8 w-8 text-amber-500" />
          </div>

          <div class="space-y-2">
            <h2 class="text-xl font-semibold">You're on the waitlist</h2>
            <p class="text-muted-foreground text-sm">
              We've added you to the waitlist for
              <span class="font-medium text-foreground">{{
                props.appName
              }}</span
              >. We'll send you an email when your access is approved.
            </p>
          </div>

          <Button
            variant="ghost"
            @click="resetToInitial"
            class="gap-2 text-muted-foreground"
          >
            <ArrowLeft class="h-4 w-4" />
            Back to sign in
          </Button>
        </div>

        <!-- Sending Link State -->
        <div
          v-else-if="loginState === 'sending-link'"
          class="flex flex-col items-center gap-6 text-center"
        >
          <Loader2 class="animate-spin h-10 w-10 text-primary" />
          <p class="text-muted-foreground">Sending sign-in link...</p>
        </div>

        <!-- Sending OTP State -->
        <div
          v-else-if="loginState === 'sending-otp'"
          class="flex flex-col items-center gap-6 text-center"
        >
          <Loader2 class="animate-spin h-10 w-10 text-primary" />
          <p class="text-muted-foreground">Sending verification code...</p>
        </div>

        <!-- Verifying OTP State -->
        <div
          v-else-if="loginState === 'verifying-otp'"
          class="flex flex-col items-center gap-6 text-center"
        >
          <Loader2 class="animate-spin h-10 w-10 text-primary" />
          <p class="text-muted-foreground">Verifying code...</p>
        </div>
      </div>
    </div>
  </div>
</template>
