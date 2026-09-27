import { useEffect, useRef } from "react";

import type { ConfigOut, MeOut } from "../api/types.ts";
import { ThemeSwitch } from "../shell/ThemeSwitch.tsx";
import { usePathname } from "../shell/useRoute.ts";
import { AccountForm } from "./AccountForm.tsx";
import { authView, isFormPath } from "./authView.ts";
import { Landing } from "./Landing.tsx";
import { ViewLink } from "./ViewLink.tsx";
import "./AuthScreen.css";

// =============================================================================
// Module Overview
// =============================================================================
// Everything a visitor sees before signing in: a header with the brand and the
// theme switch, the home page or an account form picked from the URL by
// `authView`, and a footer. Switching screens scrolls to the top and moves
// focus to the new heading, as loading a new page would.

/** The signed-out screens: the home page, sign in and create account. */
export function AuthScreen({ config, onSignedIn }: { config: ConfigOut; onSignedIn: (me: MeOut) => void }) {
  const view = authView(usePathname());
  const headingRef = useRef<HTMLHeadingElement>(null);
  const shown = useRef(view);

  useEffect(() => {
    if (shown.current === view) return;
    shown.current = view;
    window.scrollTo(0, 0);
    headingRef.current?.focus({ preventScroll: true });
  }, [view]);

  const signedIn = (me: MeOut) => {
    // Rewritten without a route event, so this screen never flashes the home page on its way out.
    if (isFormPath(location.pathname)) history.replaceState(null, "", "/");
    onSignedIn(me);
  };

  return (
    <div className="auth">
      <header className="auth-header">
        <ViewLink view="home" className="auth-brand" aria-label={`${config.app_name} home`}>
          <span className="auth-brand-mark" aria-hidden="true">
            {"//"}
          </span>
          {config.app_name}
        </ViewLink>
        <div className="auth-header-end">
          <span className="auth-caps auth-header-label">
            Code risks / visualized <span className="auth-dot" aria-hidden="true" />
          </span>
          <ThemeSwitch compact />
        </div>
      </header>

      <main className="auth-main">
        {view === "home" ? (
          <Landing config={config} headingRef={headingRef} />
        ) : (
          <AccountForm key={view} mode={view} config={config} onSignedIn={signedIn} headingRef={headingRef} />
        )}
      </main>

      <footer className="auth-caps auth-footer">
        <span>{config.app_name}</span>
        <span>Built at hackUMBC 2026</span>
      </footer>
    </div>
  );
}
