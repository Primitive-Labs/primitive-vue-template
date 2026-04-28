/**
 * @module userStore
 *
 * Pinia store for managing user authentication state and preferences.
 *
 * The `useUserStore` provides reactive access to:
 * - Current user profile and authentication status
 * - Network connectivity status
 * - Authentication configuration (OAuth, passkey, magic link availability)
 * - User preferences (key-value storage synced to the root document)
 */
import type {
  JsBaoEvents,
  StatusChangedEvent,
  UserProfile,
} from "js-bao-wss-client";
import { AUTH_CODES, AuthError } from "js-bao-wss-client";
import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { useTheme } from "../composables/useTheme";
import {
  clearPendingInviteToken,
  getPendingInviteToken,
} from "../lib/inviteToken";
import { appBaseLogger } from "../lib/logger";
import { UserPref } from "../models/UserPref";
import { jsBaoClientService } from "primitive-app";
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
  /** Whether Google OAuth is configured and usable */
  hasOAuth: boolean;
  /** Whether passkeys are fully configured (enabled + rpId + rpName) */
  hasPasskey: boolean;
  /** Whether magic link authentication is enabled */
  magicLinkEnabled: boolean;
  /** Whether OTP (one-time code) authentication is enabled */
  otpEnabled: boolean;
}

/**
 * Result from requesting a magic link.
 */
export interface MagicLinkRequestResult {
  ok: boolean;
}

/**
 * Result from verifying a magic link.
 */
export interface MagicLinkVerifyResult {
  ok: boolean;
  /** User profile after successful verification */
  user?: {
    userId: string;
    email: string;
    name?: string;
  };
  /** True if user should be prompted to add a passkey */
  promptAddPasskey?: boolean;
  /** True if this is a newly created user (first sign-in) */
  isNewUser?: boolean;
  /** URL to redirect to after verification */
  redirectTo: string;
  /** Auth error code if verification failed */
  errorCode?: string;
  /** Error message for display or fallback detection */
  errorMessage?: string;
  /** True if the magic link token was expired or already used */
  tokenExpiredOrUsed?: boolean;
}

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
 * Result from requesting an OTP code.
 */
export interface OtpRequestResult {
  ok: boolean;
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
}

type AuthFailedPayload = JsBaoEvents["auth-failed"];

type UserPrefsMap = Record<string, unknown>;

// Module-scoped lifecycle flags and resources
let initStarted = false;
let removeStatusListener: (() => void) | null = null;
let removeAuthSuccess: (() => void) | null = null;
let removeAuthFailed: (() => void) | null = null;
let rootDocOpen = false;
let rootDocumentId: string | null = null;
let prefsUnsubscribe: (() => void) | null = null;
// Ensures completeAuthentication() runs exactly once per login. The auth-success
// event can fire synchronously during magicLinkVerify/handleOAuthCallback,
// starting a concurrent call that races the explicit one. The guard serialises
// them so that (1) authentication fully completes before the root document is
// opened and (2) isAuthenticated is not set until prefs are loaded.
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
   * - `false → true`: returning user during initialize(), OAuth callback, magic link, passkey
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
   * Indicates which auth methods (OAuth, passkey, magic link) are available.
   */
  const authConfig = ref<AuthConfig | null>(null);

  const userPrefs = ref<UserPrefsMap>({});

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
   * Initialize the user store.
   * This is typically called by `createPrimitiveApp` during app bootstrap.
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
      const client = await jsBaoClientService.getClientAsync();

      // Fetch auth configuration
      try {
        const config = await client.getAuthConfig();
        // Cast to include otpEnabled which is returned by server but not yet in client types
        const configWithOtp = config as typeof config & {
          otpEnabled?: boolean;
        };
        authConfig.value = {
          appId: config.appId,
          name: config.name,
          mode: config.mode as "public" | "invite-only" | "domain",
          waitlistEnabled: config.waitlistEnabled,
          hasOAuth: config.hasOAuth,
          hasPasskey: config.hasPasskey,
          magicLinkEnabled: config.magicLinkEnabled ?? true,
          otpEnabled: configWithOtp.otpEnabled ?? false,
        };
        initLogger.debug("Auth config loaded:", authConfig.value);
      } catch (e: unknown) {
        initLogger.warn("Failed to fetch auth config:", e);
      }

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
          await completeAuthentication();
        }
      };
      client.on("auth-success", authSuccessHandler);
      removeAuthSuccess = () => client.off("auth-success", authSuccessHandler);

      // On auth-failed, update state but let the app handle navigation.
      // Apps should watch isAuthenticated and redirect to login when it
      // transitions from true to false.
      const authFailedHandler = async ({ message }: AuthFailedPayload) => {
        initLogger.debug("Event Received: auth-failed:", message);
        isAuthenticated.value = false;
        currentUser.value = null;
        cleanupPrefs();
        try {
          await client.logout({ clearOfflineIdentity: true });
        } catch {}
        // remain initialized; app handles redirect via watching isAuthenticated
      };
      client.on("auth-failed", authFailedHandler);
      removeAuthFailed = () => client.off("auth-failed", authFailedHandler);

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
   * Initiate the OAuth login flow.
   *
   * @param continueURL - Optional URL to redirect to after successful login
   * @throws Error if OAuth is not available
   */
  const login = async (continueURL?: string): Promise<void> => {
    const client = await jsBaoClientService.getClientAsync();
    const hasOAuth = await client.checkOAuthAvailable();
    if (!hasOAuth) throw new Error("OAuth is not available");
    const inviteToken = getPendingInviteToken() ?? undefined;
    await client.startOAuthFlow(continueURL, { inviteToken });
  };

  /**
   * Handle the OAuth or magic link callback after the user returns.
   * This should be called from your callback route.
   * Automatically detects whether this is an OAuth callback (code+state) or
   * magic link callback (magic_token).
   *
   * @param defaultContinueUrl - URL to redirect to if no continue URL was in state
   * @param loginUrl - URL to redirect to on authentication failure
   * @returns Object with callback result including redirect URL and prompt flags
   */
  const handleOAuthCallback = async (
    defaultContinueUrl: string,
    loginUrl: string
  ): Promise<{
    ok: boolean;
    redirectTo: string;
    /** True if user was added to waitlist */
    waitlisted?: boolean;
    /** True if user should be prompted to add a passkey */
    promptAddPasskey?: boolean;
    /** True if this is a newly created user (first sign-in) */
    isNewUser?: boolean;
    /** Auth error code if applicable */
    errorCode?: string;
    /** Error message for display or fallback detection */
    errorMessage?: string;
    /** True if magic link token was expired or already used */
    tokenExpiredOrUsed?: boolean;
    /** Email from the original magic link request (for auto-resend) */
    email?: string;
  }> => {
    const callbackLogger = logger.forScope("handleOAuthCallback");
    callbackLogger.debug("Begin", {
      href: typeof window !== "undefined" ? window.location.href : "",
    });

    const urlParams = new URLSearchParams(window.location.search);
    const code = urlParams.get("code");
    const state = urlParams.get("state");
    const magicToken = urlParams.get("magic_token");

    callbackLogger.debug("URL params", {
      code: code ? "present" : "missing",
      state: state ? "present" : "missing",
      magicToken: magicToken ? "present" : "missing",
    });

    // Parse state once - used by both magic link and OAuth flows
    let redirectTo = defaultContinueUrl;
    let emailFromState: string | undefined;

    if (state) {
      try {
        const stateObj = JSON.parse(atob(state));
        if (stateObj?.continueUrl) {
          redirectTo = stateObj.continueUrl;
        }
        if (stateObj?.email) {
          emailFromState = stateObj.email;
        }
        // The magic link may have been opened in a different tab/browser, in
        // which case sessionStorage is empty. Restore the inviteToken from
        // state so the verify call can thread it through to the server.
        if (stateObj?.inviteToken && !getPendingInviteToken()) {
          sessionStorage.setItem(
            "primitive:pendingInviteToken",
            stateObj.inviteToken
          );
        }
        callbackLogger.debug("Parsed state", stateObj);
      } catch (e: unknown) {
        callbackLogger.warn("Failed to parse state; using defaults", e);
      }
    }

    // Magic link callback
    if (magicToken) {
      callbackLogger.debug("Detected magic link callback");
      const result = await handleMagicLinkCallback(magicToken);

      if (!result.ok) {
        return {
          ok: false,
          // Always preserve the continue URL - never redirect to login after
          // a successful auth. The callback component handles "back to login"
          // navigation separately via goToLogin().
          redirectTo,
          errorCode: result.errorCode,
          errorMessage: result.errorMessage,
          tokenExpiredOrUsed: result.tokenExpiredOrUsed,
          email: emailFromState,
        };
      }

      return {
        ok: true,
        redirectTo,
        promptAddPasskey: result.promptAddPasskey,
        isNewUser: result.isNewUser,
      };
    }

    // OAuth callback - validate required params
    if (!code || !state) {
      const reason = !code ? "missing OAuth code" : "missing OAuth state";
      callbackLogger.error(`OAuth callback error: ${reason}`);
      return {
        ok: false,
        redirectTo: `${loginUrl}?error=${encodeURIComponent(
          "Authentication failed: invalid callback parameters"
        )}`,
      };
    }

    try {
      const client = await jsBaoClientService.getClientAsync();
      callbackLogger.debug("Invoking client.handleOAuthCallback...");
      await client.handleOAuthCallback(code, state);
      const authed = client.isAuthenticated();
      callbackLogger.debug("handleOAuthCallback complete", {
        isAuthenticated: authed,
      });
      if (authed) {
        await completeAuthentication();
      }
      return { ok: true, redirectTo };
    } catch (err: unknown) {
      callbackLogger.error("Error during callback", err);
      const errorCode = err instanceof AuthError ? err.code : undefined;
      const message =
        err instanceof Error ? err.message : "Authentication failed";
      return {
        ok: false,
        redirectTo: `${loginUrl}?error=${encodeURIComponent(message)}`,
        errorCode,
        waitlisted: errorCode === AUTH_CODES.ADDED_TO_WAITLIST,
      };
    }
  };

  // ---------------------------------------------------------------------------
  // Magic Link Authentication
  // ---------------------------------------------------------------------------

  /**
   * Request a magic link to be sent to the specified email address.
   *
   * @param email - Email address to send the magic link to
   * @param redirectUri - Optional URI to redirect to after verification
   * @returns Result indicating success
   * @throws AuthError if request fails (e.g., INVITATION_REQUIRED, DOMAIN_NOT_ALLOWED)
   */
  const requestMagicLink = async (
    email: string,
    redirectUri?: string
  ): Promise<MagicLinkRequestResult> => {
    const magicLogger = logger.forScope("requestMagicLink");
    magicLogger.debug("Requesting magic link for:", email);

    try {
      const client = await jsBaoClientService.getClientAsync();
      await client.magicLinkRequest(email, { redirectUri });
      magicLogger.debug("Magic link request successful");
      return { ok: true };
    } catch (err: unknown) {
      magicLogger.error("Magic link request failed:", err);
      throw err;
    }
  };

  /**
   * Handle the magic link callback by verifying the token.
   * Called internally by handleOAuthCallback when magic_token is detected.
   *
   * @param token - The magic link token from the URL
   * @returns Result with user info and prompt flags
   */
  const handleMagicLinkCallback = async (
    token: string
  ): Promise<MagicLinkVerifyResult> => {
    const magicLogger = logger.forScope("handleMagicLinkCallback");
    magicLogger.debug("Verifying magic link token");

    try {
      const client = await jsBaoClientService.getClientAsync();
      const inviteToken = getPendingInviteToken() ?? undefined;
      // Cast result to include isNewUser which is returned by the API but not yet in public types
      const result = (await client.magicLinkVerify(token, { inviteToken })) as {
        user: { userId: string; email: string; name?: string };
        promptAddPasskey?: boolean;
        isNewUser?: boolean;
      };
      if (inviteToken) clearPendingInviteToken();

      magicLogger.debug("Magic link verified successfully", {
        userId: result.user.userId,
        promptAddPasskey: result.promptAddPasskey,
        isNewUser: result.isNewUser,
      });

      await completeAuthentication();

      return {
        ok: true,
        user: result.user,
        promptAddPasskey: result.promptAddPasskey,
        isNewUser: result.isNewUser,
        redirectTo: "/",
      };
    } catch (err: unknown) {
      magicLogger.error("Magic link verification failed:", err);

      // Check for specific error codes
      const errorCode = err instanceof AuthError ? err.code : undefined;
      const errorMessage = err instanceof Error ? err.message : "";

      magicLogger.debug("Error details:", {
        isAuthError: err instanceof AuthError,
        code: errorCode,
        message: errorMessage,
      });

      // Check for access control errors (these are handled specially by the callback)
      if (
        errorCode === AUTH_CODES.ADDED_TO_WAITLIST ||
        errorCode === AUTH_CODES.INVITATION_REQUIRED ||
        errorCode === AUTH_CODES.DOMAIN_NOT_ALLOWED
      ) {
        return {
          ok: false,
          redirectTo: "/",
          errorCode,
          errorMessage,
        };
      }

      // Detect token errors by code or by message content
      const isTokenErrorByCode =
        errorCode === AUTH_CODES.TOKEN_EXPIRED ||
        errorCode === AUTH_CODES.INVALID_TOKEN;
      const isTokenErrorByMessage =
        errorMessage.toLowerCase().includes("expired") ||
        errorMessage.toLowerCase().includes("invalid") ||
        errorMessage.toLowerCase().includes("already used") ||
        errorMessage.toLowerCase().includes("already been used");
      const isTokenError = isTokenErrorByCode || isTokenErrorByMessage;

      let message: string;
      if (
        errorCode === AUTH_CODES.TOKEN_EXPIRED ||
        errorMessage.toLowerCase().includes("expired")
      ) {
        message = "This sign-in link has expired";
      } else if (
        errorCode === AUTH_CODES.INVALID_TOKEN ||
        isTokenErrorByMessage
      ) {
        message = "This sign-in link has already been used or is invalid";
      } else {
        message = errorMessage || "Verification failed";
      }

      return {
        ok: false,
        redirectTo: `/?error=${encodeURIComponent(message)}`,
        errorCode,
        tokenExpiredOrUsed: isTokenError,
      };
    }
  };

  // ---------------------------------------------------------------------------
  // OTP (One-Time Code) Authentication
  // ---------------------------------------------------------------------------

  /**
   * Request a one-time code to be sent to the specified email address.
   * The code is valid for 10 minutes. Rate limits apply (5 codes per email
   * per hour, 20 per IP per hour).
   *
   * @param email - Email address to send the code to
   * @returns Result indicating success
   * @throws AuthError if request fails (e.g., OTP_NOT_ENABLED, RATE_LIMITED)
   */
  const requestOtp = async (email: string): Promise<OtpRequestResult> => {
    const otpLogger = logger.forScope("requestOtp");
    otpLogger.debug("Requesting OTP for:", email);

    try {
      const client = await jsBaoClientService.getClientAsync();
      await client.otpRequest(email);
      otpLogger.debug("OTP request successful");
      return { ok: true };
    } catch (err: unknown) {
      otpLogger.error("OTP request failed:", err);
      throw err;
    }
  };

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
      const client = await jsBaoClientService.getClientAsync();
      const inviteToken = getPendingInviteToken() ?? undefined;
      const result = await client.otpVerify(email, code, { inviteToken });
      if (inviteToken) clearPendingInviteToken();

      otpLogger.debug("OTP verified successfully", {
        userId: result.user.userId,
        isNewUser: result.isNewUser,
      });

      await completeAuthentication();

      return {
        ok: true,
        user: result.user,
        isNewUser: result.isNewUser,
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
      const client = await jsBaoClientService.getClientAsync();
      // Cast result to include isNewUser which is returned by the API but not yet in public types
      const result = (await client.passkeyAuthFinish(
        credential,
        challengeToken
      )) as {
        user: { userId: string; email: string; name?: string };
        isNewUser?: boolean;
      };

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

    const client = await jsBaoClientService.getClientAsync();
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
      const client = await jsBaoClientService.getClientAsync();
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

    const client = await jsBaoClientService.getClientAsync();
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
      const client = await jsBaoClientService.getClientAsync();
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
      const client = await jsBaoClientService.getClientAsync();
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
      const client = await jsBaoClientService.getClientAsync();
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
    | "image/png"
    | "image/jpeg"
    | "image/gif"
    | "image/webp";

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
      const client = await jsBaoClientService.getClientAsync();
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

      const client = await jsBaoClientService.getClientAsync();
      const result = await client.me.uploadAvatar(
        resizedImage,
        outputContentType as AvatarContentType
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
   * Internal helper that loads user profile and initializes preferences.
   * Called by completeAuthentication() - do not call directly.
   */
  const onAuthentication = async (): Promise<void> => {
    const authLogger = logger.forScope("onAuthentication");
    authLogger.debug("Starting: fetching user profile");
    const client = await jsBaoClientService.getClientAsync();
    try {
      const profile = await client.me.get();
      authLogger.debug("Authenticated profile:", profile);
      currentUser.value = profile;
    } catch (e: unknown) {
      authLogger.warn("Failed to fetch profile after authentication:", e);
    }

    authLogger.debug("Authenticated; initializing user preferences...");
    try {
      await initializeUserPrefs();
      authLogger.debug("User preferences initialized successfully");
    } catch (e: unknown) {
      authLogger.warn("initializeUserPrefs error after authentication:", e);
    }
  };

  /**
   * Complete the authentication flow by initializing user data (profile and
   * preferences) and then setting the authenticated state.
   *
   * This is the single entry point for all auth paths to finalize authentication.
   * It ensures preferences are loaded BEFORE isAuthenticated becomes true, which
   * is critical because watchers on isAuthenticated (e.g., document store
   * initialization) may depend on preferences being available.
   *
   * All auth paths (OAuth, magic link, passkey, etc.) should call this method
   * instead of directly manipulating isAuthenticated.
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
      const client = await jsBaoClientService.getClientAsync();
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
      cleanupPrefs();

      // Clear any user-applied theme classes from <html>
      const { clearTheme } = useTheme();
      clearTheme();
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

  // ---------------------------------------------------------------------------
  // User preferences
  // ---------------------------------------------------------------------------

  const initializeUserPrefs = async (): Promise<void> => {
    const prefsInitLogger = logger.forScope("initializeUserPrefs");
    if (rootDocOpen) {
      prefsInitLogger.debug("Already initialized; skipping");
      return;
    }
    prefsInitLogger.debug("Initializing...");
    try {
      const client = await jsBaoClientService.getClientAsync();
      const rootDocId = await client.getRootDocId();
      if (!rootDocId) {
        prefsInitLogger.error(
          "Error initializing user preferences: missing root document ID"
        );
        return;
      }
      await client.documents.open(rootDocId);
      rootDocumentId = rootDocId;
      rootDocOpen = true;
      setupPrefsSubscription();
      await loadUserPrefs();
      prefsInitLogger.debug("User preferences initialized successfully");
    } catch (error) {
      prefsInitLogger.error("Error initializing user preferences:", error);
    }
  };

  const setupPrefsSubscription = (): void => {
    if (prefsUnsubscribe) return;
    logger.debug("Setting up preferences subscription...");
    prefsUnsubscribe = UserPref.subscribe(() => {
      logger.debug("UserPref model changed, reloading preferences...");
      loadUserPrefs();
    });
  };

  const loadUserPrefs = async (): Promise<void> => {
    const loadPrefsLogger = logger.forScope("loadUserPrefs");
    try {
      loadPrefsLogger.debug("Loading user preferences...");
      const prefs = await UserPref.query({});
      const prefsObject: UserPrefsMap = {};
      const garbageKeys: string[] = [];
      for (const pref of prefs.data) {
        if (
          !pref.key ||
          pref.key === "undefined" ||
          pref.value === undefined ||
          pref.value === "undefined"
        ) {
          garbageKeys.push(pref.key);
          continue;
        }
        try {
          prefsObject[pref.key] = JSON.parse(pref.value) as unknown;
        } catch (error) {
          loadPrefsLogger.warn(`Failed to parse pref ${pref.key}:`, error);
          prefsObject[pref.key] = pref.value;
        }
      }
      userPrefs.value = prefsObject;
      loadPrefsLogger.debug(
        "User preferences loaded:",
        Object.keys(prefsObject)
      );
      if (garbageKeys.length > 0) {
        loadPrefsLogger.debug("Cleaning up garbage prefs", { garbageKeys });
        await cleanupGarbagePrefs();
      }
    } catch (error) {
      loadPrefsLogger.error("Error loading user preferences:", error);
    }
  };

  const cleanupGarbagePrefs = async (): Promise<void> => {
    const cleanupLogger = logger.forScope("cleanupGarbagePrefs");
    try {
      const allPrefs = await UserPref.query({});
      for (const pref of allPrefs.data) {
        if (
          !pref.key ||
          pref.key === "undefined" ||
          pref.value === undefined ||
          pref.value === "undefined"
        ) {
          try {
            await pref.delete();
          } catch (error) {
            cleanupLogger.debug("Failed to delete garbage pref", { error });
          }
        }
      }
    } catch (error) {
      cleanupLogger.debug("Cleanup failed", { error });
    }
  };

  const cleanupPrefs = (): void => {
    if (prefsUnsubscribe) {
      try {
        prefsUnsubscribe();
      } catch {}
      prefsUnsubscribe = null;
    }
    userPrefs.value = {};
    rootDocOpen = false;
    rootDocumentId = null;
  };

  /**
   * Get a user preference value.
   *
   * @param key - The preference key
   * @param defaultValue - Value to return if the preference is not set
   * @returns The stored preference value or the default
   */
  const getPref = <T = unknown>(key: string, defaultValue: T): T => {
    const value = userPrefs.value[key];
    if (value === undefined) {
      return defaultValue;
    }
    return value as T;
  };

  /**
   * Set a user preference value. The value is JSON-serialized and stored
   * in the user's root document for cross-device sync.
   *
   * @param key - The preference key
   * @param value - The value to store (must be JSON-serializable)
   * @throws Error if user is not authenticated
   */
  const setPref = async <T = unknown>(key: string, value: T): Promise<void> => {
    const setPrefLogger = logger.forScope("setPref");
    try {
      setPrefLogger.debug("Request", {
        key,
        valuePreview: (() => {
          try {
            return JSON.stringify(value).slice(0, 200);
          } catch {
            return String(value);
          }
        })(),
      });
      if (typeof key !== "string" || key.length === 0 || key === "undefined") {
        throw new Error(`setPref called with invalid key: ${String(key)}`);
      }
      if (value === undefined) {
        throw new Error(
          `setPref called with undefined value for key "${key}". ` +
            "Use deletePref() to remove a preference."
        );
      }
      if (!isAuthenticated.value) throw new Error("User not authenticated");
      if (!rootDocOpen) {
        logger.log("Root doc not open; initializing...");
        await initializeUserPrefs();
      }
      if (!rootDocumentId) throw new Error("Root document not initialized");
      const serializedValue = JSON.stringify(value);

      // WORKAROUND: upsertByUnique creates duplicates instead of updating.
      // Delete all existing records with this key first, then create a new one.
      const existingPrefs = await UserPref.query({ key });
      for (const pref of existingPrefs.data) {
        await pref.delete();
      }

      const newPref = new UserPref();
      newPref.key = key;
      newPref.value = serializedValue;
      await newPref.save({ targetDocument: rootDocumentId });
    } catch (error) {
      setPrefLogger.error(`Error setting pref ${key}:`, error);
      throw error;
    }
  };

  /**
   * Delete a user preference.
   *
   * @param key - The preference key to delete
   * @throws Error if user is not authenticated
   */
  const deletePref = async (key: string): Promise<void> => {
    const deletePrefLogger = logger.forScope("deletePref");
    try {
      deletePrefLogger.debug("Request", { key });
      if (!isAuthenticated.value) throw new Error("User not authenticated");
      const prefs = await UserPref.query({ key });
      deletePrefLogger.debug("Found records", { count: prefs.data.length });
      for (const pref of prefs.data) await pref.delete();
    } catch (error) {
      deletePrefLogger.error(`Error deleting pref ${key}:`, error);
      throw error;
    }
  };

  /**
   * Get a snapshot of all user preferences.
   *
   * @returns Object containing all preference key-value pairs
   */
  const getAllPrefs = (): UserPrefsMap => ({ ...userPrefs.value });

  /**
   * Re-query all UserPref objects from js-bao and refresh the in-memory cache.
   * Useful when prefs may have been loaded before the root doc finished syncing.
   */
  const refreshPrefs = async (): Promise<void> => {
    await loadUserPrefs();
  };

  /**
   * Delete all user preferences.
   *
   * @throws Error if user is not authenticated
   */
  const clearAllPrefs = async (): Promise<void> => {
    const clearAllLogger = logger.forScope("clearAllPrefs");
    try {
      clearAllLogger.debug("Request");
      if (!isAuthenticated.value) throw new Error("User not authenticated");
      const prefs = await UserPref.query({});
      clearAllLogger.debug("Found records", {
        count: prefs.data.length,
      });
      for (const pref of prefs.data) await pref.delete();
    } catch (error) {
      clearAllLogger.error("Error clearing all prefs:", error);
      throw error;
    }
  };

  return {
    // state
    currentUser,
    isAuthenticated,
    isOnline,
    isInitialized,
    authConfig,

    // getters
    isAdmin,

    // actions
    initialize,
    login,
    handleOAuthCallback,
    logout,

    // magic link
    requestMagicLink,

    // otp (one-time code)
    requestOtp,
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

    // prefs helpers
    getPref,
    setPref,
    deletePref,
    getAllPrefs,
    refreshPrefs,
    clearAllPrefs,
  };
});
