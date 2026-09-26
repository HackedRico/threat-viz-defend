import { useId, useState, type FormEvent, type Ref } from "react";

import { api, errorMessage } from "../api/client.ts";
import type { ConfigOut, MeOut } from "../api/types.ts";
import { ArrowUpRightIcon } from "../shell/icons.tsx";
import { ViewLink } from "./ViewLink.tsx";
import "./AccountForm.css";

// =============================================================================
// Module Overview
// =============================================================================
// The sign in and create account forms, each beside a panel with a motto.
// Creating an account needs the invite code handed out in person. The form
// carries a `website` honeypot that people never see; bots that fill every
// field reveal themselves with it.

/** Which account form to show. */
export type AccountMode = "signin" | "signup";

interface Copy {
  step: string;
  title: string;
  lead: string;
  index: string;
  glyph: string;
  motto: string;
}

const COPY: Record<AccountMode, Copy> = {
  signup: {
    step: "01 / Get started",
    title: "Create your account.",
    lead: "Sign up to map your code and explore possible threats in a diagram. Have your invite code ready.",
    index: "TVD / 001",
    glyph: "< / >",
    motto: "Security starts with curiosity.",
  },
  signin: {
    step: "02 / Welcome back",
    title: "Sign in.",
    lead: "Your boards are waiting.",
    index: "TVD / 002",
    glyph: "{ }",
    motto: "Find the signal in the noise.",
  },
};

const MIN_PASSWORD = 10;

/** The sign in or create account form, beside its side panel. */
export function AccountForm({
  mode,
  config,
  onSignedIn,
  headingRef,
}: {
  mode: AccountMode;
  config: ConfigOut;
  onSignedIn: (me: MeOut) => void;
  headingRef: Ref<HTMLHeadingElement>;
}) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [website, setWebsite] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ids = useId();
  const signup = mode === "signup";
  const closed = signup && !config.signup_open;
  const copy = COPY[mode];

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

  return (
    <section className="account" aria-labelledby={`${ids}-title`}>
      <div className="account-panel">
        <p className="auth-caps auth-eyebrow">{copy.step}</p>
        <h1 id={`${ids}-title`} ref={headingRef} tabIndex={-1} className="account-title">
          {copy.title}
        </h1>
        <p className="account-lead">{closed ? "New accounts are closed right now." : copy.lead}</p>

        {!closed && (
          <form className="account-form" onSubmit={submit} noValidate>
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
                placeholder={signup ? "Choose a username" : "Your username"}
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
              <div className="account-password">
                <input
                  id={`${ids}-pass`}
                  className="input"
                  type={showPassword ? "text" : "password"}
                  autoComplete={signup ? "new-password" : "current-password"}
                  placeholder={signup ? undefined : "Your password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  aria-describedby={signup ? `${ids}-pass-hint` : undefined}
                  maxLength={128}
                  required
                />
                <button
                  type="button"
                  className="btn btn-ghost btn-sm account-reveal"
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
                  placeholder="Enter your code"
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
              <p className="account-error" role="alert">
                {error}
              </p>
            )}

            <button type="submit" className="btn auth-button auth-button-primary account-submit" disabled={busy}>
              {signup ? "Create account" : "Sign in"}
              {busy ? <span className="spinner" aria-hidden="true" /> : <ArrowUpRightIcon />}
            </button>
          </form>
        )}

        <p className="account-switch">
          {signup ? (
            <>
              Already have an account? <ViewLink view="signin">Sign in</ViewLink>
            </>
          ) : config.signup_open ? (
            <>
              New here? <ViewLink view="signup">Create an account</ViewLink>
            </>
          ) : (
            "New accounts are closed right now."
          )}
        </p>
      </div>

      <div className="account-side" aria-hidden="true">
        <span className="auth-caps account-side-index">{copy.index}</span>
        <div className="account-side-glyph">{copy.glyph}</div>
        <p className="account-side-motto">{copy.motto}</p>
      </div>
    </section>
  );
}
