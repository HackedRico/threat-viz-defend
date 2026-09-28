// =============================================================================
// Module Overview
// =============================================================================
// The app's few screens as a typed `Route`, read from and written to the URL
// path. The server answers every unknown path with the app, so links such as
// the `/boards/<id>` review links coding agents print open the right board.
// A screen with unsaved work sets `guardLeaving`, and `mayLeave` asks it.

/** A part of the settings screen. */
export type SettingsSection = "agents" | "provider" | "memory";

// The path under `/settings` for each section; coding agents sit at the bare path.
const SECTION_PATH: Record<SettingsSection, string> = {
  agents: "/settings",
  provider: "/settings/provider",
  memory: "/settings/memory",
};

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
    const section: SettingsSection = parts[1] === "provider" || parts[1] === "memory" ? parts[1] : "agents";
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
      const base = SECTION_PATH[route.section];
      return route.boardId ? `${base}?board=${encodeURIComponent(route.boardId)}` : base;
    }
  }
}

// Only one board is open at a time, so one screen at most holds unsaved work.
let leaveGuard: (() => boolean) | null = null;

/** Make `mayLeave` call `ask`, which returns true to go on, until the returned function lets go. */
export function guardLeaving(ask: () => boolean): () => void {
  leaveGuard = ask;
  return () => {
    // A screen that took over the slot keeps it, whichever order two screens swap in.
    if (leaveGuard === ask) leaveGuard = null;
  };
}

/** True when no screen holds unsaved work, or the user agrees to lose it. */
export function mayLeave(): boolean {
  return leaveGuard === null || leaveGuard();
}

function safeDecode(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    // A malformed escape in a hand-typed URL is kept as typed rather than crashing the app.
    return part;
  }
}
