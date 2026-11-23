/**
 * @module inviteToken
 *
 * sessionStorage helpers for carrying an `inviteToken` across signup/auth
 * round-trips. Two slots, never both set through these helpers:
 *
 * - **pending**: a token waiting to be sent with the next sign-in. The
 *   /invite/accept page stores it for a signed-out invitee, and the auth
 *   methods in `userStore` send it with otpVerify / passkeyRegisterFinish /
 *   the sign-in callback / OAuth start.
 * - **carried**: the token the last completed sign-in sent (or the page's own
 *   accept just used). The page reads it when the visitor returns. It is never
 *   sent to a sign-in, so a used token cannot fail a later one.
 *
 * For OAuth and emailed links the token also rides in the state bag, which
 * survives a round-trip through another tab or browser.
 */

const PENDING_KEY = "primitive:pendingInviteToken";
const CARRIED_KEY = "primitive:carriedInviteToken";

/**
 * Loose validation for invite tokens. The platform issues opaque strings;
 * we only check that callers haven't handed us obvious garbage.
 */
export function isPlausibleInviteToken(token: unknown): token is string {
  return (
    typeof token === "string" &&
    token.length >= 16 &&
    token.length <= 512 &&
    /^[A-Za-z0-9._~+/=-]+$/.test(token)
  );
}

/** Store a token for the next sign-in. A new flow supersedes the last one, so this also empties the carried slot. */
export function setPendingInviteToken(token: string): void {
  if (typeof sessionStorage === "undefined") return;
  sessionStorage.removeItem(CARRIED_KEY);
  sessionStorage.setItem(PENDING_KEY, token);
}

/** The token waiting for the next sign-in, or null. */
export function getPendingInviteToken(): string | null {
  if (typeof sessionStorage === "undefined") return null;
  return sessionStorage.getItem(PENDING_KEY);
}

/** Empty the pending slot. */
export function clearPendingInviteToken(): void {
  if (typeof sessionStorage === "undefined") return;
  sessionStorage.removeItem(PENDING_KEY);
}

/** Record that a sign-in (or the page's accept) used `token`: empty pending, store it as carried. */
export function settleInviteToken(token: string): void {
  if (typeof sessionStorage === "undefined") return;
  sessionStorage.removeItem(PENDING_KEY);
  sessionStorage.setItem(CARRIED_KEY, token);
}

/** The token the last completed sign-in carried, or null. */
export function getCarriedInviteToken(): string | null {
  if (typeof sessionStorage === "undefined") return null;
  return sessionStorage.getItem(CARRIED_KEY);
}

/** Empty the carried slot. */
export function clearCarriedInviteToken(): void {
  if (typeof sessionStorage === "undefined") return;
  sessionStorage.removeItem(CARRIED_KEY);
}

/** Empty both slots. */
export function clearInviteTokens(): void {
  if (typeof sessionStorage === "undefined") return;
  sessionStorage.removeItem(PENDING_KEY);
  sessionStorage.removeItem(CARRIED_KEY);
}
