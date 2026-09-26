import { useEffect, useRef, useState } from "react";

import type { SystemMap, Threat, ThreatAnalysis } from "../api/types.ts";
import { SeverityBadge } from "../shell/SeverityBadge.tsx";
import { labelOf } from "./elements.ts";
import { PinBadge } from "./PinMark.tsx";
import { rankThreats, STRIDE } from "./severity.ts";
import { useBoardUi } from "./store.ts";

// =============================================================================
// Module Overview
// =============================================================================
// Every threat, worst first. Each card shows where it sits, its severity and
// STRIDE category in words, and opens to the full statement, fixes, catalog
// references and the evidence behind it. Opening a card lights its element.

/** The threat list for a finished board. */
export function ThreatList({ analysis, map }: { analysis: ThreatAnalysis; map: SystemMap }) {
  const focusThreat = useBoardUi((s) => s.focusThreat);
  const [open, setOpen] = useState<string | null>(focusThreat);
  const ranked = rankThreats(analysis.threats);

  useEffect(() => {
    if (focusThreat) setOpen(focusThreat);
  }, [focusThreat]);

  if (ranked.length === 0) return <p className="muted">No threats were found on this map.</p>;
  return (
    <ol className="threat-list">
      {ranked.map((threat) => (
        <ThreatCard
          key={threat.id}
          threat={threat}
          where={labelOf(threat.element, map, analysis)}
          open={open === threat.id}
          focused={focusThreat === threat.id}
          onToggle={() => {
            const next = open === threat.id ? null : threat.id;
            setOpen(next);
            const ui = useBoardUi.getState();
            if (next) {
              ui.setHighlight([threat.id], "threat");
              ui.select(threat.element);
            } else {
              ui.clearHighlight();
            }
            ui.showThreat(null);
          }}
        />
      ))}
    </ol>
  );
}

function ThreatCard({
  threat,
  where,
  open,
  focused,
  onToggle,
}: {
  threat: Threat;
  where: string;
  open: boolean;
  focused: boolean;
  onToggle: () => void;
}) {
  const ref = useRef<HTMLLIElement>(null);
  const stride = STRIDE[threat.stride];

  useEffect(() => {
    if (focused) ref.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [focused]);

  const bodyId = `threat-body-${threat.id}`;
  return (
    <li ref={ref} className={`threat-card sev-edge-${threat.severity} ${open ? "is-open" : ""}`}>
      <button type="button" className="threat-head" aria-expanded={open} aria-controls={bodyId} onClick={onToggle}>
        <PinBadge severity={threat.severity} label={threat.id.replace(/\D/g, "") || threat.id} />
        <span className="threat-head-text">
          <span className="threat-title">{threat.title}</span>
          <span className="threat-where">
            <span className="mono">{threat.id}</span> on {where}
          </span>
        </span>
      </button>
      <div className="threat-tags">
        <SeverityBadge severity={threat.severity} />
        <span className="chip" title={`Breaks ${stride.property}`}>
          {stride.name}
        </span>
      </div>
      <p className="threat-summary">{threat.summary}</p>
      {open && (
        <div className="threat-body" id={bodyId}>
          <p className="threat-statement">{threat.statement}</p>
          <p>
            <strong>Impact.</strong> {threat.impact}
          </p>
          {threat.fixes.length > 0 && (
            <div>
              <p className="panel-label">Fixes to start today</p>
              <ul className="fix-list">
                {threat.fixes.map((fix) => (
                  <li key={fix}>{fix}</li>
                ))}
              </ul>
            </div>
          )}
          {threat.refs.length > 0 && (
            <p className="threat-refs">
              {threat.refs.map((ref) => (
                <span key={ref} className="chip mono">
                  {ref}
                </span>
              ))}
            </p>
          )}
          <blockquote className="threat-evidence">{threat.evidence}</blockquote>
        </div>
      )}
    </li>
  );
}
