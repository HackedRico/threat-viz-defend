import type { Ref } from "react";

import type { ConfigOut } from "../api/types.ts";
import { ArrowRightIcon, ArrowUpRightIcon, SparkIcon } from "../shell/icons.tsx";
import { ViewLink } from "./ViewLink.tsx";
import "./Landing.css";

// =============================================================================
// Module Overview
// =============================================================================
// The home page a signed-out visitor sees first: the pitch, the ways in, and
// `SampleScan`, a picture of a scan that finds a command injection path. The
// sample is fixed markup, never a live scan, and says so on the page.

type Tone = "keyword" | "declare" | "string";

interface CodeLine {
  runs: [text: string, tone?: Tone][];
  risk?: boolean;
}

const SAMPLE: CodeLine[] = [
  { runs: [["function", "keyword"], [" runCommand(userInput) {"]] },
  { runs: [["  "], ["const", "declare"], [" command = "], ['"git "', "string"], [" + userInput;"]] },
  { runs: [[""]] },
  { runs: [["  exec(command);"]], risk: true },
  { runs: [["}"]] },
];

/** The signed-out home page. */
export function Landing({ config, headingRef }: { config: ConfigOut; headingRef: Ref<HTMLHeadingElement> }) {
  const open = config.signup_open;
  return (
    <section className="landing" aria-labelledby="landing-title">
      <div className="landing-copy">
        <p className="auth-caps auth-eyebrow">
          <span className="auth-eyebrow-line" aria-hidden="true" />
          Make code risks visible
        </p>
        <h1 id="landing-title" ref={headingRef} tabIndex={-1} className="landing-title">
          See the code.
          <br />
          <em>Understand the threat.</em>
        </h1>
        <p className="landing-lead">
          Give it your code or design docs and see a clear diagram of what it does. Follow how data moves through the
          system, where a possible vulnerability appears, and what could happen next. Then answer questions until you
          can defend it.
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
      </div>
      <SampleScan />
    </section>
  );
}

/** A still picture of a scan: sample code with a risky line, then the threat path that line opens. */
function SampleScan() {
  return (
    <div
      className="scan"
      role="img"
      aria-label="Example: sample code is scanned, then a threat path shows user input flowing into a shell command, a possible command injection."
    >
      <div className="scan-window" aria-hidden="true">
        <div className="scan-bar">
          <span className="scan-dots">
            <i />
            <i />
            <i />
          </span>
          <span>commands.js</span>
          <span className="scan-state">
            <span className="auth-dot" />
            Reviewing code
          </span>
        </div>
        <div className="scan-code">
          {SAMPLE.map((line, i) => (
            <div key={i} className={line.risk ? "scan-row is-risk" : "scan-row"}>
              <span className="scan-line-no">{String(i + 1).padStart(2, "0")}</span>
              <code>
                {line.runs.map(([text, tone], j) => (
                  <span key={j} className={tone ? `syntax-${tone}` : undefined}>
                    {text}
                  </span>
                ))}
              </code>
              {line.risk && <span className="scan-marker">!</span>}
            </div>
          ))}
          <div className="scan-beam" />
        </div>
        <div className="scan-foot">
          <span>Sample code</span>
          <span className="scan-foot-next">
            Threat path <ArrowRightIcon className="scan-down" />
          </span>
        </div>
      </div>

      <div className="scan-path" aria-hidden="true">
        <span className="auth-caps scan-path-label">Possible threat path</span>
        <div className="scan-flow">
          <span className="scan-node">User input</span>
          <ArrowRightIcon className="scan-arrow" />
          <span className="scan-node">Command builder</span>
          <ArrowRightIcon className="scan-arrow" />
          <span className="scan-node is-risk">Shell execution</span>
        </div>
        <p className="scan-verdict">
          <strong>!</strong> Untrusted input may change the command the program runs.
        </p>
      </div>

      <span className="auth-caps scan-caption" aria-hidden="true">
        Illustrative example, not a live scan
      </span>
    </div>
  );
}
