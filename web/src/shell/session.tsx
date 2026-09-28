import { createContext, useContext } from "react";

import type { ConfigOut, MeOut } from "../api/types.ts";

// =============================================================================
// Module Overview
// =============================================================================
// The signed-in session every screen reads: deployment config, the user and
// their usage. `App` provides it; `useSession` reads it.

/** Name shown before the server's config arrives; everywhere else reads `config.app_name`. */
export const FALLBACK_APP_NAME = "ThreatViz Defend";

/** The session as screens see it. */
export interface Session {
  config: ConfigOut;
  me: MeOut;
  refreshMe: () => void;
  /** Ends the session on the server, then shows the signed-out screens; rejects, still signed in, when that fails. */
  signOut: () => Promise<void>;
}

export const SessionContext = createContext<Session | null>(null);

/** Read the session; only valid below `App` once signed in. */
export function useSession(): Session {
  const session = useContext(SessionContext);
  if (session === null) throw new Error("`useSession` needs a signed-in `SessionContext` provider above it.");
  return session;
}
