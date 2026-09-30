import type { Router } from "vue-router";
import { appBaseLogger } from "./logger";

/**
 * Describes a navigation target that can be expressed either as a
 * named Vue Router route or as a raw URL string.
 *
 * Exactly one of `routeName` or `url` should be provided.
 */
export type RouteOrUrl =
  | {
      routeName: string;
      url?: never;
    }
  | {
      url: string;
      routeName?: never;
    };

/**
 * Build a `RouteOrUrl` value from optional URL / route name inputs,
 * enforcing that exactly one is provided and that it is non-empty.
 */
export function buildRouteOrUrl(url?: string, routeName?: string): RouteOrUrl {
  const hasUrl = typeof url === "string" && url.length > 0;
  const hasRouteName = typeof routeName === "string" && routeName.length > 0;

  if ((hasUrl && hasRouteName) || (!hasUrl && !hasRouteName)) {
    throw new Error("Exactly one of URL or routeName must be provided.");
  }

  return hasRouteName ? { routeName } : { url: url as string };
}

/**
 * Resolve a `RouteOrUrl` value into a concrete href string using the
 * provided Vue Router instance.
 */
export function resolveRouteOrUrl(router: Router, target: RouteOrUrl): string {
  const logger = appBaseLogger.forScope("resolveRouteOrUrl");

  if ("routeName" in target) {
    try {
      const resolved = router.resolve({ name: target.routeName });
      return resolved.href;
    } catch (error) {
      logger.error("Failed to resolve route", target.routeName, error);
      throw new Error(`Failed to resolve route "${target.routeName}".`);
    }
  }

  return target.url;
}
