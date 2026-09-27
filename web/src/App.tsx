import { useCallback, useEffect, useMemo, useState } from "react";

import { api, ApiError, errorMessage, onSignedOut } from "./api/client.ts";
import type { ConfigOut, MeOut } from "./api/types.ts";
import { AuthScreen } from "./auth/AuthScreen.tsx";
import { useMemory } from "./settings/memory.ts";
import { useProvider } from "./settings/provider.ts";
import { SessionContext, FALLBACK_APP_NAME, type Session } from "./shell/session.tsx";
import { Mascot } from "./shell/Mascot.tsx";
import { Shell } from "./shell/Shell.tsx";
import "./App.css";

// =============================================================================
// Module Overview
// =============================================================================
// The top of the app: loads the deployment config and the current user, then
// shows the signed-out screens or the signed-in `Shell`. Any call that finds
// the session gone drops back to sign in; signing out goes to the home page.

type Load = { state: "loading" } | { state: "failed"; message: string } | { state: "ready"; config: ConfigOut };

/** The whole app. */
export function App() {
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [me, setMe] = useState<MeOut | null>(null);
  const [checked, setChecked] = useState(false);

  const start = useCallback(async () => {
    setLoad({ state: "loading" });
    try {
      const config = await api.config();
      document.title = config.app_name;
      setLoad({ state: "ready", config });
    } catch (error) {
      setLoad({ state: "failed", message: errorMessage(error) });
      return;
    }
    try {
      setMe(await api.me());
    } catch (error) {
      // 401 simply means nobody is signed in yet; anything else is worth saying.
      if (!(error instanceof ApiError && error.signedOut)) setLoad({ state: "failed", message: errorMessage(error) });
    } finally {
      setChecked(true);
    }
  }, []);

  useEffect(() => {
    void start();
  }, [start]);

  useEffect(() => onSignedOut(() => setMe(null)), []);

  // Signing out, deliberately or by an expired session, forgets per-account state kept outside React.
  useEffect(() => {
    if (me === null) {
      useProvider.getState().reset();
      useMemory.getState().reset();
    }
  }, [me]);

  const refreshMe = useCallback(() => {
    api.me().then(setMe, () => undefined);
  }, []);

  const signOut = useCallback(async () => {
    try {
      await api.logout();
    } finally {
      // Only a deliberate sign out goes home; an expired session keeps its path, so signing in again returns there.
      history.replaceState(null, "", "/");
      setMe(null);
    }
  }, []);

  const session = useMemo<Session | null>(
    () => (load.state === "ready" && me !== null ? { config: load.config, me, refreshMe, signOut } : null),
    [load, me, refreshMe, signOut],
  );

  if (load.state === "failed") {
    return (
      <main className="app-status">
        <p className="hand app-status-title">{FALLBACK_APP_NAME}</p>
        <p role="alert">{load.message}</p>
        <button type="button" className="btn btn-primary" onClick={() => void start()}>
          Try again
        </button>
      </main>
    );
  }
  if (load.state === "loading" || !checked) {
    return (
      <main className="app-status" aria-busy="true">
        <p className="hand app-status-title">{load.state === "ready" ? load.config.app_name : FALLBACK_APP_NAME}</p>
        <Mascot mood="alert" />
        <span className="spinner" aria-label="Loading" />
      </main>
    );
  }
  if (session === null) return <AuthScreen config={load.config} onSignedIn={setMe} />;
  return (
    <SessionContext value={session}>
      <Shell />
    </SessionContext>
  );
}
