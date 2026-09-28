import type { ReactNode, Ref } from "react";

import type { ConfigOut } from "../api/types.ts";
import { roughPath } from "../board/shapes.ts";
import { ArrowRightIcon, ArrowUpRightIcon, SparkIcon } from "../shell/icons.tsx";
import { Mascot } from "../shell/Mascot.tsx";
import { DemoBoard } from "./DemoBoard.tsx";
import { Pitch } from "./Pitch.tsx";
import { ViewLink } from "./ViewLink.tsx";
import "./Landing.css";

// =============================================================================
// Module Overview
// =============================================================================
// The home page a signed-out visitor sees first: the hero, `DemoBoard` (a replay
// of the example board, with Dawg on top in the hackUMBC theme) and `Pitch`.
// The headline is marked up the way a board marks up a map: an underline on
// "code", a marker ring and a critical pin on "threat".

// Each mark is drawn in a box shaped like the area around its word, 100 units tall, so the stroke keeps an even
// width and scales with the headline. The ring overshoots its start like a real marker loop.
const UNDERLINE = { width: 150, strokes: roughPath("M5,82 C42,72 93,90 145,75", "landing-underline", 0.6) };
const RING = {
  width: 190,
  strokes: roughPath(
    "M19,22 C65,-3 160,3 184,38 C200,75 137,103 80,98 C23,93 -6,68 8,40 C15,20 42,10 72,8",
    "landing-ring",
    0.5,
  ),
};

function Marked({ tone, mark, children }: { tone: "blue" | "red"; mark: typeof RING; children: ReactNode }) {
  return (
    <span className={`landing-mark is-${tone}`}>
      {children}
      <svg
        className="landing-mark-ink"
        viewBox={`0 0 ${mark.width} 100`}
        preserveAspectRatio="none"
        aria-hidden="true"
        focusable="false"
      >
        {mark.strokes.map((d, i) => (
          <path key={i} d={d} pathLength={1} />
        ))}
      </svg>
    </span>
  );
}

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
            See the{" "}
            <Marked tone="blue" mark={UNDERLINE}>
              code
            </Marked>
            .
            <br />
            Understand the{" "}
            <Marked tone="red" mark={RING}>
              threat
              <span className="landing-pin" aria-hidden="true">
                1
              </span>
            </Marked>
            .
          </h1>
          <p className="landing-note-hand hand" aria-hidden="true">
            Critical: any email can steer the agent
          </p>
          <p className="landing-lead">
            Your coding agent wrote it. Now see how it works: a map of how data moves through your system, the threats
            pinned to it, and a quiz that gets you ready to explain how it could be attacked and what stops it. Add your
            code once, or connect Claude Code or Cursor so the map keeps up as you build.
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
            {open ? "Create an account with an invite code from whoever runs this server." : "New accounts are closed right now."}
          </p>
          <a className="landing-more" href="#how">
            See how it works <ArrowRightIcon className="landing-more-icon" />
          </a>
        </div>
        <div className="landing-demo">
          <Mascot mood="cool" bubble="Sniffing out threats" className="landing-mascot" />
          <DemoBoard />
        </div>
      </section>
      <Pitch config={config} />
    </>
  );
}
