/**
 * @module userStore
 *
 * Pinia store for the signed-in user.
 *
 * The `useUserStore` provides reactive access to:
 * - Current user profile and authentication status
 * - Network connectivity status
 * - Authentication configuration (OAuth, passkey, email sign-in availability)
 * - Every sign-in method, the sign-in callback, profile and avatar, passkeys
 *
 * The client owns the sign-in rules: where an emailed link lands
 * (`emailSignInLinkTarget()`) and which URLs are callbacks
 * (`handleSignInCallback()`). The store adds the app's continuation bag
 * (`src/lib/signInState.ts`) and its state.
 */
import type {
  JsBaoEvents,
  StatusChangedEvent,
  UserProfile,
} from "js-bao-wss-client";
import {
  AUTH_CODES,
  AuthError,
  googleWebClientAvailable,
} from "js-bao-wss-client";
import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { getAppClient } from "../lib/client";
import {
  clearPendingInviteToken,
  getPendingInviteToken,
} from "../lib/inviteToken";
import { appBaseLogger } from "../lib/logger";
import { emailSignInRedirect, readStateBag } from "../lib/signInState";
export { AUTH_CODES, AuthError } from "js-bao-wss-client";
export type { UserProfile } from "js-bao-wss-client";

/**
 * Authentication configuration returned from the server.
 * Indicates which auth methods are available for the app.
 */
export interface AuthConfig {
  appId: string;
  name: string;
  /** App access mode: public, invite-only, or domain-restricted */
  mode: "public" | "invite-only" | "domain";
  /** Whether waitlist is enabled for invite-only apps */
  waitlistEnabled: boolean;
  /**
   * Whether THIS (browser) client can start Google sign-in: the provider is
   * enabled and the `web` client entry is usable (#2891). Google registers a
   * client per platform, so there is no single server-side flag to read — an
   * app configured only for iOS is not available here.
   */
  googleAvailable: boolean;
  /** Whether passkeys are fully configured (enabled + rpId + rpName) */
  hasPasskey: boolean;
  /**
   * Whether email sign-in is available (#2884). ONE flag: one request sends
   * one email carrying a code and, when a link can be issued, a link — so
   * there is no method to enable, choose, or fall back to.
   */
  emailSignInEnabled: boolean;
}

/**
 * Result from requesting a sign-in email.
 */
export interface EmailSignInRequestResult {
  ok: boolean;
}

/**
 * What `handleSignInCallback()` reports to the callback page: where to
 * continue and the onboarding hints, or why the link did not sign anyone in.
 */
export type SignInCallbackOutcome =
  | {
      ok: true;
      /** Where to continue after onboarding: the link's bag, else "/". */
      continueUrl: string;
      /** True if this is a newly created user (first sign-in). */
      isNewUser: boolean;
      /** True if the server suggests adding a passkey. */
      promptAddPasskey: boolean;
    }
  | {
      ok: false;
      /** The auth error code, when the failure carried one. */
      errorCode?: string;
      errorMessage: string;
      /** True if the link had expired or was already used. */
      tokenExpiredOrUsed: boolean;
      /** The address the link was sent to, for a resend; from the link's bag. */
      email?: string;
      /** Where the link would have continued; from the link's bag, else "/". */
      continueUrl: string;
    };

/**
 * Information about a registered passkey.
 */
export interface PasskeyInfo {
  passkeyId: string;
  deviceName: string;
  createdAt: string;
  lastUsedAt?: string;
}

/**
 * Result from verifying an OTP code.
 */
export interface OtpVerifyResult {
  ok: boolean;
  /** User profile after successful verification */
  user?: {
    userId: string;
    email: string;
    name?: string;
  };
  /** True if this is a newly created user (first sign-in) */
  isNewUser?: boolean;
  /** True if user should be prompted to add a passkey */
  promptAddPasskey?: boolean;
}

type AuthFailedPayload = JsBaoEvents["auth-failed"];

// Module-scoped lifecycle flags and resources
let initStarted = false;
let removeStatusListener: (() => void) | null = null;
let removeAuthSuccess: (() => void) | null = null;
let removeAuthFailed: (() => void) | null = null;
// De-duplicates concurrent loadAuthConfig() calls. Lazily fetched on first
// access so we don't pay the round trip on cold loads where the user is
// already authenticated and never sees the login UI.
let authConfigPromise: Promise<void> | null = null;
// Ensures completeAuthentication() runs exactly once per login. The
// auth-success event can fire synchronously during a verify or a callback,
// starting a concurrent call that races the explicit one; the guard
// serialises them so isAuthenticated is set once the profile is loaded.
let completeAuthPromise: Promise<void> | null = null;

export const useUserStore = defineStore("user", () => {
  const logger = appBaseLogger.forScope("userStore");

  /**
   * The currently authenticated user's profile, or null if not authenticated.
   */
  const currentUser = ref<UserProfile | null>(null);

  /**
   * Whether the user has a valid session right now.
   *
   * This is a live reactive signal, not a one-time gate — it can transition
   * in both directions at any time after initialization:
   * - `false → true`: returning user during initialize(), sign-in callback, code, passkey
   * - `true → false`: session expiry (auth-failed event), explicit logout
   *
   * Components inside AppLayout can assume this is true (the layout gates on it).
   * Components outside AppLayout should watch this reactively.
   */
  const isAuthenticated = ref(false);

  /**
   * Whether the app has network connectivity.
   */
  const isOnline = ref(false);

  /**
   * Whether the store has completed initialization (one-way: once true, stays true).
   *
   * After this is true, event listeners are registered, auth config is loaded,
   * and the store's reactive state is meaningful. Does NOT imply the user is
   * authenticated — check `isAuthenticated` for that.
   *
   * Used by the router guard to catch developer errors (navigating to protected
   * routes before the store is ready).
   */
  const isInitialized = ref(false);

  /**
   * Authentication configuration from the server.
   * Indicates which auth methods (OAuth, passkey, email sign-in) are available.
   */
  const authConfig = ref<AuthConfig | null>(null);

  /**
   * Set when {@link loadAuthConfig} fails to fetch the auth configuration
   * (e.g. the server is unreachable, or this app's origin / redirect URI is
   * not registered for the app server-side and gets rejected by CORS).
   *
   * When this is non-null, `authConfig` is null and no sign-in methods can be
   * shown, so login pages should surface this message instead of rendering a
   * blank form.
   */
  const authConfigError = ref<string | null>(null);

  /**
   * Whether the current user has admin privileges.
   */
  const isAdmin = computed(() =>
    Boolean(isAuthenticated.value && currentUser.value?.appRole === "admin")
  );

  // ---------------------------------------------------------------------------
  // Initialization
  // ---------------------------------------------------------------------------

  /**
   * Initialize the user store. `main.ts` calls it once during bootstrap.
   *
   * Apps should watch `isAuthenticated` to handle sign-out events and redirect
   * to login as needed.
   */
  const initialize = async (): Promise<void> => {
    const initLogger = logger.forScope("initialize");
    if (initStarted) {
      initLogger.debug("Already initialized; skipping");
      return;
    }
    initStarted = true;

    // Initialize Auth and UserProfile
    try {
      initLogger.debug("Initialization started");
      const client = await getAppClient();

      // Auth config is loaded lazily on first read via loadAuthConfig().
      // Pages that render the login UI call it explicitly; passive
      // consumers (e.g., menu items) read `authConfig.value` and treat
      // null as "feature unavailable until loaded".

      // Initialize authentication state
      const alreadyAuthenticated = client.isAuthenticated();
      initLogger.debug("Authentication state:", alreadyAuthenticated);

      if (alreadyAuthenticated) {
        await completeAuthentication();
      }

      // Initialize network status and status listener
      const netSnapshot = client.getNetworkStatus();
      isOnline.value = netSnapshot.isOnline;
      initLogger.debug("Network status:", netSnapshot);

      const statusHandler = ({ status, net }: StatusChangedEvent) => {
        initLogger.debug("JsBaoClient status:", status, net);
        isOnline.value = !!net?.isOnline;
      };
      client.on("status", statusHandler);
      removeStatusListener = () => client.off("status", statusHandler);

      const authSuccessHandler = async () => {
        initLogger.debug("Event Received: auth-success");
        if (!isAuthenticated.value) {
          try {
            await completeAuthentication();
          } catch (e: unknown) {
            initLogger.error("Completing authentication failed:", e);
          }
        }
      };
      // `on` takes a sync listener; each handler here catches its own
      // failures, so its promise is discarded on purpose.
      const onAuthSuccess = () => void authSuccessHandler();
      client.on("auth-success", onAuthSuccess);
      removeAuthSuccess = () => client.off("auth-success", onAuthSuccess);

      // On auth-failed, update state but let the app handle navigation.
      // Apps should watch isAuthenticated and redirect to login when it
      // transitions from true to false.
      const authFailedHandler = async ({ message }: AuthFailedPayload) => {
        initLogger.debug("Event Received: auth-failed:", message);
        isAuthenticated.value = false;
        currentUser.value = null;
        try {
          await client.logout({ clearOfflineIdentity: true });
        } catch {}
        // remain initialized; app handles redirect via watching isAuthenticated
      };
      const onAuthFailed = (payload: AuthFailedPayload) =>
        void authFailedHandler(payload);
      client.on("auth-failed", onAuthFailed);
      removeAuthFailed = () => client.off("auth-failed", onAuthFailed);

      // initialization complete
      isInitialized.value = true;
      initLogger.debug("Initialization complete");
    } catch (error) {
      initLogger.warn("Initialization error:", error);
      isInitialized.value = true;
    }
  };

  // ---------------------------------------------------------------------------
  // Auth: helpers and actions
  // ---------------------------------------------------------------------------

  /**
   * Lazily fetch the app's auth configuration (OAuth providers, passkey
   * support, email sign-in availability, access mode).
   *
   * Called by login-related pages on mount. Other pages may call it if they
   * need auth-config-derived UI (e.g., a "Manage Passkeys" menu item) —
   * they should still null-guard `authConfig.value` because the load is async.
   *
   * Idempotent: concurrent callers share the same in-flight promise, and
   * subsequent calls after a successful load return immediately.
   */
  const loadAuthConfig = async (): Promise<void> => {
    if (authConfig.value !== null) return;
    if (authConfigPromise) return authConfigPromise;
    const cfgLogger = logger.forScope("loadAuthConfig");
    authConfigError.value = null;
    authConfigPromise = (async () => {
      try {
        const client = await getAppClient();
        const config = await client.getAuthConfig();
        authConfig.value = {
          appId: config.appId,
          name: config.name,
          mode: config.mode as "public" | "invite-only" | "domain",
          waitlistEnabled: config.waitlistEnabled,
          // The SAME predicate `login()` re-checks below, computed once from
          // the client map. Before #2891 the button read `hasOAuth` and
          // `login()` gated on `hasWebOAuth`, so a native-only configuration
          // rendered a Google button that threw on click.
          googleAvailable: googleWebClientAvailable(config),
          hasPasskey: config.hasPasskey,
          emailSignInEnabled: config.emailSignInEnabled,
        };
        cfgLogger.debug("Auth config loaded:", authConfig.value);
      } catch (e: unknown) {
        cfgLogger.warn("Failed to fetch auth config:", e);
        // Surface the failure so login pages can show a clear message instead
        // of a blank form. The most common cause in development is a config
        // mismatch: this app's origin / redirect URI is not registered for the
        // app server-side, so the server rejects the request via CORS.
        authConfigError.value =
          "We couldn't load sign-in options from the Primitive server. The request was blocked or failed — most often because the address this app is served from isn't listed in this Primitive app's CORS Allowed Origins on the server.";
        authConfigPromise = null;
      }
    })();
    return authConfigPromise;
  };

  /**
   * Initiate the OAuth login flow.
   *
   * @param continueURL - Optional URL to redirect to after successful login
   * @throws Error if OAuth is not available
   */
  const login = async (continueURL?: string): Promise<void> => {
    const client = await getAppClient();
    const googleAvailable = await client.checkOAuthAvailable();
    if (!googleAvailable) throw new Error("OAuth is not available");
    const inviteToken = getPendingInviteToken() ?? undefined;
    await client.startOAuthFlow(continueURL, { inviteToken });
  };

  // ---------------------------------------------------------------------------
  // Email sign-in and the sign-in callback
  // ---------------------------------------------------------------------------

  /**
   * Request ONE email sign-in email: it carries a 6-digit code and, when the
   * client has a link target the app allow-lists, a sign-in link. The user
   * finishes with either.
   *
   * The link target is the client's (`emailSignInLinkTarget()`); the store
   * adds the app's continuation bag to it — where to continue, the address
   * (for a resend from another tab) and a pending invite token. With no
   * target the email carries the code alone.
   *
   * @param email - Email address to sign in
   * @param bag - Where to continue after sign-in
   * @throws AuthError if the request fails (e.g. INVITATION_REQUIRED, DOMAIN_NOT_ALLOWED)
   */
  const requestEmailSignIn = async (
    email: string,
    bag: { continueUrl?: string } = {}
  ): Promise<EmailSignInRequestResult> => {
    const emailLogger = logger.forScope("requestEmailSignIn");
    emailLogger.debug("Requesting email sign-in for:", email);

    try {
      const client = await getAppClient();
      const redirectUri = emailSignInRedirect(client.emailSignInLinkTarget(), {
        continueUrl: bag.continueUrl ?? "/",
        email,
        inviteToken: getPendingInviteToken() ?? undefined,
      });
      await client.emailSignInRequest(email, { redirectUri });
      emailLogger.debug("Email sign-in request successful");
      return { ok: true };
    } catch (err: unknown) {
      emailLogger.error("Email sign-in request failed:", err);
      throw err;
    }
  };

  /**
   * Finish a sign-in from the page an emailed link or an OAuth redirect
   * opened. The client applies the callback grammar and signs the user in;
   * this reports where to continue, or why the link did not sign anyone in.
   */
  const handleSignInCallback = async (): Promise<SignInCallbackOutcome> => {
    const callbackLogger = logger.forScope("handleSignInCallback");
    const inviteToken = getPendingInviteToken() ?? undefined;

    try {
      const client = await getAppClient();
      const result = await client.handleSignInCallback(undefined, {
        inviteToken,
      });
      if (inviteToken) clearPendingInviteToken();
      callbackLogger.debug("Signed in", {
        method: result.method,
        isNewUser: result.isNewUser,
      });

      await completeAuthentication();

      return {
        ok: true,
        continueUrl: result.continueUrl ?? "/",
        isNewUser: result.isNewUser ?? false,
        promptAddPasskey: result.promptAddPasskey ?? false,
      };
    } catch (err: unknown) {
      callbackLogger.error("Sign-in callback failed:", err);
      const errorCode = err instanceof AuthError ? err.code : undefined;
      const errorMessage =
        err instanceof Error ? err.message : "Authentication failed";
      const message = errorMessage.toLowerCase();
      const tokenExpiredOrUsed =
        errorCode === AUTH_CODES.TOKEN_EXPIRED ||
        (errorCode === AUTH_CODES.INVALID_TOKEN &&
          !message.startsWith("sign-in callback refused")) ||
        message.includes("expired") ||
        message.includes("already used") ||
        message.includes("already been used");
      // A failed link is not handed back decoded, so read the app's own bag
      // for the address to resend to and where to go back.
      const bag = readStateBag(window.location.search);
      return {
        ok: false,
        errorCode,
        errorMessage,
        tokenExpiredOrUsed,
        email: bag?.email,
        continueUrl: bag?.continueUrl ?? "/",
      };
    }
  };

  // ---------------------------------------------------------------------------
  // Finishing email sign-in with the code half of the email (#2884)
  // ---------------------------------------------------------------------------

  /**
   * Verify a one-time code and authenticate the user.
   *
   * @param email - Email address the code was sent to
   * @param code - The 6-digit code from the email
   * @returns Result with user info
   * @throws AuthError if verification fails (e.g., INVALID_TOKEN, OTP_MAX_ATTEMPTS)
   */
  const verifyOtp = async (
    email: string,
    code: string
  ): Promise<OtpVerifyResult> => {
    const otpLogger = logger.forScope("verifyOtp");
    otpLogger.debug("Verifying OTP for:", email);

    try {
      const client = await getAppClient();
      const inviteToken = getPendingInviteToken() ?? undefined;
      // Cast result to include promptAddPasskey which is returned by the API
      // but not yet in the public types (isNewUser is already surfaced).
      const result = (await client.otpVerify(email, code, { inviteToken })) as {
        user: { userId: string; email: string; name?: string };
        isNewUser?: boolean;
        promptAddPasskey?: boolean;
      };
      if (inviteToken) clearPendingInviteToken();

      otpLogger.debug("OTP verified successfully", {
        userId: result.user.userId,
        isNewUser: result.isNewUser,
        promptAddPasskey: result.promptAddPasskey,
      });

      await completeAuthentication();

      return {
        ok: true,
        user: result.user,
        isNewUser: result.isNewUser,
        promptAddPasskey: result.promptAddPasskey,
      };
    } catch (err: unknown) {
      otpLogger.error("OTP verification failed:", err);
      throw err;
    }
  };

  // ---------------------------------------------------------------------------
  // Passkey Authentication
  // ---------------------------------------------------------------------------

  /**
   * Sign in using a passkey credential.
   * Uses the WebAuthn API via @simplewebauthn/browser.
   *
   * @param credential - The credential from startAuthentication()
   * @param challengeToken - The challenge token from passkeyAuthStart()
   * @returns Object containing isNewUser flag if this is the user's first sign-in
   */
  const signInWithPasskey = async (
    credential: unknown,
    challengeToken: string
  ): Promise<{ isNewUser?: boolean }> => {
    const passkeyLogger = logger.forScope("signInWithPasskey");
    passkeyLogger.debug("Signing in with passkey");

    try {
      const client = await getAppClient();
      const result = await client.passkeyAuthFinish(credential, challengeToken);

      passkeyLogger.debug("Passkey sign-in successful", {
        userId: result.user.userId,
        isNewUser: result.isNewUser,
      });

      await completeAuthentication();

      return { isNewUser: result.isNewUser };
    } catch (err: unknown) {
      passkeyLogger.error("Passkey sign-in failed:", err);
      throw err;
    }
  };

  /**
   * Start the passkey authentication flow.
   * Returns options to pass to startAuthentication().
   *
   * @returns Authentication options and challenge token
   */
  const startPasskeyAuth = async (): Promise<{
    options: unknown;
    challengeToken: string;
  }> => {
    const passkeyLogger = logger.forScope("startPasskeyAuth");
    passkeyLogger.debug("Starting passkey authentication");

    const client = await getAppClient();
    const result = await client.passkeyAuthStart();
    passkeyLogger.debug("Passkey auth options received");
    return result;
  };

  /**
   * Register a new passkey for the current user.
   *
   * @param credential - The credential from startRegistration()
   * @param challengeToken - The challenge token from passkeyRegisterStart()
   * @param deviceName - Human-readable name for this passkey
   * @returns Result indicating success
   */
  const registerPasskey = async (
    credential: unknown,
    challengeToken: string,
    deviceName?: string
  ): Promise<{ success: boolean }> => {
    const passkeyLogger = logger.forScope("registerPasskey");
    passkeyLogger.debug("Registering passkey", { deviceName });

    try {
      const client = await getAppClient();
      const inviteToken = getPendingInviteToken() ?? undefined;
      const result = await client.passkeyRegisterFinish(
        credential,
        challengeToken,
        deviceName,
        { inviteToken }
      );
      if (inviteToken) clearPendingInviteToken();
      passkeyLogger.debug("Passkey registered successfully");
      return result;
    } catch (err: unknown) {
      passkeyLogger.error("Passkey registration failed:", err);
      throw err;
    }
  };

  /**
   * Start the passkey registration flow.
   * Returns options to pass to startRegistration().
   *
   * @returns Registration options and challenge token
   */
  const startPasskeyRegistration = async (): Promise<{
    options: unknown;
    challengeToken: string;
  }> => {
    const passkeyLogger = logger.forScope("startPasskeyRegistration");
    passkeyLogger.debug("Starting passkey registration");

    const client = await getAppClient();
    const result = await client.passkeyRegisterStart();
    passkeyLogger.debug("Passkey registration options received");
    return result;
  };

  /**
   * List all passkeys registered for the current user.
   *
   * @returns Array of passkey information
   */
  const listPasskeys = async (): Promise<PasskeyInfo[]> => {
    const passkeyLogger = logger.forScope("listPasskeys");
    passkeyLogger.debug("Listing passkeys");

    try {
      const client = await getAppClient();
      const result = await client.passkeyList();
      passkeyLogger.debug("Passkeys retrieved", {
        count: result.passkeys.length,
      });
      return result.passkeys;
    } catch (err: unknown) {
      passkeyLogger.error("Failed to list passkeys:", err);
      throw err;
    }
  };

  /**
   * Delete a passkey.
   *
   * @param passkeyId - ID of the passkey to delete
   * @returns Result indicating success
   */
  const deletePasskey = async (
    passkeyId: string
  ): Promise<{ success: boolean }> => {
    const passkeyLogger = logger.forScope("deletePasskey");
    passkeyLogger.debug("Deleting passkey", { passkeyId });

    try {
      const client = await getAppClient();
      const result = await client.passkeyDelete(passkeyId);
      passkeyLogger.debug("Passkey deleted successfully");
      return result;
    } catch (err: unknown) {
      passkeyLogger.error("Failed to delete passkey:", err);
      throw err;
    }
  };

  /**
   * Rename a passkey.
   *
   * @param passkeyId - ID of the passkey to rename
   * @param newDeviceName - New name for the passkey
   * @returns The updated passkey info
   */
  const renamePasskey = async (
    passkeyId: string,
    newDeviceName: string
  ): Promise<PasskeyInfo> => {
    const passkeyLogger = logger.forScope("renamePasskey");
    passkeyLogger.debug("Renaming passkey", { passkeyId, newDeviceName });

    try {
      const client = await getAppClient();
      const result = await client.passkeyUpdate(passkeyId, {
        deviceName: newDeviceName,
      });
      passkeyLogger.debug("Passkey renamed successfully");
      return result.passkey;
    } catch (err: unknown) {
      passkeyLogger.error("Failed to rename passkey:", err);
      throw err;
    }
  };

  // ---------------------------------------------------------------------------
  // Profile Management
  // ---------------------------------------------------------------------------

  /**
   * Supported content types for avatar upload.
   */
  type AvatarContentType =
    "image/png" | "image/jpeg" | "image/gif" | "image/webp";

  /** Maximum avatar file size in bytes (1MB server limit) */
  const MAX_AVATAR_SIZE = 1 * 1024 * 1024;

  /** Maximum dimension for avatar images */
  const MAX_AVATAR_DIMENSION = 1024;

  /**
   * Resize an image to fit within the server's size limit.
   * Uses canvas to progressively reduce quality/dimensions until under limit.
   *
   * @param imageData - Original image as Blob or File
   * @param contentType - The MIME type of the image
   * @returns Resized image blob (or original if already small enough)
   */
  const resizeAvatarImage = async (
    imageData: Blob | File,
    contentType: AvatarContentType
  ): Promise<Blob> => {
    const resizeLogger = logger.forScope("resizeAvatarImage");

    // If already under limit, return as-is
    if (imageData.size <= MAX_AVATAR_SIZE) {
      resizeLogger.debug("Image already under size limit", {
        size: imageData.size,
      });
      return imageData;
    }

    resizeLogger.debug("Resizing image", {
      originalSize: imageData.size,
      targetSize: MAX_AVATAR_SIZE,
    });

    // Load image into an Image element
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = reject;
      image.src = URL.createObjectURL(imageData);
    });

    // Clean up object URL
    URL.revokeObjectURL(img.src);

    // Calculate new dimensions (maintain aspect ratio)
    let { width, height } = img;
    if (width > MAX_AVATAR_DIMENSION || height > MAX_AVATAR_DIMENSION) {
      const ratio = Math.min(
        MAX_AVATAR_DIMENSION / width,
        MAX_AVATAR_DIMENSION / height
      );
      width = Math.round(width * ratio);
      height = Math.round(height * ratio);
    }

    // Create canvas and draw resized image
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new Error("Failed to get canvas context");
    }
    ctx.drawImage(img, 0, 0, width, height);

    // For JPEG/WebP, progressively reduce quality until under limit
    // For PNG/GIF, just use the resized dimensions
    const outputType = contentType === "image/gif" ? "image/png" : contentType;
    let quality = 0.9;
    let blob: Blob | null = null;

    while (quality >= 0.1) {
      blob = await new Promise<Blob | null>((resolve) => {
        canvas.toBlob(resolve, outputType, quality);
      });

      if (blob && blob.size <= MAX_AVATAR_SIZE) {
        resizeLogger.debug("Image resized successfully", {
          originalSize: imageData.size,
          newSize: blob.size,
          quality,
          dimensions: `${width}x${height}`,
        });
        return blob;
      }

      // Reduce quality for next iteration
      quality -= 0.1;
    }

    // If still too large after quality reduction, reduce dimensions further
    let scale = 0.8;
    while (scale >= 0.2) {
      const scaledWidth = Math.round(width * scale);
      const scaledHeight = Math.round(height * scale);

      canvas.width = scaledWidth;
      canvas.height = scaledHeight;
      ctx.drawImage(img, 0, 0, scaledWidth, scaledHeight);

      blob = await new Promise<Blob | null>((resolve) => {
        canvas.toBlob(resolve, outputType, 0.8);
      });

      if (blob && blob.size <= MAX_AVATAR_SIZE) {
        resizeLogger.debug("Image resized with dimension reduction", {
          originalSize: imageData.size,
          newSize: blob.size,
          dimensions: `${scaledWidth}x${scaledHeight}`,
        });
        return blob;
      }

      scale -= 0.1;
    }

    // Last resort: return the smallest we could get
    if (blob) {
      resizeLogger.warn("Could not resize image under limit, using smallest", {
        size: blob.size,
      });
      return blob;
    }

    throw new Error("Failed to resize image");
  };

  /**
   * Update the current user's profile (name and/or avatar URL).
   * The profile state (`currentUser`) updates automatically via client events.
   *
   * @param data - Profile fields to update
   * @returns The updated user profile
   */
  const updateProfile = async (data: {
    name?: string;
    avatarUrl?: string | null;
  }): Promise<UserProfile | null> => {
    const profileLogger = logger.forScope("updateProfile");
    profileLogger.debug("Updating profile", data);

    try {
      const client = await getAppClient();
      const updatedProfile = await client.me.update(data);
      profileLogger.debug("Profile updated successfully", updatedProfile);

      // Update local state immediately (client also emits meUpdated event)
      currentUser.value = updatedProfile;

      return updatedProfile;
    } catch (err: unknown) {
      profileLogger.error("Failed to update profile:", err);
      throw err;
    }
  };

  /**
   * Upload an avatar image for the current user.
   * Automatically resizes the image if it exceeds the server's 1MB limit.
   * After upload, the profile's avatarUrl is automatically updated.
   *
   * @param imageData - The image as a Blob or File
   * @param contentType - The MIME type of the image
   * @returns The new avatar URL
   */
  const uploadAvatar = async (
    imageData: Blob | File,
    contentType: AvatarContentType
  ): Promise<string> => {
    const avatarLogger = logger.forScope("uploadAvatar");
    avatarLogger.debug("Uploading avatar", {
      size: imageData.size,
      contentType,
    });

    try {
      // Resize image if needed to fit server limit
      const resizedImage = await resizeAvatarImage(imageData, contentType);

      // Determine output content type (GIF becomes PNG after resize)
      const outputContentType =
        contentType === "image/gif" && resizedImage !== imageData
          ? "image/png"
          : contentType;

      avatarLogger.debug("Uploading resized avatar", {
        originalSize: imageData.size,
        resizedSize: resizedImage.size,
        contentType: outputContentType,
      });

      const client = await getAppClient();
      const result = await client.me.uploadAvatar(
        resizedImage,
        outputContentType
      );
      avatarLogger.debug("Avatar uploaded successfully", {
        avatarUrl: result.avatarUrl,
      });

      // Refresh the profile to get updated avatarUrl
      const updatedProfile = await client.me.get({ refreshNetwork: true });
      if (updatedProfile) {
        currentUser.value = updatedProfile;
      }

      return result.avatarUrl;
    } catch (err: unknown) {
      avatarLogger.error("Failed to upload avatar:", err);
      throw err;
    }
  };

  /**
   * Get a suggested device name based on the current browser/platform.
   *
   * @returns Suggested device name string
   */
  const getSuggestedDeviceName = (): string => {
    if (typeof navigator === "undefined") return "Unknown Device";

    const ua = navigator.userAgent;
    let browser = "Browser";
    let os = "Device";

    // Detect browser
    if (ua.includes("Chrome") && !ua.includes("Edg")) {
      browser = "Chrome";
    } else if (ua.includes("Safari") && !ua.includes("Chrome")) {
      browser = "Safari";
    } else if (ua.includes("Firefox")) {
      browser = "Firefox";
    } else if (ua.includes("Edg")) {
      browser = "Edge";
    }

    // Detect OS
    if (ua.includes("iPhone")) {
      os = "iPhone";
    } else if (ua.includes("iPad")) {
      os = "iPad";
    } else if (ua.includes("Mac OS")) {
      os = "Mac";
    } else if (ua.includes("Windows")) {
      os = "Windows";
    } else if (ua.includes("Android")) {
      os = "Android";
    } else if (ua.includes("Linux")) {
      os = "Linux";
    }

    return `${browser} on ${os}`;
  };

  /**
   * Internal helper that loads the user profile.
   * Called by completeAuthentication() - do not call directly.
   */
  const onAuthentication = async (): Promise<void> => {
    const authLogger = logger.forScope("onAuthentication");
    authLogger.debug("Starting: fetching user profile");
    const client = await getAppClient();
    try {
      const profile = await client.me.get();
      authLogger.debug("Authenticated profile:", profile);
      currentUser.value = profile;
    } catch (e: unknown) {
      authLogger.warn("Failed to fetch profile after authentication:", e);
    }
  };

  /**
   * Complete the authentication flow: load the profile, then set the
   * authenticated state, so watchers on isAuthenticated see a current user.
   *
   * This is the single entry point for all auth paths to finalize
   * authentication; every sign-in method calls it instead of setting
   * isAuthenticated directly.
   */
  const completeAuthentication = async (): Promise<void> => {
    if (completeAuthPromise) {
      return completeAuthPromise;
    }

    completeAuthPromise = (async () => {
      const authLogger = logger.forScope("completeAuthentication");
      authLogger.debug("Completing authentication flow");

      await onAuthentication();

      isAuthenticated.value = true;
      authLogger.debug("Authentication complete, isAuthenticated set to true");
    })();

    try {
      await completeAuthPromise;
    } finally {
      completeAuthPromise = null;
    }
  };

  /**
   * Log out the current user and optionally redirect.
   *
   * @param redirectTo - Optional URL to redirect to after logout
   */
  const logout = async (redirectTo?: string): Promise<void> => {
    try {
      const client = await getAppClient();
      await client.logout({
        wipeLocal: false,
        revokeOffline: false,
        clearOfflineIdentity: true,
      });
    } catch (e: unknown) {
      logger.warn("Logout error:", e);
      if (redirectTo) window.location.href = redirectTo;
    } finally {
      isAuthenticated.value = false;
      currentUser.value = null;
      authConfigPromise = null;
      authConfig.value = null;
      authConfigError.value = null;
      // keep isInitialized true; allow re-init by clearing guard
      if (removeStatusListener) {
        try {
          removeStatusListener();
        } catch {}
        removeStatusListener = null;
      }
      if (removeAuthSuccess) {
        try {
          removeAuthSuccess();
        } catch {}
        removeAuthSuccess = null;
      }
      if (removeAuthFailed) {
        try {
          removeAuthFailed();
        } catch {}
        removeAuthFailed = null;
      }
      completeAuthPromise = null;
      initStarted = false;
    }
  };

  return {
    // state
    currentUser,
    isAuthenticated,
    isOnline,
    isInitialized,
    authConfig,
    authConfigError,

    // getters
    isAdmin,

    // actions
    initialize,
    loadAuthConfig,
    login,
    logout,

    // email sign-in (#2884) — one request, one email, both credentials
    requestEmailSignIn,
    // the page an emailed link or an OAuth redirect opens
    handleSignInCallback,

    // finishing the sign-in: the code half of the same email
    verifyOtp,

    // passkey
    startPasskeyAuth,
    signInWithPasskey,
    startPasskeyRegistration,
    registerPasskey,
    listPasskeys,
    deletePasskey,
    renamePasskey,
    getSuggestedDeviceName,

    // profile
    updateProfile,
    uploadAvatar,
  };
});
