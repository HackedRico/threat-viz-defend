import { useId, useState, type FormEvent } from "react";

import { api, errorMessage } from "../api/client.ts";
import type { ConfigOut, MeOut } from "../api/types.ts";
import { BoardSketch } from "../shell/BoardSketch.tsx";
import "./AuthScreen.css";

// =============================================================================
// Module Overview
// =============================================================================
// Sign in and create account on one screen. Creating an account needs the
// invite code handed out in person. The form carries a `website` honeypot that
// people never see; bots that fill every field reveal themselves with it.

type Mode = "signin" | "signup";

const MIN_PASSWORD = 10;

/** The sign in and create account screen. */
export function AuthScreen({ config, onSignedIn }: { config: ConfigOut; onSignedIn: (me: MeOut) => void }) {
  const [mode, setMode] = useState<Mode>("signin");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [website, setWebsite] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ids = useId();
  const signup = mode === "signup";

  const problem = (): string | null => {
    if (!signup) return username.trim() && password ? null : "Enter your username and password.";
    if (username.trim().length < 3 || username.trim().length > 24) return "Pick a username of 3 to 24 characters.";
    if (password.length < MIN_PASSWORD) return `Use a password of at least ${MIN_PASSWORD} characters.`;
    if (!inviteCode.trim()) return "Enter the invite code you were given.";
    return null;
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const invalid = problem();
    if (invalid) {
      setError(invalid);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const me = signup
        ? await api.signup({ username: username.trim(), password, invite_code: inviteCode.trim(), website })
        : await api.login({ username: username.trim(), password });
      onSignedIn(me);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  const switchTo = (next: Mode) => {
    setMode(next);
    setError(null);
  };

  return (
    <main className="auth">
      <section className="auth-board" aria-labelledby={`${ids}-title`}>
        <p className="auth-brand hand">{config.app_name}</p>
        <h1 id={`${ids}-title`} className="auth-headline hand">
          Map it. Break it. <span className="auth-underline">Defend it.</span>
        </h1>
        <p className="auth-lede">
          Give it your code or design docs. It draws the data flow, pins the threats to the map, then quizzes you until
          you can defend what you built at a whiteboard.
        </p>
        <div className="auth-sketch">
          <BoardSketch />
        </div>
        <div className="auth-tray" aria-hidden="true">
          <span className="marker marker-ink" />
          <span className="marker marker-red" />
          <span className="marker marker-blue" />
          <span className="eraser" />
        </div>
      </section>

      <section className="auth-panel">
        <div className="auth-tabs" role="tablist" aria-label="Account">
          <button type="button" role="tab" aria-selected={!signup} className="auth-tab" onClick={() => switchTo("signin")}>
            Sign in
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={signup}
            className="auth-tab"
            onClick={() => switchTo("signup")}
            disabled={!config.signup_open}
          >
            Create account
          </button>
        </div>

        {!config.signup_open && <p className="auth-note">New accounts are closed right now.</p>}

        <form className="auth-form" onSubmit={submit} noValidate>
          <div className="field">
            <label className="field-label" htmlFor={`${ids}-user`}>
              Username
            </label>
            <input
              id={`${ids}-user`}
              className="input"
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              maxLength={signup ? 24 : 64}
              required
            />
          </div>

          <div className="field">
            <label className="field-label" htmlFor={`${ids}-pass`}>
              Password
            </label>
            <div className="auth-password">
              <input
                id={`${ids}-pass`}
                className="input"
                type={showPassword ? "text" : "password"}
                autoComplete={signup ? "new-password" : "current-password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                aria-describedby={signup ? `${ids}-pass-hint` : undefined}
                maxLength={128}
                required
              />
              <button
                type="button"
                className="btn btn-ghost btn-sm auth-reveal"
                aria-pressed={showPassword}
                onClick={() => setShowPassword((shown) => !shown)}
              >
                {showPassword ? "Hide" : "Show"}
              </button>
            </div>
            {signup && (
              <span id={`${ids}-pass-hint`} className="field-hint">
                At least {MIN_PASSWORD} characters. {password.length > 0 && `${password.length} so far.`}
              </span>
            )}
          </div>

          {signup && (
            <div className="field">
              <label className="field-label" htmlFor={`${ids}-invite`}>
                Invite code
              </label>
              <input
                id={`${ids}-invite`}
                className="input mono"
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                value={inviteCode}
                onChange={(e) => setInviteCode(e.target.value)}
                maxLength={64}
                aria-describedby={`${ids}-invite-hint`}
                required
              />
              <span id={`${ids}-invite-hint`} className="field-hint">
                Handed out in person at the event.
              </span>
            </div>
          )}

          {/* Honeypot: hidden from people and screen readers, so only a bot ever fills it. */}
          <div className="honeypot" aria-hidden="true">
            <label htmlFor={`${ids}-website`}>Website</label>
            <input
              id={`${ids}-website`}
              name="website"
              type="text"
              tabIndex={-1}
              autoComplete="off"
              value={website}
              onChange={(e) => setWebsite(e.target.value)}
            />
          </div>

          {error && (
            <p className="auth-error" role="alert">
              {error}
            </p>
          )}

          <button type="submit" className="btn btn-primary auth-submit" disabled={busy}>
            {busy && <span className="spinner" aria-hidden="true" />}
            {signup ? "Create account" : "Sign in"}
          </button>
        </form>
      </section>
    </main>
  );
}
