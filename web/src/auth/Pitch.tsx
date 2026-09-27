import type { ConfigOut, Severity } from "../api/types.ts";
import { ArrowUpRightIcon } from "../shell/icons.tsx";
import { SeverityBadge } from "../shell/SeverityBadge.tsx";
import { ViewLink } from "./ViewLink.tsx";
import "./Pitch.css";

// =============================================================================
// Module Overview
// =============================================================================
// The home page below the hero: the two ways a board gets its material, static
// and from a coding agent, the steps from map to defense, the built-in example
// board, and the design choices behind it. Everything here is fixed copy; the
// example mirrors the board every new account starts with.

const STEPS = [
  {
    title: "Check the map",
    text: "A data flow diagram of people, services, stores, flows and trust boundaries. Every element cites the evidence it came from. Fix what is wrong, then confirm it.",
  },
  {
    title: "Read the threats",
    text: "Rules in code decide coverage: STRIDE for each element, every flow across a trust boundary, and the lethal trifecta on AI parts. The model writes the 5 to 8 threats that matter most, each pinned to the map.",
  },
  {
    title: "Defend it",
    text: "Up to 7 questions about your own system. Code computes every answer key from the map; only your open answers go to a model. Or talk it through out loud with the voice coach.",
  },
  {
    title: "Ask and export",
    text: "Ask the board what could go wrong and what to fix first, then export a report you can hand to a reviewer.",
  },
];

const EXAMPLE_THREATS: { severity: Severity; stride: string; title: string }[] = [
  { severity: "critical", stride: "E", title: "A malicious email takes over the triage agent" },
  { severity: "high", stride: "I", title: "fetch_url carries mail out in a link" },
  { severity: "high", stride: "I", title: "Full prompts put private mail in the logs" },
  { severity: "high", stride: "E", title: "Admin pages trust the ordinary session" },
  { severity: "medium", stride: "I", title: "Markdown images leak summaries" },
  { severity: "medium", stride: "I", title: "One env key unlocks every Gmail token" },
  { severity: "medium", stride: "D", title: "Email floods run up the model bill" },
];

const QUIZ_OPTIONS = ["Web app", "Triage agent", "Postgres", "Job queue"];

const CHOICES = [
  { title: "Map first, threats second", text: "Threats are pinned to map elements, so you fix the map before anything is found on it." },
  { title: "Rules decide coverage", text: "The checklist comes from code, so what gets checked never depends on the model." },
  { title: "Answer keys from code", text: "A model never decides which answer to a choice question is right." },
  { title: "Uploads are not stored", text: "Only each source's name, kind and size are kept, so there is less to leak." },
  { title: "Plain text output", text: "Model text renders as text, so a poisoned upload cannot inject HTML or links." },
  { title: "Memory that builds on you", text: "Backboard remembers what you asked and missed on every board, and your next quiz starts there." },
];

/** The sections of the home page below the hero. */
export function Pitch({ config }: { config: ConfigOut }) {
  return (
    <div className="pitch">
      <section id="how" className="pitch-section" aria-labelledby="pitch-ways">
        <p className="auth-caps auth-eyebrow">01 / Two ways in</p>
        <h2 id="pitch-ways" className="pitch-title">
          Map it once, or keep it current while you vibe code.
        </h2>
        <p className="pitch-lead">
          Start from what you already have, or let your coding agent report every change as it builds.
        </p>
        <div className="pitch-ways">
          <article className="pitch-card">
            <span className="auth-caps pitch-kicker">Static</span>
            <h3>Bring what you have.</h3>
            <p>
              Paste design notes, add files or a whole code folder, or paste a public GitHub repository URL. A model
              drafts the map from it.
            </p>
            <ul className="pitch-sources">
              <li>Pasted notes</li>
              <li>Files and folders</li>
              <li>Public GitHub repo</li>
            </ul>
            <p className="pitch-small">
              Files that may hold credentials are skipped in your browser, key-shaped values are masked on the server,
              and uploads are never stored.
            </p>
          </article>

          <article className="pitch-card">
            <span className="auth-caps pitch-kicker">Dynamic</span>
            <h3>Keep up with your coding agent.</h3>
            <p>
              Connect Claude Code or Cursor with a personal token, through the MCP server or the hook. When the agent
              changes how the system is built, the board redraws its map from the diff and waits for your review.
            </p>
            <div className="pitch-terminal">
              <p>
                <span className="pitch-prompt">$</span> claude "add a Stripe webhook that marks orders paid"
              </p>
              <p className="pitch-dim">edited api/webhooks.py, api/orders.py</p>
              <p>
                <span className="pitch-ok">threatviz</span> reported the change to "Shop API"
              </p>
              <p>
                <span className="pitch-ok">board</span> 1 process and 2 flows added, waiting for review
              </p>
            </div>
            <p className="pitch-small">An illustrative session. Ask the agent to quiz you on the board without leaving the editor.</p>
          </article>
        </div>
      </section>

      <section className="pitch-section" aria-labelledby="pitch-steps">
        <p className="auth-caps auth-eyebrow">02 / How it works</p>
        <h2 id="pitch-steps" className="pitch-title">
          From code to a threat model you can defend.
        </h2>
        <ol className="pitch-steps">
          {STEPS.map((step, i) => (
            <li key={step.title} className="pitch-step">
              <span className="auth-caps pitch-step-number">{String(i + 1).padStart(2, "0")}</span>
              <h3>{step.title}</h3>
              <p>{step.text}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className="pitch-section" aria-labelledby="pitch-example">
        <p className="auth-caps auth-eyebrow">03 / A worked example</p>
        <h2 id="pitch-example" className="pitch-title">
          Inbox Helper, an AI email assistant.
        </h2>
        <p className="pitch-lead">
          It reads Gmail, summarizes threads and can send mail on its own. Every new account starts with its finished
          board, so you can explore a full threat model before adding yours.
        </p>
        <div className="pitch-example">
          <div className="pitch-example-side">
            <article className="pitch-card">
              <span className="auth-caps pitch-kicker">Verdict</span>
              <p className="pitch-verdict">
                Fix the triage agent first: any email can make it forward private mail or fetch an attacker's URL, so
                turn off auto-send and fence its tools.
              </p>
            </article>
            <article className="pitch-card pitch-trifecta">
              <span className="auth-caps pitch-kicker">Lethal trifecta</span>
              <p>
                The triage agent reads private mail, takes in untrusted email, and can send data out with send_email
                and fetch_url. All three at once is what makes the top threat critical.
              </p>
            </article>
          </div>

          <article className="pitch-card">
            <span className="auth-caps pitch-kicker">Threats</span>
            <ul className="pitch-threats">
              {EXAMPLE_THREATS.map((threat) => (
                <li key={threat.title}>
                  <SeverityBadge severity={threat.severity} />
                  <span className="pitch-stride" title="STRIDE category">
                    {threat.stride}
                  </span>
                  <span>{threat.title}</span>
                </li>
              ))}
            </ul>
          </article>

          <article className="pitch-card pitch-quiz">
            <span className="auth-caps pitch-kicker">Defend</span>
            <p className="pitch-question">Where does the worst threat on this board happen?</p>
            <ul className="pitch-options">
              {QUIZ_OPTIONS.map((option) => (
                <li key={option} className={option === "Triage agent" ? "is-right" : undefined}>
                  {option}
                  {option === "Triage agent" && <span className="pitch-right">Right</span>}
                </li>
              ))}
            </ul>
            <p className="pitch-small">The answer key comes from the map, never from a model.</p>
          </article>
        </div>
      </section>

      <section className="pitch-section" aria-labelledby="pitch-choices">
        <p className="auth-caps auth-eyebrow">04 / Built to be honest</p>
        <h2 id="pitch-choices" className="pitch-title">
          It never says your system is secure.
        </h2>
        <p className="pitch-lead">It shows you where to look, why, and checks that you understood.</p>
        <ul className="pitch-choices">
          {CHOICES.map((choice) => (
            <li key={choice.title} className="pitch-choice">
              <h3>{choice.title}</h3>
              <p>{choice.text}</p>
            </li>
          ))}
        </ul>
      </section>

      <section className="pitch-section pitch-end" aria-labelledby="pitch-end">
        <h2 id="pitch-end" className="pitch-title">
          Can you defend what your agent built?
        </h2>
        <p className="pitch-lead">Find out before someone else does.</p>
        <div className="landing-actions">
          {config.signup_open && (
            <ViewLink view="signup" className="btn auth-button auth-button-primary">
              Create an account <ArrowUpRightIcon />
            </ViewLink>
          )}
          <ViewLink view="signin" className={`btn auth-button ${config.signup_open ? "" : "auth-button-primary"}`}>
            Sign in {!config.signup_open && <ArrowUpRightIcon />}
          </ViewLink>
        </div>
      </section>
    </div>
  );
}
