import type { Ref } from "react";

import type { ConfigOut } from "../api/types.ts";
import { ArrowRightIcon, ArrowUpRightIcon, SparkIcon } from "../shell/icons.tsx";
import { DemoBoard } from "./DemoBoard.tsx";
import { Pitch } from "./Pitch.tsx";
import { ViewLink } from "./ViewLink.tsx";
import "./Landing.css";

// =============================================================================
// Module Overview
// =============================================================================
// The home page a signed-out visitor sees first: the hero with the ways in and
// `DemoBoard`, a replay of the app on the example board, then the longer
// `Pitch` below it.

/** The signed-out home page. */
export function Landing({ config, headingRef }: { config: ConfigOut; headingRef: Ref<HTMLHeadingElement> }) {
  const open = config.signup_open;
  return (
    <>
      <section className="landing" aria-labelledby="landing-title">
        <div className="landing-copy">
          <p className="auth-caps auth-eyebrow">
            <span className="auth-eyebrow-line" aria-hidden="true" />
            Threat models for AI-written code
          </p>
          <h1 id="landing-title" ref={headingRef} tabIndex={-1} className="landing-title">
            See the code.
            <br />
            <em>Understand the threat.</em>
          </h1>
          <p className="landing-lead">
            Your coding agent wrote it. Now see how it works: a map of how data moves through your system, the threats
            pinned to it, and a quiz that gets you ready for when a reviewer, a teammate or a stakeholder asks how it
            could be attacked and what stops it. Add your code once, or connect Claude Code or Cursor so the map keeps
            up as you build.
          </p>
          <div className="landing-actions">
            {open && (
              <ViewLink view="signup" className="btn auth-button auth-button-primary">
                Create an account <ArrowUpRightIcon />
              </ViewLink>
            )}
            <ViewLink view="signin" className={`btn auth-button ${open ? "" : "auth-button-primary"}`}>
              Sign in {!open && <ArrowUpRightIcon />}
            </ViewLink>
          </div>
          <p className="landing-note">
            <SparkIcon className="landing-note-icon" />
            {open ? "Create an account with the invite code from the organizers." : "New accounts are closed right now."}
          </p>
          <a className="landing-more" href="#how">
            See how it works <ArrowRightIcon className="landing-more-icon" />
          </a>
        </div>
        <DemoBoard />
      </section>
      <Pitch config={config} />
    </>
  );
}
