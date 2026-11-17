/**
 * @module inviteLanding
 *
 * The decision rules behind the invitation page (`/invite/accept`), kept free
 * of Vue and the client so they can be read and tested on their own.
 *
 * The page resolves one token (`landingToken`), reads the invitation preview
 * once, and picks what to show (`landingStep`). The store uses
 * `inviteTokenAfterSignIn` to record which token a finished sign-in carried.
 */
import { isPlausibleInviteToken } from "./inviteToken";

/** Where the page found its token: the link itself, or one of the two session slots. */
export type LandingSource = "url" | "pending" | "carried";

/** The token the page works from, or why it has none. */
export type LandingToken =
  { token: string; source: LandingSource } | "missing" | "invalid";

/**
 * What the preview said: its `status`, `"not-found"` for an unknown or revoked
 * token, or `"unavailable"` when it could not be read (rate limit, network).
 */
export type LandingPreview =
  { status: "pending" | "expired" | "accepted" } | "not-found" | "unavailable";

/**
 * What the page does next. `accepted` is deliberately not among these: the
 * page shows it only after its own accept call answers.
 */
export type LandingStep =
  | "needs-signin"
  | "confirm"
  | "accept"
  | "accepted-on-return"
  | "already-accepted"
  | "unconfirmed"
  | "expired"
  | "token-invalid";

function present(value: string | null | undefined): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * Pick the token the page works from: the link's own token first, then the
 * one waiting for a sign-in, then the one the last sign-in carried. A token
 * that fails {@link isPlausibleInviteToken} answers `"invalid"`.
 *
 * @example
 * ```ts
 * landingToken({ urlToken: null, pendingToken: null, carriedToken: tok });
 * // { token: tok, source: "carried" }
 * ```
 */
export function landingToken(slots: {
  urlToken: string | null | undefined;
  pendingToken: string | null | undefined;
  carriedToken: string | null | undefined;
}): LandingToken {
  const candidates: Array<[LandingSource, string | null | undefined]> = [
    ["url", slots.urlToken],
    ["pending", slots.pendingToken],
    ["carried", slots.carriedToken],
  ];
  for (const [source, token] of candidates) {
    if (!present(token)) continue;
    return isPlausibleInviteToken(token) ? { token, source } : "invalid";
  }
  return "missing";
}

/**
 * Decide what the page shows for a token, given who is looking and what the
 * preview said.
 *
 * A `carried` token was sent by the sign-in that just finished, so an
 * accepted invitation most likely means that sign-in accepted it, and an
 * unreadable preview must not trigger a second accept. A `pending` token was
 * not sent by the sign-in (a passkey sign-in sends none), so the page accepts
 * it now.
 *
 * @example
 * ```ts
 * landingStep({ source: "carried", signedIn: true, preview: { status: "accepted" } });
 * // "accepted-on-return"
 * ```
 */
export function landingStep(input: {
  source: LandingSource;
  signedIn: boolean;
  preview: LandingPreview;
}): LandingStep {
  const { source, signedIn, preview } = input;
  if (preview === "not-found") return "token-invalid";
  if (preview !== "unavailable" && preview.status === "expired")
    return "expired";

  if (!signedIn) {
    if (preview === "unavailable") return "needs-signin";
    return preview.status === "accepted" ? "already-accepted" : "needs-signin";
  }

  if (preview === "unavailable") {
    if (source === "url") return "confirm";
    return source === "carried" ? "unconfirmed" : "accept";
  }

  if (preview.status === "accepted") {
    return source === "carried" ? "accepted-on-return" : "already-accepted";
  }

  return source === "url" ? "confirm" : "accept";
}

/**
 * The token a finished sign-in carried: the pending one, else a plausible
 * `inviteToken` in the sign-in link's decoded state bag (a link opened in
 * another tab or browser has no pending token), else null.
 */
export function inviteTokenAfterSignIn(
  pendingToken: string | null | undefined,
  stateBag: Record<string, unknown> | null | undefined
): string | null {
  if (present(pendingToken)) return pendingToken;
  const fromBag = stateBag?.inviteToken;
  return isPlausibleInviteToken(fromBag) ? fromBag : null;
}
