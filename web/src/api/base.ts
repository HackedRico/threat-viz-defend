// =============================================================================
// Module Overview
// =============================================================================
// Where the API lives. The web app may be served from its own domain with the
// API on another, so every request and every URL shown to the user starts from
// `API_BASE`. Empty means same origin, which is also what the dev proxy uses.

/** The API's base URL from `VITE_API_BASE_URL`, without a trailing slash; empty for same origin. */
export const API_BASE: string = (import.meta.env.VITE_API_BASE_URL ?? "").trim().replace(/\/+$/, "");

/** The API origin to show in setup text for coding agents: `API_BASE` when set, else this page's origin. */
export function apiOrigin(): string {
  return API_BASE || window.location.origin;
}

/** An absolute or same-origin URL for an API path such as `/api/boards`. */
export function apiUrl(path: string): string {
  return `${API_BASE}${path}`;
}
