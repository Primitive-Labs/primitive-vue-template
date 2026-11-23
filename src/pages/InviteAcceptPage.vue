<script setup lang="ts">
/**
 * Default landing page for tokenized invitation URLs.
 *
 * The platform issues invitation links shaped like
 * `${app.baseUrl}/invite/accept?inviteToken=...`. The platform owns the
 * token; the app owns this landing page and decides what the post-accept
 * experience looks like.
 *
 * Flow:
 * - The page reads the invitation preview (`client.invitations.preview`) and
 *   shows what the invitation shares.
 * - Signed out: the token is stored as pending and the visitor signs in or
 *   up with this page as the continue URL. The auth methods in `userStore`
 *   send the pending token with the sign-in, so the server accepts the
 *   invitation on the way, and record it as carried.
 * - Back on the page, the carried (or still pending) token decides what to
 *   show: the invitation accepted, or an accept with no second prompt.
 * - Signed in with a link: confirm, or sign out and use another account.
 *
 * The rules live in `@/lib/inviteLanding` so they can be tested without Vue.
 */
import { AlertTriangle, Check, Clock, Mail } from "@lucide/vue";
import { onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import type { InvitationPreview } from "js-bao-wss-client";
import {
  clearCarriedInviteToken,
  clearInviteTokens,
  getCarriedInviteToken,
  getPendingInviteToken,
  setPendingInviteToken,
  settleInviteToken,
} from "@/lib/inviteToken";
import {
  landingStep,
  landingToken,
  type LandingPreview,
  type LandingSource,
  type LandingStep,
} from "@/lib/inviteLanding";
import { getAppClient } from "@/lib/client";
import { appBaseLogger } from "@/lib/logger";
import { useUserStore } from "@/stores/userStore";
import { Button } from "@/components/ui/button";
import PrimitiveLogoSpinner from "@/components/shared/PrimitiveLogoSpinner.vue";

type AcceptState =
  | Exclude<LandingStep, "accept">
  | "processing"
  | "accepting"
  | "accepted"
  | "token-missing"
  | "error";

const user = useUserStore();
const router = useRouter();
const route = useRoute();
const logger = appBaseLogger.forScope("InviteAcceptPage");

const acceptState = ref<AcceptState>("processing");
const errorMessage = ref<string | null>(null);
const grantsResolved = ref<{ groups: number; documents: number } | null>(null);
const preview = ref<InvitationPreview | null>(null);
/** The token the page works from, and where it came from. */
const current = ref<{ token: string; source: LandingSource } | null>(null);

/** Where an accepted invitation continues. */
const continueHref = router.resolve({ name: "home" }).href;
/** This page without a token: where sign-in returns the visitor. */
const returnHref = router.resolve({ name: "invite-accept" }).href;
const signInHref = router.resolve({ name: "login" }).href;

const KIND_LABELS: Record<string, string> = {
  db3: "Database",
  group: "Group",
  collection: "Collection",
};

function errorCode(err: unknown): string | undefined {
  return err && typeof err === "object" && "code" in err
    ? String(err.code)
    : undefined;
}

/** Strip ?inviteToken from the URL bar so it doesn't linger in history. */
function stripTokenFromUrl(): void {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  if (!url.searchParams.has("inviteToken")) return;
  url.searchParams.delete("inviteToken");
  window.history.replaceState(null, "", url.pathname + url.search + url.hash);
}

function continueToApp(): void {
  if (
    acceptState.value === "accepted" ||
    acceptState.value === "accepted-on-return"
  ) {
    clearCarriedInviteToken();
  }
  // Navigation is fire-and-forget: a blocked route resolves to a navigation
  // failure, and a guard that throws should surface as an unhandled rejection.
  void router.push(continueHref);
}

function goToSignIn(): void {
  void router.push({
    path: signInHref,
    query: { continueURL: returnHref },
  });
}

async function signOutAndRetry(): Promise<void> {
  // Store the token as pending (which empties the carried slot) so the next
  // sign-in carries it, then come back here.
  if (current.value) setPendingInviteToken(current.value.token);
  await user.logout();
  goToSignIn();
}

/** Read the preview once; any failure but not-found leaves the page usable. */
async function readPreview(token: string): Promise<LandingPreview> {
  try {
    const client = await getAppClient();
    preview.value = await client.invitations.preview(token);
    return { status: preview.value.status };
  } catch (err: unknown) {
    preview.value = null;
    const code = errorCode(err);
    if (code === "INVITATION_NOT_FOUND") return "not-found";
    logger.warn("Invitation preview unavailable", { code: code ?? "unknown" });
    return "unavailable";
  }
}

async function acceptInvitation(): Promise<void> {
  const flowLogger = logger.forScope("acceptInvitation");
  const token = current.value?.token;
  if (!token) {
    flowLogger.warn("acceptInvitation called without a token");
    return;
  }
  acceptState.value = "accepting";
  try {
    const client = await getAppClient();
    const result = await client.invitations.accept(token);
    flowLogger.debug("Invitation accepted", result.grantsResolved);
    grantsResolved.value = result.grantsResolved;
    // A reload now shows the invitation accepted, not a second accept.
    settleInviteToken(token);
    acceptState.value = "accepted";
  } catch (err: unknown) {
    flowLogger.error("Invitation accept failed", errorCode(err));
    // The server answers one code for an invalid, expired or already-redeemed
    // token, so the page cannot (and does not) tell those apart.
    if (errorCode(err) === "INVITE_TOKEN_INVALID") {
      clearInviteTokens();
      acceptState.value = "token-invalid";
      return;
    }
    errorMessage.value =
      err instanceof Error ? err.message : "Failed to accept invitation";
    acceptState.value = "error";
  }
}

/** Read the preview for the current token and act on what it says. */
async function decide(): Promise<void> {
  const flowLogger = logger.forScope("decide");
  if (!current.value) return;
  const { token, source } = current.value;
  acceptState.value = "processing";
  const step = landingStep({
    source,
    signedIn: user.isAuthenticated,
    preview: await readPreview(token),
  });
  flowLogger.debug("Landing step", { source, step });
  // The URL keeps the token until the preview has answered, so a reload while
  // it loads starts over from the link instead of losing the invitation.
  // `needs-signin` stores the token as pending right after this.
  stripTokenFromUrl();

  switch (step) {
    case "needs-signin":
      setPendingInviteToken(token);
      acceptState.value = "needs-signin";
      return;
    case "accept":
      await acceptInvitation();
      return;
    case "token-invalid":
    case "expired":
    case "already-accepted":
      clearInviteTokens();
      acceptState.value = step;
      return;
    default:
      acceptState.value = step;
  }
}

async function handle(): Promise<void> {
  const flowLogger = logger.forScope("handle");
  const tokenParam = route.query.inviteToken;
  const urlToken = Array.isArray(tokenParam) ? tokenParam[0] : tokenParam;
  const resolved = landingToken({
    urlToken,
    pendingToken: getPendingInviteToken(),
    carriedToken: getCarriedInviteToken(),
  });

  if (resolved === "missing") {
    flowLogger.debug("No invitation token in the URL or the session");
    stripTokenFromUrl();
    acceptState.value = "token-missing";
    return;
  }
  if (resolved === "invalid") {
    flowLogger.warn("inviteToken failed format validation");
    stripTokenFromUrl();
    acceptState.value = "token-invalid";
    return;
  }
  // A link starts a new flow: an earlier invitation's tokens no longer apply.
  if (resolved.source === "url") clearInviteTokens();
  current.value = resolved;
  await decide();
}

onMounted(handle);
</script>

<template>
  <PrimitiveLogoSpinner
    v-if="acceptState === 'processing' || acceptState === 'accepting'"
  />

  <!-- Signed out: invite recognised, prompt to sign in / sign up. -->
  <div
    v-else-if="acceptState === 'needs-signin'"
    class="w-full max-w-sm space-y-6 text-center"
  >
    <div
      class="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-primary/10"
    >
      <img
        v-if="preview?.appIconUrl"
        :src="preview.appIconUrl"
        alt=""
        class="h-10 w-10 rounded"
      />
      <Mail v-else class="h-8 w-8 text-primary" />
    </div>
    <div class="space-y-2">
      <h1 class="text-2xl font-semibold">You've been invited</h1>
      <p v-if="preview" class="text-muted-foreground text-sm">
        <template v-if="preview.inviterName">
          {{ preview.inviterName }} invited you to {{ preview.appName }}.
        </template>
        <template v-else>You're invited to {{ preview.appName }}.</template>
        Sign in or create an account to accept.
      </p>
      <p v-else class="text-muted-foreground text-sm">
        Sign in or create an account to accept your invitation.
      </p>
    </div>
    <div v-if="preview" class="space-y-3 rounded-md border p-4 text-left">
      <ul v-if="preview.shared.length" class="space-y-1 text-sm">
        <li
          v-for="(item, index) in preview.shared"
          :key="index"
          class="flex justify-between gap-2"
        >
          <span class="font-medium">{{ item.title }}</span>
          <span class="text-muted-foreground">
            {{ KIND_LABELS[item.kind] ?? item.kind }} · {{ item.level }}
          </span>
        </li>
        <li v-if="preview.sharedTruncated" class="text-muted-foreground">
          and more
        </li>
      </ul>
      <p class="text-muted-foreground text-xs">
        Sent to {{ preview.maskedEmail }}
      </p>
    </div>
    <Button @click="goToSignIn" class="w-full">Sign in or Sign Up</Button>
  </div>

  <!-- Confirm: signed in as X, accept with this account? -->
  <div
    v-else-if="acceptState === 'confirm'"
    class="w-full max-w-sm space-y-6 text-center"
  >
    <div
      class="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-primary/10"
    >
      <img
        v-if="preview?.appIconUrl"
        :src="preview.appIconUrl"
        alt=""
        class="h-10 w-10 rounded"
      />
      <Mail v-else class="h-8 w-8 text-primary" />
    </div>
    <div v-if="preview" class="space-y-3 rounded-md border p-4 text-left">
      <p class="text-sm">
        <template v-if="preview.inviterName">
          {{ preview.inviterName }} invited you to {{ preview.appName }}.
        </template>
        <template v-else>You're invited to {{ preview.appName }}.</template>
      </p>
      <ul v-if="preview.shared.length" class="space-y-1 text-sm">
        <li
          v-for="(item, index) in preview.shared"
          :key="index"
          class="flex justify-between gap-2"
        >
          <span class="font-medium">{{ item.title }}</span>
          <span class="text-muted-foreground">
            {{ KIND_LABELS[item.kind] ?? item.kind }} · {{ item.level }}
          </span>
        </li>
        <li v-if="preview.sharedTruncated" class="text-muted-foreground">
          and more
        </li>
      </ul>
      <p class="text-muted-foreground text-xs">
        Sent to {{ preview.maskedEmail }}
      </p>
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
      <Button @click="acceptInvitation" class="w-full">
        Accept with this account
      </Button>
      <Button @click="signOutAndRetry" variant="outline" class="w-full">
        Sign out and use a different account
      </Button>
    </div>
  </div>

  <!-- Accepted by this page's own accept call -->
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
      <template v-if="preview && preview.shared.length">
        <p class="text-muted-foreground text-sm">You now have access to:</p>
        <ul class="space-y-1 text-sm">
          <li v-for="(item, index) in preview.shared" :key="index">
            <span class="font-medium">{{ item.title }}</span>
            <span class="text-muted-foreground">
              ({{ KIND_LABELS[item.kind] ?? item.kind }})
            </span>
          </li>
        </ul>
      </template>
      <p
        v-else-if="
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

  <!-- Back from a sign-in that sent the token, invitation accepted -->
  <div
    v-else-if="acceptState === 'accepted-on-return'"
    class="w-full max-w-sm space-y-6 text-center"
  >
    <div
      class="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-green-500/10"
    >
      <Check class="h-8 w-8 text-green-500" />
    </div>
    <div class="space-y-2">
      <h1 class="text-2xl font-semibold">Invitation accepted</h1>
      <template v-if="preview && preview.shared.length">
        <p class="text-muted-foreground text-sm">This invitation shares:</p>
        <ul class="space-y-1 text-sm">
          <li v-for="(item, index) in preview.shared" :key="index">
            <span class="font-medium">{{ item.title }}</span>
            <span class="text-muted-foreground">
              ({{ KIND_LABELS[item.kind] ?? item.kind }})
            </span>
          </li>
        </ul>
      </template>
      <p class="text-muted-foreground text-sm">
        If you can't find what was shared, ask the sender for a new invitation.
      </p>
    </div>
    <Button @click="continueToApp" class="w-full">Continue</Button>
  </div>

  <!-- Already accepted, by whoever opened it before -->
  <div
    v-else-if="acceptState === 'already-accepted'"
    class="w-full max-w-sm space-y-6 text-center"
  >
    <div
      class="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-primary/10"
    >
      <Check class="h-8 w-8 text-primary" />
    </div>
    <div class="space-y-2">
      <h1 class="text-2xl font-semibold">Invitation already accepted</h1>
      <p class="text-muted-foreground text-sm">
        This invitation has already been accepted. If it was meant for you and
        you can't find what was shared, ask the sender for a new one.
      </p>
    </div>
    <Button @click="continueToApp" class="w-full">Continue</Button>
  </div>

  <!-- The preview could not be read on return; never accept twice -->
  <div
    v-else-if="acceptState === 'unconfirmed'"
    class="w-full max-w-sm space-y-6 text-center"
  >
    <div
      class="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-primary/10"
    >
      <Mail class="h-8 w-8 text-primary" />
    </div>
    <div class="space-y-2">
      <h1 class="text-2xl font-semibold">
        We couldn't confirm your invitation
      </h1>
      <p class="text-muted-foreground text-sm">
        You're signed in, but we couldn't check the invitation just now. Try
        again in a moment.
      </p>
    </div>
    <div class="flex flex-col gap-2">
      <Button @click="decide" class="w-full">Try again</Button>
      <Button @click="continueToApp" variant="outline" class="w-full">
        Continue
      </Button>
    </div>
  </div>

  <!-- Expired -->
  <div
    v-else-if="acceptState === 'expired'"
    class="w-full max-w-sm space-y-6 text-center"
  >
    <div
      class="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-destructive/10"
    >
      <Clock class="h-8 w-8 text-destructive" />
    </div>
    <div class="space-y-2">
      <h1 class="text-2xl font-semibold">Invitation expired</h1>
      <p class="text-muted-foreground text-sm">
        This invitation has expired. Ask the sender for a new one.
      </p>
    </div>
    <Button @click="continueToApp" variant="outline" class="w-full">
      Continue
    </Button>
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
            : "This invitation link is invalid or has already been used. If it was meant for a different account, sign out and try the link again; otherwise ask the sender for a new one."
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
      <Button @click="decide" class="w-full">Try again</Button>
      <Button @click="continueToApp" variant="outline" class="w-full">
        Back to app
      </Button>
    </div>
  </div>
</template>
