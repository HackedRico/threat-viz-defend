import { useMemo } from "react";

import { boundaryOutline, LID, nodeOutline, personGlyph, roughPath } from "../board/shapes.ts";
import "./BoardSketch.css";

// =============================================================================
// Module Overview
// =============================================================================
// A small data flow diagram that draws itself stroke by stroke, like a marker
// on a whiteboard: a person, a service, a store, a dashed trust boundary, the
// arrows between them and a threat pin. The sign in screen draws it once; the
// progress state loops it while the real map is drawn.

interface Stroke {
  d: string;
  tone: "ink" | "boundary" | "flow" | "danger";
}

function buildStrokes(): Stroke[] {
  const person = { x: 18, y: 88, width: 104, height: 48 };
  const service = { x: 214, y: 72, width: 122, height: 60 };
  const store = { x: 214, y: 176, width: 122, height: 66 };
  const zone = { x: 186, y: 36, width: 184, height: 228 };
  const strokes: Stroke[] = [
    ...nodeOutline("external", person, "sketch-person").map((d) => ({ d, tone: "ink" as const })),
    { d: personGlyph(person.x + 10, person.y + 15), tone: "ink" },
    ...boundaryOutline(zone, "sketch").map((d) => ({ d, tone: "boundary" as const })),
    ...nodeOutline("process", service, "sketch-service").map((d) => ({ d, tone: "ink" as const })),
    ...nodeOutline("store", store, "sketch-store").map((d) => ({ d, tone: "ink" as const })),
    ...roughPath(`M${person.x + person.width + 2},112 L${service.x - 8},104`, "a1", 0.6).map((d) => ({ d, tone: "flow" as const })),
    { d: `M${service.x - 16},98 L${service.x - 6},104 L${service.x - 16},111`, tone: "flow" },
    ...roughPath(`M275,${service.y + service.height + 4} L275,${store.y - 6}`, "a2", 0.6).map((d) => ({ d, tone: "flow" as const })),
    { d: `M268,${store.y - 14} L275,${store.y - 4} L282,${store.y - 14}`, tone: "flow" },
    ...roughPath(`M${store.x + store.width - 2},${store.y + LID} m-13,0 a13,13 0 1,0 26,0 a13,13 0 1,0 -26,0`, "pin", 0.4).map((d) => ({
      d,
      tone: "danger" as const,
    })),
  ];
  return strokes;
}

/** The self-drawing diagram; `loop` redraws it forever, otherwise it draws once. */
export function BoardSketch({ loop = false, className = "" }: { loop?: boolean; className?: string }) {
  const strokes = useMemo(buildStrokes, []);
  const step = 1.8 / strokes.length;
  return (
    <svg
      className={`board-sketch ${loop ? "is-looping" : ""} ${className}`}
      viewBox="0 0 390 290"
      role="img"
      aria-label="A data flow diagram being drawn: a person sends data to a service inside a trust boundary, which saves it to a store marked with a threat."
    >
      {strokes.map((stroke, i) => (
        <path
          key={i}
          d={stroke.d}
          pathLength={1}
          className={`sketch-stroke tone-${stroke.tone}`}
          style={{ animationDelay: `${(i * step).toFixed(2)}s` }}
        />
      ))}
      <text x="222" y="108" className="sketch-label">
        API
      </text>
      <text x="236" y="222" className="sketch-label">
        Postgres
      </text>
      <text x="48" y="118" className="sketch-label">
        User
      </text>
      <text x="200" y="28" className="sketch-label sketch-zone">
        cloud
      </text>
      <text x="334" y="190" className="sketch-pin">
        1
      </text>
    </svg>
  );
}
