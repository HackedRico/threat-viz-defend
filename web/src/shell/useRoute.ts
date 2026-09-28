import { useSyncExternalStore } from "react";

import { mayLeave, parseRoute, routePath, type Route } from "./route.ts";

// =============================================================================
// Module Overview
// =============================================================================
// Binds `Route` to the browser history. `useRoute` re-renders on back and
// forward and on `navigate`, which pushes a new entry without a page load once
// `mayLeave` agrees. `usePathname` and `navigatePath` do the same with a bare
// path, for the screens shown before signing in.

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

/** The URL path without its query string, kept in step with the URL. */
export function usePathname(): string {
  const url = useSyncExternalStore(subscribe, snapshot);
  return url.split("?")[0] ?? "/";
}

/** Go to `route` unless unsaved work keeps the user here; `replace` swaps the current history entry instead of adding one. */
export function navigate(route: Route, replace = false): void {
  navigatePath(routePath(route), replace);
}

/** Go to a path such as `/signin` unless unsaved work keeps the user here; `replace` swaps the current history entry instead of adding one. */
export function navigatePath(path: string, replace = false): void {
  if (path === snapshot()) return;
  // A replace only corrects where the user already is, such as home after deleting the board, so it never asks.
  if (!replace && !mayLeave()) return;
  if (replace) history.replaceState(null, "", path);
  else history.pushState(null, "", path);
  window.dispatchEvent(new Event(CHANGE));
}
