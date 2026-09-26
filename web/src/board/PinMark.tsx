import type { Severity } from "../api/types.ts";
import { SEVERITY_SHAPE, shapePoints } from "./severity.ts";

// =============================================================================
// Module Overview
// =============================================================================
// A threat pin: a severity shape with the threat's number inside. It draws into
// an existing SVG; `PinBadge` wraps it for use in ordinary text.

const RADIUS = 10;

/** The pin shape and number, centered on 0,0 inside a parent `<svg>`. */
export function PinMark({ severity, label }: { severity: Severity; label: string }) {
  const points = shapePoints(SEVERITY_SHAPE[severity], RADIUS);
  // A triangle's visual center sits low, so its number drops to match.
  const textY = SEVERITY_SHAPE[severity] === "triangle" ? 4.5 : 1;
  return (
    <g className={`pin-mark sev-${severity}`}>
      {points === null ? <circle r={RADIUS} className="pin-shape" /> : <polygon points={points} className="pin-shape" />}
      <text y={textY} className="pin-number">
        {label}
      </text>
    </g>
  );
}

/** A pin for inline use in HTML, such as the threat list. */
export function PinBadge({ severity, label }: { severity: Severity; label: string }) {
  return (
    <svg className="pin-badge" width="26" height="26" viewBox="-13 -13 26 26" aria-hidden="true" focusable="false">
      <PinMark severity={severity} label={label} />
    </svg>
  );
}
