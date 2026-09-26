import type { Severity } from "../api/types.ts";
import { SEVERITY_SHAPE, shapePoints } from "../board/severity.ts";

// =============================================================================
// Module Overview
// =============================================================================
// Severity as a shape, a word and a color together, so no one has to tell red
// from orange to know how bad a threat is.

/** The severity shape alone, sized for inline text. */
export function SeverityShape({ severity, size = 10 }: { severity: Severity; size?: number }) {
  const points = shapePoints(SEVERITY_SHAPE[severity], 4.2);
  return (
    <svg className="sev-shape" width={size} height={size} viewBox="-5 -5 10 10" aria-hidden="true" focusable="false">
      {points === null ? <circle r="4.4" /> : <polygon points={points} />}
    </svg>
  );
}

/** A severity badge: shape, word and color, with an optional count. */
export function SeverityBadge({ severity, count }: { severity: Severity; count?: number }) {
  return (
    <span className={`sev sev-${severity}`}>
      <SeverityShape severity={severity} />
      {count !== undefined ? `${count} ${severity}` : severity}
    </span>
  );
}
