/**
 * @module signInState
 *
 * The app's own data on an emailed sign-in link: where to continue after
 * sign-in, the address the link was sent to (so an expired link can be resent
 * from any tab or browser), and a pending invite token. It rides on the link
 * as a base64 JSON `state` parameter.
 *
 * The client decides where the link lands (`emailSignInLinkTarget()`) and
 * which URLs are sign-in callbacks (`handleSignInCallback()`), and it hands a
 * successful callback's bag back decoded. `readStateBag` is for the other
 * case: a link that failed (expired, already used), where the page still
 * needs the address and the continue URL.
 */

/** What the app carries across the email round trip. */
export interface SignInStateBag {
  continueUrl?: string;
  email?: string;
  inviteToken?: string;
}

const FIELDS = ["continueUrl", "email", "inviteToken"] as const;

function encode(bag: SignInStateBag): string {
  const kept: SignInStateBag = {};
  for (const field of FIELDS) {
    if (typeof bag[field] === "string") kept[field] = bag[field];
  }
  const bytes = new TextEncoder().encode(JSON.stringify(kept));
  return btoa(String.fromCharCode(...bytes));
}

/** `target` with the bag added as its `state` parameter. */
export function withStateBag(target: string, bag: SignInStateBag): string {
  const separator = target.includes("?") ? "&" : "?";
  return `${target}${separator}state=${encodeURIComponent(encode(bag))}`;
}

/**
 * The `redirectUri` for an email sign-in request: the client's link target
 * with the bag on it, or `null` (a code-only email) when the client has no
 * target.
 */
export function emailSignInRedirect(
  target: string | null,
  bag: SignInStateBag
): string | null {
  return target ? withStateBag(target, bag) : null;
}

/**
 * The bag a link's query carries (`window.location.search`), or `null` when
 * there is none or it is not one this app wrote. Never throws.
 */
export function readStateBag(search: string): SignInStateBag | null {
  const raw = new URLSearchParams(search).get("state");
  if (!raw) return null;
  try {
    // A `+` that a mail client or a copy-paste turned into a space.
    const binary = atob(raw.replace(/ /g, "+"));
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return null;
    const fields = parsed as Record<string, unknown>;
    const bag: SignInStateBag = {};
    for (const field of FIELDS) {
      const value = fields[field];
      if (typeof value === "string") bag[field] = value;
    }
    return bag;
  } catch {
    return null;
  }
}
