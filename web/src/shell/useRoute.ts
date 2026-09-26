import { useSyncExternalStore } from "react";

import { parseRoute, routePath, type Route } from "./route.ts";

// =============================================================================
// Module Overview
// =============================================================================
// Binds `Route` to the browser history. `useRoute` re-renders on back and
// forward and on `navigate`, which pushes a new entry without a page load.

const CHANGE = "routechange";

function subscribe(onChange: () => void): () => void {
  window.addEventListener("popstate", onChange);
  window.addEventListener(CHANGE, onChange);
  return () => {
    window.removeEventListener("popstate", onChange);
    window.removeEventListener(CHANGE, onChange);
  };
}

// useSyncExternalStore compares snapshots by identity, so the snapshot is the URL string.
const snapshot = (): string => location.pathname + location.search;

/** The current route, kept in step with the URL. */
export function useRoute(): Route {
  const url = useSyncExternalStore(subscribe, snapshot);
  const [pathname, search = ""] = url.split("?");
  return parseRoute(pathname ?? "/", search ? `?${search}` : "");
}

/** Go to `route`; `replace` swaps the current history entry instead of adding one. */
export function navigate(route: Route, replace = false): void {
  const path = routePath(route);
  if (path === snapshot()) return;
  if (replace) history.replaceState(null, "", path);
  else history.pushState(null, "", path);
  window.dispatchEvent(new Event(CHANGE));
}
