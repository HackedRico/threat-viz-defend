import { useEffect, useMemo, useState } from "react";

import { boundaryOutline, nodeFill, nodeOutline, personGlyph, roughPath } from "../board/shapes.ts";
import { SeverityBadge } from "../shell/SeverityBadge.tsx";
import { arrowHead, DEMO_STAGES, nextStage } from "./demo.ts";
import "../shell/BoardSketch.css";
import "./DemoBoard.css";

// =============================================================================
// Module Overview
// =============================================================================
// A small, fixed replay of the app on the example board: material goes in, the
// map draws itself in the canvas's hand-drawn style, threats get pinned, and a
// Defend question is answered. It plays on a loop; the step buttons jump to a
// step and pause it. Reduced motion opens on the last step and never plays.

type Tone = "ink" | "flow" | "crossing" | "boundary";
type Box = { x: number; y: number; width: number; height: number };

const SENDERS: Box = { x: 14, y: 36, width: 150, height: 50 };
const GMAIL: Box = { x: 14, y: 212, width: 150, height: 50 };
const ZONE: Box = { x: 190, y: 16, width: 356, height: 272 };
const AGENT: Box = { x: 218, y: 120, width: 150, height: 60 };
const STORE: Box = { x: 404, y: 36, width: 132, height: 74 };
const SYNC: Box = { x: 404, y: 212, width: 132, height: 50 };

/** Every stroke of the example map, in drawing order. */
function mapStrokes(): { d: string; tone: Tone }[] {
  const flow = (x1: number, y1: number, x2: number, y2: number, seed: string, tone: Tone) => [
    ...roughPath(`M${x1},${y1} L${x2},${y2}`, seed, 0.6).map((d) => ({ d, tone })),
    { d: arrowHead(x1, y1, x2, y2), tone },
  ];
  const node = (kind: "external" | "process" | "store", box: Box, id: string) =>
    nodeOutline(kind, box, id).map((d) => ({ d, tone: "ink" as const }));
  return [
    ...node("external", SENDERS, "demo-senders"),
    { d: personGlyph(SENDERS.x + 10, SENDERS.y + 15), tone: "ink" },
    ...node("external", GMAIL, "demo-gmail"),
    ...boundaryOutline(ZONE, "demo").map((d) => ({ d, tone: "boundary" as const })),
    ...node("process", SYNC, "demo-sync"),
    ...node("store", STORE, "demo-store"),
    ...node("process", AGENT, "demo-agent"),
    ...flow(89, 90, 89, 206, "f1", "flow"),
    ...flow(168, 237, 398, 237, "f2", "crossing"),
    ...flow(470, 208, 470, 116, "f3", "flow"),
    ...flow(400, 82, 372, 128, "f4", "flow"),
    ...flow(214, 134, 168, 82, "f5", "crossing"),
  ];
}

const LABELS: { x: number; y: number; text: string; zone?: boolean }[] = [
  { x: 40, y: 69, text: "Email senders" },
  { x: 40, y: 245, text: "Gmail API" },
  { x: 238, y: 158, text: "Triage agent" },
  { x: 428, y: 88, text: "Postgres" },
  { x: 426, y: 245, text: "Mail sync" },
  { x: 204, y: 38, text: "our cloud", zone: true },
  { x: 100, y: 146, text: "send_email", zone: true },
];

const QUIZ = ["Web app", "Triage agent", "Postgres", "Job queue"];

/** The home page demo of a board, from material to a Defend answer. */
export function DemoBoard() {
  const reduced = useMemo(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches, []);
  const last = DEMO_STAGES.length - 1;
  const [stage, setStage] = useState(reduced ? last : 0);
  const [playing, setPlaying] = useState(!reduced);
  const strokes = useMemo(mapStrokes, []);
  const step = 1.6 / strokes.length;

  useEffect(() => {
    if (!playing) return undefined;
    const timer = window.setTimeout(() => {
      setStage(nextStage(stage));
    }, DEMO_STAGES[stage]!.ms);
    return () => window.clearTimeout(timer);
  }, [stage, playing]);

  const jump = (index: number) => {
    setPlaying(false);
    setStage(index);
  };

  return (
    <div className="demo">
      <div className="demo-window" data-stage={stage}>
        <div className="demo-bar">
          <span className="hand demo-title">Example: Inbox Helper</span>
          <span className="chip">{DEMO_STAGES[stage]!.status}</span>
          {/* Always laid out, only shown once threats exist, so the header never changes height. */}
          <span className={stage >= 2 ? "demo-counts" : "demo-counts is-waiting"} aria-hidden={stage < 2}>
            <SeverityBadge severity="critical" count={1} />
            <SeverityBadge severity="high" count={3} />
          </span>
        </div>

        <div className="demo-canvas">
          <svg
            viewBox="0 0 560 300"
            role="img"
            aria-label="The example board's map: email senders reach the Gmail API, the mail sync worker saves mail to Postgres, the triage agent reads it and can send email back out."
          >
            {stage >= 1 && (
              // The map leaves on the first step, so every loop draws it again stroke by stroke.
              <g>
                <path className="demo-fill" d={nodeFill("external", SENDERS)} />
                <path className="demo-fill" d={nodeFill("external", GMAIL)} />
                <path className="demo-fill" d={nodeFill("process", SYNC)} />
                <path className="demo-fill" d={nodeFill("store", STORE)} />
                <path className={stage === 3 ? "demo-fill is-lit" : "demo-fill"} d={nodeFill("process", AGENT)} />
                {strokes.map((stroke, i) => (
                  <path
                    key={i}
                    d={stroke.d}
                    pathLength={1}
                    className={`sketch-stroke tone-${stroke.tone === "crossing" ? "flow demo-crossing" : stroke.tone}`}
                    style={{ animationDelay: `${(i * step).toFixed(2)}s` }}
                  />
                ))}
                {LABELS.map((label) => (
                  <text key={label.text} x={label.x} y={label.y} className={label.zone ? "sketch-label sketch-zone" : "sketch-label"}>
                    {label.text}
                  </text>
                ))}
              </g>
            )}
            {stage >= 2 && (
              <g className="demo-threats">
                <rect className="demo-ring" x={AGENT.x - 7} y={AGENT.y - 7} width={AGENT.width + 14} height={AGENT.height + 14} rx={20} />
                <g className="demo-pin">
                  <circle cx={AGENT.x + AGENT.width} cy={AGENT.y} r={11} />
                  <text x={AGENT.x + AGENT.width} y={AGENT.y + 4.5}>
                    1
                  </text>
                </g>
                <g className="demo-pin is-high">
                  <circle cx={AGENT.x + 4} cy={AGENT.y + AGENT.height} r={11} />
                  <text x={AGENT.x + 4} y={AGENT.y + AGENT.height + 4.5}>
                    2
                  </text>
                </g>
              </g>
            )}
          </svg>
          {stage === 0 && <p className="hand demo-empty">A clean whiteboard.</p>}
        </div>

        <div className="demo-panel" key={stage}>
          {stage === 0 && (
            <>
              <p className="demo-panel-title">Add material</p>
              <ul className="demo-sources">
                <li>
                  <span className="auth-caps demo-tag">Paste</span> design-notes.md
                </li>
                <li>
                  <span className="auth-caps demo-tag">Folder</span> inbox-helper/ (38 files)
                </li>
                <li>
                  <span className="auth-caps demo-tag">GitHub</span> github.com/acme/inbox-helper
                </li>
                <li className="is-agent">
                  <span className="auth-caps demo-tag">Agent</span> Claude Code added a send_email tool
                </li>
              </ul>
            </>
          )}
          {stage === 1 && (
            <>
              <p className="demo-panel-title">Check the map</p>
              <p className="demo-panel-text">
                Every element cites the notes it came from. Two flows cross the trust boundary. Fix what is wrong, then
                confirm.
              </p>
              <span className="demo-confirm">Confirm map</span>
            </>
          )}
          {stage === 2 && (
            <>
              <p className="demo-panel-title">Read the threats</p>
              <ul className="demo-threat-list">
                <li>
                  <span className="demo-pin-dot">1</span>
                  <SeverityBadge severity="critical" />
                  <span>A malicious email takes over the triage agent</span>
                </li>
                <li>
                  <span className="demo-pin-dot is-high">2</span>
                  <SeverityBadge severity="high" />
                  <span>fetch_url carries mail out in a link</span>
                </li>
              </ul>
              <p className="demo-panel-note">Lethal trifecta: private mail, untrusted email and a way out.</p>
            </>
          )}
          {stage === 3 && (
            <>
              <p className="demo-panel-title">Where does the worst threat on this board happen?</p>
              <ul className="demo-options">
                {QUIZ.map((option) => (
                  <li key={option} className={option === "Triage agent" ? "is-right" : undefined}>
                    {option}
                  </li>
                ))}
              </ul>
              <p className="demo-panel-note">Right. Any email can make it forward private mail. The answer key comes from the map.</p>
            </>
          )}
        </div>
      </div>

      <div className="demo-steps">
        {DEMO_STAGES.map((item, i) => (
          <button
            key={item.label}
            type="button"
            className="demo-step"
            aria-pressed={i === stage}
            onClick={() => jump(i)}
          >
            <span className="demo-step-number">{String(i + 1).padStart(2, "0")}</span>
            {item.label}
          </button>
        ))}
        <button type="button" className="btn btn-ghost btn-sm demo-play" onClick={() => setPlaying((on) => !on)}>
          {playing ? "Pause" : "Play"}
        </button>
      </div>
      <span className="auth-caps demo-caption">A replay of the example board</span>
    </div>
  );
}
