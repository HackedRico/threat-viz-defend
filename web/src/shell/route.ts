// =============================================================================
// Module Overview
// =============================================================================
// The app's few screens as a typed `Route`, read from and written to the URL
// path. The server answers every unknown path with the app, so links such as
// the `/boards/<id>` review links coding agents print open the right board.

/** A part of the settings screen. */
export type SettingsSection = "agents" | "provider";

/** A screen in the app. */
export type Route =
  | { name: "home" }
  | { name: "board"; boardId: string }
  | { name: "settings"; section: SettingsSection; boardId: string | null };

/** Read a route from a path and query string; unknown paths go home. */
export function parseRoute(pathname: string, search = ""): Route {
  const parts = pathname.split("/").filter(Boolean).map(safeDecode);
  if (parts[0] === "boards" && parts[1]) return { name: "board", boardId: parts[1] };
  if (parts[0] === "settings") {
    const section: SettingsSection = parts[1] === "provider" ? "provider" : "agents";
    return { name: "settings", section, boardId: new URLSearchParams(search).get("board") };
  }
  return { name: "home" };
}

/** The URL path, with query string, for a route. */
export function routePath(route: Route): string {
  switch (route.name) {
    case "home":
      return "/";
    case "board":
      return `/boards/${encodeURIComponent(route.boardId)}`;
    case "settings": {
      const base = route.section === "provider" ? "/settings/provider" : "/settings";
      return route.boardId ? `${base}?board=${encodeURIComponent(route.boardId)}` : base;
    }
  }
}

function safeDecode(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    // A malformed escape in a hand-typed URL is kept as typed rather than crashing the app.
    return part;
  }
}
