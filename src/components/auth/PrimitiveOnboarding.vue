<script setup lang="ts">
/**
 * Shared post-sign-in onboarding step.
 *
 * Every sign-in method (OAuth, magic link, OTP, passkey) funnels new users
 * through this route before the continue URL, so profile completion (name /
 * avatar) and the "add a passkey" prompt run consistently regardless of how
 * the user signed in.
 *
 * The user is already authenticated by the time they reach here — the route
 * requires sign-in, so the router guard sends signed-out visitors to login.
 * Sign-in context is passed via query params so it survives a page refresh:
 *   - `continueURL`      where to go once onboarding is complete
 *   - `isNewUser`        "1" if this is the user's first sign-in
 *   - `promptAddPasskey` "1" if the server asked us to prompt for a passkey
 */
import { startRegistration } from "@simplewebauthn/browser";
import type { PublicKeyCredentialCreationOptionsJSON } from "@simplewebauthn/browser";
import { Camera, Key, Loader2, User, X } from "@lucide/vue";
import type { Component } from "vue";
import { computed, onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { appBaseLogger } from "@/lib/logger";
import { useUserStore } from "@/stores/userStore";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import PrimitiveLogoSpinner from "@/components/shared/PrimitiveLogoSpinner.vue";

type OnboardingState =
  | "processing"
  | "profile-completion"
  | "passkey-prompt"
  | "passkey-registering"
  | "passkey-success"
  | "passkey-error"
  | "redirecting";

interface Props {
  /**
   * Absolute/path URL to continue to when onboarding is complete. Used only as
   * a fallback when no `continueURL` query param is present.
   * Either `continueURL` or `continueRoute` should be provided.
   */
  continueURL?: string;
  /**
   * Named route to continue to when onboarding is complete. Used only as a
   * fallback when no `continueURL` query param is present.
   * Either `continueURL` or `continueRoute` should be provided.
   */
  continueRoute?: string;
  /**
   * Optional loading component to display while onboarding is processing.
   * Defaults to `PrimitiveLogoSpinner` when not provided.
   */
  loadingComponent?: Component;

  // Profile completion options
  /**
   * Whether to show the name field if user.name is blank.
   * @default true
   */
  requestName?: boolean;
  /**
   * Whether name is required before continuing.
   * @default false
   */
  requireName?: boolean;
  /**
   * Whether to show the avatar field if user.avatarUrl is blank.
   * @default true
   */
  requestAvatar?: boolean;
  /**
   * Whether avatar is required before continuing.
   * @default false
   */
  requireAvatar?: boolean;

  // Passkey prompt options
  /**
   * Whether to prompt user to add a passkey if they have none.
   * @default true
   */
  promptForPasskey?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  promptForPasskey: true,
  requestName: true,
  requireName: false,
  requestAvatar: true,
  requireAvatar: false,
});

const user = useUserStore();
const router = useRouter();
const route = useRoute();
const logger = appBaseLogger.forScope("PrimitiveOnboarding");

// Profile config from props
const effectiveConfig = computed(() => ({
  requestName: props.requestName,
  requireName: props.requireName,
  requestAvatar: props.requestAvatar,
  requireAvatar: props.requireAvatar,
}));

// State
const onboardingState = ref<OnboardingState>("processing");
const isNewUser = ref(false);
// Server signal (via query param) that a passkey prompt is warranted.
const promptAddPasskey = ref(false);

// Profile completion state
const userName = ref("");
const userAvatarFile = ref<File | null>(null);
const userAvatarPreview = ref<string | null>(null);
const isProfileSaving = ref(false);
const profileError = ref<string | null>(null);

// Passkey state
const passkeyDeviceName = ref("");
const passkeyError = ref<string | null>(null);

// Computed
const authConfig = computed(() => user.authConfig);

/**
 * Where to send the user once onboarding is complete. Prefers the
 * `continueURL` query param (set by the sign-in method that routed here),
 * then the `continueURL` / `continueRoute` props, then "/".
 */
const redirectTo = computed(() => {
  const fromQuery = route.query.continueURL;
  if (typeof fromQuery === "string" && fromQuery.length > 0) {
    return fromQuery;
  }
  if (props.continueURL) {
    return props.continueURL;
  }
  if (props.continueRoute) {
    try {
      return router.resolve({ name: props.continueRoute }).href;
    } catch {
      // Error is logged in onMounted validation; fall through to default
    }
  }
  return "/";
});

/**
 * Check if profile completion form should be shown.
 * @param forNewUser - Whether this is a new user (passed explicitly to avoid reactivity timing issues)
 */
function checkNeedsProfileCompletion(forNewUser: boolean): boolean {
  const currentUser = user.currentUser;
  const config = effectiveConfig.value;

  if (!currentUser) {
    return false;
  }

  // Only show profile completion for new users, not returning users with missing fields
  if (!forNewUser) {
    return false;
  }

  // For new users: show if ANY profile field is configured
  return config.requestName || config.requestAvatar;
}

const canContinueProfile = computed(() => {
  const currentUser = user.currentUser;

  // Check name requirement
  const nameBlank = !currentUser?.name || currentUser.name.trim() === "";
  if (
    effectiveConfig.value.requireName &&
    nameBlank &&
    !userName.value.trim()
  ) {
    return false;
  }

  // Check avatar requirement
  const avatarBlank = !currentUser?.avatarUrl;
  if (
    effectiveConfig.value.requireAvatar &&
    avatarBlank &&
    !userAvatarFile.value
  ) {
    return false;
  }

  return true;
});

// Computed to check if we should show the name field
const showNameField = computed(() => {
  if (!effectiveConfig.value.requestName) return false;
  // For new users, always show the name field so they can customize it
  if (isNewUser.value) return true;
  // For existing users, only show if blank
  const currentUser = user.currentUser;
  return !currentUser?.name || currentUser.name.trim() === "";
});

// Computed to check if we should show the avatar field
const showAvatarField = computed(() => {
  if (!effectiveConfig.value.requestAvatar) return false;
  // For new users, always show the avatar field so they can set it
  if (isNewUser.value) return true;
  // For existing users, only show if blank
  const currentUser = user.currentUser;
  return !currentUser?.avatarUrl;
});

// Methods
async function runOnboarding(): Promise<void> {
  const onboardingLogger = logger.forScope("runOnboarding");

  try {
    // Ensure auth config is loaded before we consult hasPasskey below.
    await user.loadAuthConfig();

    const newUserFlag = route.query.isNewUser === "1";
    isNewUser.value = newUserFlag;
    promptAddPasskey.value = route.query.promptAddPasskey === "1";

    onboardingLogger.debug("Onboarding starting", {
      isNewUser: newUserFlag,
      promptAddPasskey: promptAddPasskey.value,
      hasCurrentUser: !!user.currentUser,
    });

    // The route requires sign-in, so this should always hold. Bail out safely
    // (straight to the continue URL) rather than trap the user if it doesn't.
    if (!user.isAuthenticated || !user.currentUser) {
      onboardingLogger.warn("Not authenticated in onboarding; skipping");
      finish();
      return;
    }

    // STEP 1: Profile completion always comes before the passkey prompt.
    const needsProfile = checkNeedsProfileCompletion(newUserFlag);
    if (needsProfile) {
      onboardingLogger.debug("Profile completion needed - showing form");
      // For new users, start with blank name so they can enter their preferred
      // display name. For existing users, pre-fill with their current name.
      userName.value = newUserFlag ? "" : user.currentUser?.name || "";
      passkeyDeviceName.value = user.getSuggestedDeviceName();
      onboardingState.value = "profile-completion";
      return;
    }

    // STEP 2: Passkey prompt (only after profile completion is done).
    const shouldPromptPasskey = await checkShouldPromptPasskey(
      promptAddPasskey.value
    );
    if (shouldPromptPasskey) {
      onboardingLogger.debug("Passkey prompt needed - showing prompt");
      passkeyDeviceName.value = user.getSuggestedDeviceName();
      onboardingState.value = "passkey-prompt";
      return;
    }

    // Nothing to do; continue into the app.
    finish();
  } catch (err: unknown) {
    // Onboarding is best-effort — never trap the user here. Log and continue.
    onboardingLogger.error("Onboarding error:", err);
    finish();
  }
}

function finish(): void {
  onboardingState.value = "redirecting";
  // Navigation is fire-and-forget: a blocked route resolves to a navigation
  // failure, and a guard that throws should surface as an unhandled rejection.
  void router.push(redirectTo.value);
}

async function checkShouldPromptPasskey(
  serverPromptAddPasskey?: boolean
): Promise<boolean> {
  if (!props.promptForPasskey) return false;
  if (!authConfig.value?.hasPasskey) return false;

  // Only prompt new users - returning users who skipped won't be prompted again
  if (!isNewUser.value) return false;

  // If the server explicitly says to prompt
  if (serverPromptAddPasskey) return true;

  // Otherwise, check if user has any passkeys
  try {
    const passkeys = await user.listPasskeys();
    return passkeys.length === 0;
  } catch (e) {
    logger.warn("Failed to check passkeys:", e);
    return false;
  }
}

async function handleProfileSubmit(): Promise<void> {
  const profileLogger = logger.forScope("handleProfileSubmit");

  if (!canContinueProfile.value) return;

  profileLogger.debug("Submitting profile", {
    name: userName.value,
    hasAvatar: !!userAvatarFile.value,
  });

  isProfileSaving.value = true;
  profileError.value = null;

  try {
    // Upload avatar first if provided
    if (userAvatarFile.value) {
      profileLogger.debug("Uploading avatar...");
      const contentType = getAvatarContentType(userAvatarFile.value.type);
      if (!contentType) {
        throw new Error(
          "Unsupported image format. Please use PNG, JPEG, GIF, or WebP."
        );
      }
      await user.uploadAvatar(userAvatarFile.value, contentType);
      profileLogger.debug("Avatar uploaded successfully");
    }

    // Update name if provided and changed
    if (userName.value.trim()) {
      profileLogger.debug("Updating profile name...");
      await user.updateProfile({ name: userName.value.trim() });
      profileLogger.debug("Profile name updated successfully");
    }

    // Check if we should prompt for passkey
    const shouldPromptPasskey = await checkShouldPromptPasskey(
      promptAddPasskey.value
    );
    if (shouldPromptPasskey) {
      profileLogger.debug("Passkey prompt needed after profile");
      onboardingState.value = "passkey-prompt";
      return;
    }

    // All done, redirect
    finish();
  } catch (err: unknown) {
    profileLogger.error("Profile save error:", err);
    profileError.value =
      err instanceof Error ? err.message : "Failed to save profile";
  } finally {
    isProfileSaving.value = false;
  }
}

/**
 * Get the content type for avatar upload from the file's MIME type.
 */
function getAvatarContentType(
  mimeType: string
): "image/png" | "image/jpeg" | "image/gif" | "image/webp" | null {
  const validTypes = ["image/png", "image/jpeg", "image/gif", "image/webp"];
  if (validTypes.includes(mimeType)) {
    return mimeType as "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  }
  return null;
}

/**
 * Handle avatar file selection.
 */
function handleAvatarSelect(event: Event): void {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];

  if (!file) return;

  // Validate file type
  const contentType = getAvatarContentType(file.type);
  if (!contentType) {
    profileError.value =
      "Unsupported image format. Please use PNG, JPEG, GIF, or WebP.";
    return;
  }

  // Validate file size (max 20MB - will be auto-resized to fit server limit)
  const maxSize = 20 * 1024 * 1024;
  if (file.size > maxSize) {
    profileError.value = "Image is too large. Maximum size is 20MB.";
    return;
  }

  profileError.value = null;
  userAvatarFile.value = file;

  // Create preview URL
  if (userAvatarPreview.value) {
    URL.revokeObjectURL(userAvatarPreview.value);
  }
  userAvatarPreview.value = URL.createObjectURL(file);
}

/**
 * Clear the selected avatar.
 */
function clearAvatarSelection(): void {
  userAvatarFile.value = null;
  if (userAvatarPreview.value) {
    URL.revokeObjectURL(userAvatarPreview.value);
    userAvatarPreview.value = null;
  }
}

async function handleAddPasskey(): Promise<void> {
  const passkeyLogger = logger.forScope("handleAddPasskey");

  passkeyLogger.debug("Starting passkey registration", {
    deviceName: passkeyDeviceName.value,
  });

  onboardingState.value = "passkey-registering";
  passkeyError.value = null;

  try {
    // Get registration options
    const { options, challengeToken } = await user.startPasskeyRegistration();

    // Start WebAuthn registration
    const credential = await startRegistration({
      optionsJSON: options as PublicKeyCredentialCreationOptionsJSON,
    });

    // Complete registration
    await user.registerPasskey(
      credential,
      challengeToken,
      passkeyDeviceName.value || undefined
    );

    passkeyLogger.debug("Passkey registered successfully");
    onboardingState.value = "passkey-success";

    // Brief success message, then redirect
    setTimeout(() => {
      finish();
    }, 1500);
  } catch (err: unknown) {
    passkeyLogger.error("Passkey registration error:", err);

    // Handle user cancellation
    if (err instanceof Error && err.name === "NotAllowedError") {
      passkeyError.value = "Passkey setup was cancelled";
      onboardingState.value = "passkey-error";
      return;
    }

    // Handle not supported
    if (err instanceof Error && err.name === "NotSupportedError") {
      passkeyError.value = "Passkeys aren't supported on this device";
      onboardingState.value = "passkey-error";
      return;
    }

    passkeyError.value =
      err instanceof Error ? err.message : "Something went wrong. Try again?";
    onboardingState.value = "passkey-error";
  }
}

function skipPasskey(): void {
  logger.debug("User skipped passkey setup");
  finish();
}

function retryPasskey(): void {
  onboardingState.value = "passkey-prompt";
  passkeyError.value = null;
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
  // Validate route props early to catch configuration errors
  if (props.continueRoute) {
    validateRouteExists(props.continueRoute, "continueRoute");
  }

  // runOnboarding catches every error itself and finishes to the continue URL.
  void runOnboarding();
});
</script>

<template>
  <!-- Processing / Redirecting State -->
  <div
    v-if="onboardingState === 'processing' || onboardingState === 'redirecting'"
    class="min-h-screen flex items-center justify-center"
  >
    <component :is="props.loadingComponent || PrimitiveLogoSpinner" />
  </div>

  <!-- Profile Completion State -->
  <div
    v-else-if="onboardingState === 'profile-completion'"
    class="min-h-screen flex items-center justify-center p-6"
  >
    <div class="w-full max-w-sm space-y-6">
      <div class="text-center space-y-2">
        <div
          class="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-primary/10"
        >
          <User class="h-8 w-8 text-primary" />
        </div>
        <h1 class="text-2xl font-semibold">
          Welcome! Let's set up your profile
        </h1>
      </div>

      <form @submit.prevent="handleProfileSubmit" class="space-y-4">
        <!-- Name field -->
        <div v-if="showNameField" class="space-y-2">
          <Label for="name">
            Your name
            <span v-if="effectiveConfig.requireName" class="text-destructive"
              >*</span
            >
          </Label>
          <Input
            id="name"
            v-model="userName"
            type="text"
            placeholder="Enter your name"
            :disabled="isProfileSaving"
            class="h-12"
            autofocus
          />
        </div>

        <!-- Profile picture field -->
        <div v-if="showAvatarField" class="space-y-2">
          <Label>
            Profile picture
            <span v-if="effectiveConfig.requireAvatar" class="text-destructive"
              >*</span
            >
            <span v-else class="text-muted-foreground text-sm">(optional)</span>
          </Label>
          <div class="flex items-center gap-4">
            <!-- Avatar preview or placeholder -->
            <div class="relative">
              <div
                v-if="userAvatarPreview"
                class="h-16 w-16 rounded-full overflow-hidden"
              >
                <img
                  :src="userAvatarPreview"
                  alt="Avatar preview"
                  class="h-full w-full object-cover"
                />
              </div>
              <div
                v-else
                class="h-16 w-16 rounded-full bg-muted flex items-center justify-center"
              >
                <Camera class="h-6 w-6 text-muted-foreground" />
              </div>
              <!-- Clear button -->
              <button
                v-if="userAvatarPreview"
                type="button"
                @click="clearAvatarSelection"
                class="absolute -top-1 -right-1 h-5 w-5 flex items-center justify-center bg-background rounded-full text-muted-foreground hover:text-foreground"
                :disabled="isProfileSaving"
              >
                <X class="h-4 w-4" />
              </button>
            </div>
            <!-- File input -->
            <div>
              <input
                type="file"
                id="avatar-input"
                accept="image/png,image/jpeg,image/gif,image/webp"
                class="sr-only"
                :disabled="isProfileSaving"
                @change="handleAvatarSelect"
              />
              <label
                for="avatar-input"
                class="cursor-pointer inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 border border-input bg-background hover:bg-accent hover:text-accent-foreground h-9 px-3"
                :class="{ 'pointer-events-none opacity-50': isProfileSaving }"
              >
                {{ userAvatarPreview ? "Change photo" : "Choose photo" }}
              </label>
            </div>
          </div>
        </div>

        <!-- Error display -->
        <div
          v-if="profileError"
          class="rounded-md bg-destructive/10 p-3 text-sm text-destructive"
        >
          {{ profileError }}
        </div>

        <Button
          type="submit"
          :disabled="!canContinueProfile || isProfileSaving"
          class="w-full h-12"
        >
          <Loader2 v-if="isProfileSaving" class="mr-2 h-4 w-4 animate-spin" />
          Continue
        </Button>
      </form>
    </div>
  </div>

  <!-- Passkey Prompt State -->
  <div
    v-else-if="onboardingState === 'passkey-prompt'"
    class="min-h-screen flex items-center justify-center p-6"
  >
    <div class="w-full max-w-sm space-y-6 text-center">
      <div class="space-y-2">
        <div
          class="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-primary/10"
        >
          <Key class="h-8 w-8 text-primary" />
        </div>
        <h1 class="text-2xl font-semibold">Add a passkey for faster sign-in</h1>
        <p class="text-muted-foreground text-sm">
          Passkeys let you sign in securely with your fingerprint, face, or
          device PIN. No passwords needed!
        </p>
      </div>

      <div class="space-y-3">
        <div class="space-y-2">
          <Label for="deviceName" class="text-left block">
            Name this passkey
          </Label>
          <Input
            id="deviceName"
            v-model="passkeyDeviceName"
            type="text"
            placeholder="e.g., MacBook Pro"
            class="h-12"
          />
        </div>

        <Button @click="handleAddPasskey" class="w-full h-12">
          Add passkey
        </Button>

        <Button
          variant="ghost"
          @click="skipPasskey"
          class="w-full text-muted-foreground"
        >
          Skip for now
        </Button>
      </div>
    </div>
  </div>

  <!-- Passkey Registering State -->
  <div
    v-else-if="onboardingState === 'passkey-registering'"
    class="min-h-screen flex items-center justify-center p-6"
  >
    <div class="w-full max-w-sm space-y-6 text-center">
      <Loader2 class="mx-auto h-12 w-12 animate-spin text-primary" />
      <p class="text-muted-foreground">Setting up your passkey...</p>
      <p class="text-muted-foreground text-sm">
        Follow the prompts from your browser or device.
      </p>
    </div>
  </div>

  <!-- Passkey Success State -->
  <div
    v-else-if="onboardingState === 'passkey-success'"
    class="min-h-screen flex items-center justify-center p-6"
  >
    <div class="w-full max-w-sm space-y-6 text-center">
      <div
        class="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-green-500/10"
      >
        <Key class="h-8 w-8 text-green-500" />
      </div>
      <div class="space-y-2">
        <h1 class="text-2xl font-semibold">Passkey added!</h1>
        <p class="text-muted-foreground text-sm">
          You can now use this passkey to sign in faster.
        </p>
      </div>
    </div>
  </div>

  <!-- Passkey Error State -->
  <div
    v-else-if="onboardingState === 'passkey-error'"
    class="min-h-screen flex items-center justify-center p-6"
  >
    <div class="w-full max-w-sm space-y-6 text-center">
      <div
        class="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-amber-500/10"
      >
        <Key class="h-8 w-8 text-amber-500" />
      </div>
      <div class="space-y-2">
        <h1 class="text-xl font-semibold">{{ passkeyError }}</h1>
      </div>
      <div class="flex flex-col gap-2">
        <Button @click="retryPasskey" variant="outline" class="w-full">
          Try again
        </Button>
        <Button
          @click="skipPasskey"
          variant="ghost"
          class="w-full text-muted-foreground"
        >
          Skip for now
        </Button>
      </div>
    </div>
  </div>
</template>
