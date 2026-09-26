import { CloseIcon } from "../shell/icons.tsx";
import { PinBadge } from "./PinMark.tsx";
import { SEVERITIES } from "./severity.ts";

// =============================================================================
// Module Overview
// =============================================================================
// The map key: what each shape, line and mark on the whiteboard means, so no
// part of the drawing relies on color alone.

/** The map key card. */
export function MapLegend({ onClose }: { onClose: () => void }) {
  return (
    <aside className="map-legend" aria-label="Map key">
      <div className="map-legend-head">
        <h2 className="hand">Map key</h2>
        <button type="button" className="btn btn-ghost btn-icon btn-sm" aria-label="Close the map key" onClick={onClose}>
          <CloseIcon />
        </button>
      </div>
      <ul>
        <li>
          <svg viewBox="0 0 40 24" aria-hidden="true">
            <rect x="2" y="3" width="36" height="18" rx="3" className="legend-stroke" />
            <circle cx="10" cy="10" r="2.6" className="legend-stroke" />
            <path d="M6 18 Q10 13 14 18" className="legend-stroke" />
          </svg>
          External person or vendor
        </li>
        <li>
          <svg viewBox="0 0 40 24" aria-hidden="true">
            <rect x="2" y="3" width="36" height="18" rx="8" className="legend-stroke" />
          </svg>
          Process your team runs
        </li>
        <li>
          <svg viewBox="0 0 40 24" aria-hidden="true">
            <path d="M4 6 V18 A16 4 0 0 0 36 18 V6" className="legend-stroke" />
            <ellipse cx="20" cy="6" rx="16" ry="4" className="legend-stroke" />
          </svg>
          Data store
        </li>
        <li>
          <svg viewBox="0 0 40 24" aria-hidden="true">
            <rect x="2" y="3" width="36" height="18" rx="6" className="legend-stroke legend-dashed" />
          </svg>
          Trust boundary
        </li>
        <li>
          <svg viewBox="0 0 40 24" aria-hidden="true">
            <path d="M2 12 H34" className="legend-flow" />
            <path d="M30 8 L36 12 L30 16" className="legend-flow" />
          </svg>
          Flow of data
        </li>
        <li>
          <svg viewBox="0 0 40 24" aria-hidden="true">
            <path d="M2 12 H34" className="legend-cross" />
            <path d="M2 12 H30" className="legend-cross-inner" />
          </svg>
          Double line: crosses a trust boundary
        </li>
        <li>
          <svg viewBox="0 0 40 24" aria-hidden="true">
            <rect x="3" y="3" width="34" height="18" rx="8" className="legend-ring" />
          </svg>
          Ring: AI part with the lethal trifecta
        </li>
        <li className="legend-pins">
          {SEVERITIES.map((severity, i) => (
            <span key={severity} className="legend-pin">
              <PinBadge severity={severity} label={String(i + 1)} />
              {severity}
            </span>
          ))}
        </li>
      </ul>
      <p className="map-legend-foot">Drag or scroll to pan. Pinch or hold Ctrl and scroll to zoom.</p>
    </aside>
  );
}
