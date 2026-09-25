<script setup lang="ts">
/**
 * Default landing page for tokenized invitation URLs (#58).
 *
 * The platform issues invitation links shaped like
 * `${app.baseUrl}/invite/accept?inviteToken=...`. The platform owns the
 * token; the app owns this landing page and decides what the post-accept
 * experience looks like.
 *
 * Flow:
 * - Signed-in: call `client.invitations.accept(token)` and redirect.
 * - Signed-out: stash the token in sessionStorage and route through the
 *   normal login flow. The auth methods in `userStore` then thread the
 *   token through to magicLinkVerify / otpVerify / passkeyRegisterFinish
 *   / startOAuthFlow so the server resolves grants in one round-trip.
 */
import { AlertTriangle, Check, Mail } from "@lucide/vue";
import type { Component } from "vue";
import { computed, onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import {
  clearPendingInviteToken,
  isPlausibleInviteToken,
  setPendingInviteToken,
} from "@/lib/inviteToken";
import { appBaseLogger } from "@/lib/logger";
import { buildRouteOrUrl, resolveRouteOrUrl } from "@/lib/routeOrUrl";
import { jsBaoClientService } from "primitive-app";
import { useUserStore } from "@/stores/userStore";
import { Button } from "@/components/ui/button";
import PrimitiveLogoSpinner from "@/components/shared/PrimitiveLogoSpinner.vue";

type AcceptState =
  | "processing"
  | "confirm"
  | "accepting"
  | "accepted"
  | "needs-signin"
  | "token-missing"
  | "token-invalid"
  | "error";

interface Props {
  /** Absolute or path URL to send the user to after a successful accept. */
  continueURL?: string;
  /** Named route to send the user to after a successful accept. */
  continueRoute?: string;
  /** Absolute or path URL to the app's login page (for signed-out invitees). */
  loginURL?: string;
  /** Named login route (for signed-out invitees). */
  loginRoute?: string;
  /** Optional loading component shown while processing the token. */
  loadingComponent?: Component;
}

const props = defineProps<Props>();

const user = useUserStore();
const router = useRouter();
const route = useRoute();
const logger = appBaseLogger.forScope("InviteAcceptPage");

const acceptState = ref<AcceptState>("processing");
const errorMessage = ref<string | null>(null);
const grantsResolved = ref<{ groups: number; documents: number } | null>(null);
const validatedToken = ref<string | null>(null);

const continueHref = computed(() => {
  const target = buildRouteOrUrl(props.continueURL, props.continueRoute);
  return resolveRouteOrUrl(router, target);
});

const loginHref = computed(() => {
  const target = buildRouteOrUrl(props.loginURL, props.loginRoute);
  return resolveRouteOrUrl(router, target);
});

/** Strip ?inviteToken from the URL bar so it doesn't linger in history. */
function stripTokenFromUrl(): void {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  if (!url.searchParams.has("inviteToken")) return;
  url.searchParams.delete("inviteToken");
  window.history.replaceState(null, "", url.pathname + url.search + url.hash);
}

function continueToApp(): void {
  router.push(continueHref.value);
}

function goToLogin(): void {
  router.push({
    path: loginHref.value,
    query: { continueURL: continueHref.value },
  });
}

async function signOutAndRetry(): Promise<void> {
  // Re-stash the token so the next signup carries it through. Prefer the
  // already-validated token (the URL may have been stripped by now).
  const fallback = route.query.inviteToken;
  const fromUrl = Array.isArray(fallback) ? fallback[0] : fallback;
  const token =
    validatedToken.value ?? (typeof fromUrl === "string" ? fromUrl : null);
  if (token && isPlausibleInviteToken(token)) {
    setPendingInviteToken(token);
  }
  await user.logout();
  router.push({
    path: loginHref.value,
    query: { continueURL: continueHref.value },
  });
}

async function confirmAccept(): Promise<void> {
  const flowLogger = logger.forScope("confirmAccept");
  const token = validatedToken.value;
  if (!token) {
    flowLogger.warn("confirmAccept called without a validated token");
    return;
  }
  acceptState.value = "accepting";
  try {
    const client = await jsBaoClientService.getClientAsync();
    const result = await client.invitations.accept(token);
    flowLogger.debug("Invitation accepted", result);
    grantsResolved.value = result.grantsResolved;
    clearPendingInviteToken();
    acceptState.value = "accepted";
  } catch (err: unknown) {
    flowLogger.error("Invitation accept failed", err);
    const code =
      err && typeof err === "object" && "code" in err
        ? String((err as { code: unknown }).code)
        : undefined;

    // The server answers one code for an invalid, expired or already-redeemed
    // token, so the page cannot (and does not) tell those apart.
    if (code === "INVITE_TOKEN_INVALID") {
      acceptState.value = "token-invalid";
      return;
    }

    errorMessage.value =
      err instanceof Error ? err.message : "Failed to accept invitation";
    acceptState.value = "error";
  }
}

async function handle(): Promise<void> {
  const flowLogger = logger.forScope("handle");
  const tokenParam = route.query.inviteToken;
  const rawToken = Array.isArray(tokenParam) ? tokenParam[0] : tokenParam;

  if (typeof rawToken !== "string" || rawToken.length === 0) {
    flowLogger.debug("No inviteToken in URL");
    acceptState.value = "token-missing";
    return;
  }

  if (!isPlausibleInviteToken(rawToken)) {
    flowLogger.warn("inviteToken failed format validation");
    acceptState.value = "token-invalid";
    stripTokenFromUrl();
    return;
  }

  if (!user.isAuthenticated) {
    flowLogger.debug("User signed out; stashing token, awaiting sign-in");
    setPendingInviteToken(rawToken);
    validatedToken.value = rawToken;
    stripTokenFromUrl();
    acceptState.value = "needs-signin";
    return;
  }

  // Signed-in: confirm with the user before accepting on their behalf so
  // they can switch accounts if the invite was meant for someone else.
  flowLogger.debug("Signed-in user; awaiting confirmation");
  validatedToken.value = rawToken;
  stripTokenFromUrl();
  acceptState.value = "confirm";
}

onMounted(handle);
</script>

<template>
  <component
    v-if="acceptState === 'processing' || acceptState === 'accepting'"
    :is="props.loadingComponent || PrimitiveLogoSpinner"
  />

  <!-- Signed out: invite recognised, prompt to sign in / sign up. -->
  <div
    v-else-if="acceptState === 'needs-signin'"
    class="w-full max-w-sm space-y-6 text-center"
  >
    <div
      class="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-primary/10"
    >
      <Mail class="h-8 w-8 text-primary" />
    </div>
    <div class="space-y-2">
      <h1 class="text-2xl font-semibold">You've been invited</h1>
      <p class="text-muted-foreground text-sm">
        Sign in or create an account to accept your invitation.
      </p>
    </div>
    <Button @click="goToLogin" class="w-full">Sign in or Sign Up</Button>
  </div>

  <!-- Confirm: signed in as X, accept with this account? -->
  <div
    v-else-if="acceptState === 'confirm'"
    class="w-full max-w-sm space-y-6 text-center"
  >
    <div
      class="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-primary/10"
    >
      <Mail class="h-8 w-8 text-primary" />
    </div>
    <div class="space-y-2">
      <h1 class="text-2xl font-semibold">Accept invitation?</h1>
      <p class="text-muted-foreground text-sm">
        You're signed in as
        <span class="font-medium text-foreground">{{
          user.currentUser?.email
        }}</span
        >. Continue with this account, or sign out to use a different one.
      </p>
    </div>
    <div class="flex flex-col gap-2">
      <Button @click="confirmAccept" class="w-full">
        Accept with this account
      </Button>
      <Button @click="signOutAndRetry" variant="outline" class="w-full">
        Sign out and use a different account
      </Button>
    </div>
  </div>

  <!-- Accepted -->
  <div
    v-else-if="acceptState === 'accepted'"
    class="w-full max-w-sm space-y-6 text-center"
  >
    <div
      class="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-green-500/10"
    >
      <Check class="h-8 w-8 text-green-500" />
    </div>
    <div class="space-y-2">
      <h1 class="text-2xl font-semibold">You're in!</h1>
      <p
        v-if="
          grantsResolved && (grantsResolved.groups || grantsResolved.documents)
        "
        class="text-muted-foreground text-sm"
      >
        We've added you to
        <template v-if="grantsResolved.groups">
          {{ grantsResolved.groups }}
          {{ grantsResolved.groups === 1 ? "group" : "groups" }}
        </template>
        <template v-if="grantsResolved.groups && grantsResolved.documents">
          and
        </template>
        <template v-if="grantsResolved.documents">
          {{ grantsResolved.documents }}
          {{ grantsResolved.documents === 1 ? "document" : "documents" }}
        </template>
        .
      </p>
      <p v-else class="text-muted-foreground text-sm">
        Your invitation has been accepted.
      </p>
    </div>
    <Button @click="continueToApp" class="w-full">Continue</Button>
  </div>

  <!-- Token invalid / missing -->
  <div
    v-else-if="
      acceptState === 'token-invalid' || acceptState === 'token-missing'
    "
    class="w-full max-w-sm space-y-6 text-center"
  >
    <div
      class="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-destructive/10"
    >
      <AlertTriangle class="h-8 w-8 text-destructive" />
    </div>
    <div class="space-y-2">
      <h1 class="text-2xl font-semibold">
        {{
          acceptState === "token-missing"
            ? "No invitation found"
            : "Invalid invitation link"
        }}
      </h1>
      <p class="text-muted-foreground text-sm">
        {{
          acceptState === "token-missing"
            ? "We couldn't find an invitation token in this link."
            : "This invitation link is invalid, has expired, or has already been used. If it was meant for a different account, sign out and try the link again; otherwise ask the sender for a new one."
        }}
      </p>
    </div>
    <div class="flex flex-col gap-2">
      <Button @click="continueToApp" variant="outline" class="w-full">
        Continue
      </Button>
      <Button
        v-if="acceptState === 'token-invalid' && user.isAuthenticated"
        @click="signOutAndRetry"
        variant="outline"
        class="w-full"
      >
        Sign out and try again
      </Button>
    </div>
  </div>

  <!-- Generic error -->
  <div
    v-else-if="acceptState === 'error'"
    class="w-full max-w-sm space-y-6 text-center"
  >
    <div
      class="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-destructive/10"
    >
      <AlertTriangle class="h-8 w-8 text-destructive" />
    </div>
    <div class="space-y-2">
      <h1 class="text-xl font-semibold">Something went wrong</h1>
      <p class="text-muted-foreground text-sm">
        {{ errorMessage || "Failed to accept invitation." }}
      </p>
    </div>
    <div class="flex flex-col gap-2">
      <Button @click="handle" class="w-full">Try again</Button>
      <Button @click="continueToApp" variant="outline" class="w-full">
        Back to app
      </Button>
    </div>
  </div>
</template>
