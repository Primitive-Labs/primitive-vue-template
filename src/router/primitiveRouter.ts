/**
 * @module primitiveRouter
 *
 * Vue Router factory with auth-aware routing built in.
 *
 * Each route declares two orthogonal things in
 * `meta.primitiveRouterMeta`:
 *
 *   - `requireSignIn` — boolean. When true, an unauthenticated visitor
 *     is redirected to the configured login route (with a `continueURL`
 *     query param). Public routes set this to false.
 *   - `authCheck` — optional predicate. Receives an `AuthContext` and
 *     the destination route, returns either `true` (allow) or a
 *     redirect target — a route name string or any vue-router
 *     `RouteLocationRaw`.
 *
 * The two axes compose: a route can require sign-in, then run an
 * additional check against the signed-in user (e.g. a role, or a custom
 * rule).
 *
 * `authCheck` only runs after the sign-in gate — it never sees an
 * unauthenticated user. A predicate that throws is treated as a
 * fail-closed denial and the user is sent to `homeRouteName`.
 */
import { appBaseLogger } from "@/lib/logger";
import { buildRouteOrUrl } from "@/lib/routeOrUrl";
import { useUserStore } from "@/stores/userStore";
import type { UserProfile } from "js-bao-wss-client";
import {
  createRouter,
  createWebHistory,
  type RouteLocationNormalized,
  type RouteLocationRaw,
  type RouteRecordRaw,
  type Router,
  type RouterHistory,
} from "vue-router";

/**
 * Helpers passed to an `authCheck` predicate. The names mirror the CEL
 * helpers used in database operation `access` rules so the same intent
 * reads the same on client and server.
 */
export interface AuthContext {
  /** The signed-in user. Never null inside an `authCheck` (which only runs after the sign-in gate). */
  user: UserProfile;
  /** True if the user is signed in. Always true inside `authCheck`. */
  isMember: boolean;
  /** True if the user has the `admin` app role. */
  isAdmin: boolean;
  /** Whether the user has the given app role (e.g. "admin", "member"). */
  hasRole(role: string): boolean;
}

/**
 * `authCheck` returns either `true` (allow) or a redirect target. The
 * redirect target follows vue-router's `RouteLocationRaw`, plus the
 * shorthand of a bare string treated as a route name.
 */
export type AuthCheckResult = true | string | RouteLocationRaw;

export type AuthCheck = (
  ctx: AuthContext,
  to: RouteLocationNormalized
) => AuthCheckResult;

/**
 * Per-route metadata under `meta.primitiveRouterMeta`.
 *
 * `requireSignIn` is required so the intent for every route is
 * explicit. Set it to `false` for public routes.
 */
export interface PrimitiveRouterMeta {
  /** True → unauthenticated users are redirected to login. */
  requireSignIn: boolean;
  /** Optional additional check, run only after the sign-in gate. */
  authCheck?: AuthCheck;
}

export interface CreatePrimitiveRouterOptions {
  routes: RouteRecordRaw[];
  history?: RouterHistory;
  /** External URL to redirect unauthenticated users to. */
  loginUrl?: string;
  /** Named login route to redirect unauthenticated users to. */
  loginRouteName?: string;
  /** Fallback route for predicates that throw (defaults to `"home"`). */
  homeRouteName?: string;
}

function buildAuthContext(user: ReturnType<typeof useUserStore>): AuthContext {
  if (!user.currentUser) {
    throw new Error(
      "[primitiveRouter] buildAuthContext called without a current user — this is a bug"
    );
  }
  const profile = user.currentUser;
  return {
    user: profile,
    isMember: true,
    isAdmin: user.isAdmin,
    hasRole: (role) => profile.appRole === role,
  };
}

export function createPrimitiveRouter(
  options: CreatePrimitiveRouterOptions
): Router {
  const logger = appBaseLogger.forScope("PrimitiveRouterGuard");

  const loginTarget = buildRouteOrUrl(options.loginUrl, options.loginRouteName);
  const homeRouteName = options.homeRouteName ?? "home";

  const router = createRouter({
    history:
      options.history ??
      createWebHistory(
        typeof import.meta !== "undefined" &&
          typeof (import.meta as { env?: unknown }).env === "object" &&
          (import.meta as { env?: { BASE_URL?: string } }).env?.BASE_URL
          ? (import.meta as { env: { BASE_URL: string } }).env.BASE_URL
          : "/"
      ),
    routes: options.routes,
  });

  router.beforeEach((to) => {
    const meta = to.meta.primitiveRouterMeta;
    if (!meta) {
      throw new Error(
        `[primitiveRouter] Route "${String(to.name ?? to.fullPath)}" is missing meta.primitiveRouterMeta. ` +
          `Every route must declare { requireSignIn: boolean }.`
      );
    }
    const { requireSignIn, authCheck } = meta;
    const user = useUserStore();

    logger.debug("Evaluating route", {
      to: { name: to.name, path: to.fullPath },
      requireSignIn,
      hasAuthCheck: Boolean(authCheck),
      userState: {
        isInitialized: user.isInitialized,
        isAuthenticated: user.isAuthenticated,
        isAdmin: user.isAdmin,
      },
    });

    // Public route — bypass everything.
    if (!requireSignIn && !authCheck) {
      return true;
    }

    if (!user.isInitialized) {
      throw new Error(
        "[primitiveRouter] userStore must be initialized before navigating to protected routes. " +
          "Call useUserStore().initialize() and await it before mounting the app."
      );
    }

    // Axis 1: sign-in gate.
    if (requireSignIn && !user.isAuthenticated) {
      if ("routeName" in loginTarget && to.name === loginTarget.routeName) {
        return true;
      }
      if ("routeName" in loginTarget) {
        return {
          name: loginTarget.routeName,
          query: { continueURL: to.fullPath },
        };
      }
      if (typeof window !== "undefined" && "url" in loginTarget) {
        const redirectUrl = new URL(loginTarget.url, window.location.origin);
        redirectUrl.searchParams.set("continueURL", to.fullPath);
        window.location.href = redirectUrl.toString();
      }
      return false;
    }

    // Axis 2: authCheck. Only runs for authenticated users.
    if (authCheck && user.isAuthenticated) {
      let result: AuthCheckResult;
      try {
        result = authCheck(buildAuthContext(user), to);
      } catch (error) {
        logger.error("authCheck threw; treating as fail-closed denial", error);
        return { name: homeRouteName };
      }
      if (result === true) {
        return true;
      }
      logger.debug("authCheck denied; redirecting", { result });
      if (typeof result === "string") {
        return { name: result };
      }
      return result;
    }

    return true;
  });

  return router;
}
