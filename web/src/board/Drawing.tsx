import { useEffect, useState } from "react";

import type { BoardOut } from "../api/types.ts";
import { ProviderLine } from "../settings/ProviderSettings.tsx";
import { BoardSketch } from "../shell/BoardSketch.tsx";
import { formatBytes } from "./filePolicy.ts";
import "./Drawing.css";

// =============================================================================
// Module Overview
// =============================================================================
// What the board shows while the server draws the map or looks for threats: a
// diagram sketching itself, a line on what this stage involves, the material
// being read and the latest activity. Nothing here claims a percentage; the
// server does not report one.

const STAGES = {
  mapping: [
    "Reading the material",
    "Finding the people and vendors",
    "Drawing the trust boundaries",
    "Following the data between parts",
    "Noting what was assumed",
  ],
  analyzing: [
    "Walking each element with STRIDE",
    "Checking AI parts for the lethal trifecta",
    "Tracing attack paths from the edges in",
    "Ranking threats worst first",
    "Writing fixes you can start today",
  ],
} as const;

const STEP_MS = 2600;

/** The progress state for a board whose server work is under way. */
export function Drawing({ board }: { board: BoardOut }) {
  const analyzing = board.status === "analyzing";
  const lines = analyzing ? STAGES.analyzing : STAGES.mapping;
  const [step, setStep] = useState(0);

  useEffect(() => {
    const timer = window.setInterval(() => setStep((i) => (i + 1) % lines.length), STEP_MS);
    return () => window.clearInterval(timer);
  }, [lines.length]);

  // Newest first from the API; the four latest say what the job is doing now.
  const events = board.events.slice(0, 4);
  return (
    <div className="drawing">
      <div className="drawing-sketch">
        <BoardSketch loop />
      </div>
      <div className="drawing-copy">
        <h2 className="hand drawing-title" role="status">
          {analyzing ? "Finding threats on the map" : "Drawing the map"}
        </h2>
        <p className="drawing-step" aria-hidden="true" key={step}>
          {lines[step]}...
        </p>
        <ProviderLine />
        <p className="drawing-note">
          This usually takes under a minute. You can leave this page; the board keeps working and updates when you return.
        </p>
        {board.sources.length > 0 && (
          <div className="drawing-sources">
            <p className="drawing-label">Reading</p>
            <ul>
              {board.sources.slice(0, 8).map((source) => (
                <li key={source.id}>
                  <span className="mono">{source.name}</span> <span className="muted">{formatBytes(source.bytes)}</span>
                </li>
              ))}
              {board.sources.length > 8 && <li className="muted">and {board.sources.length - 8} more</li>}
            </ul>
          </div>
        )}
        {events.length > 0 && (
          <div className="drawing-sources">
            <p className="drawing-label">Latest</p>
            <ul>
              {events.map((event) => (
                <li key={event.id}>{event.text}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
