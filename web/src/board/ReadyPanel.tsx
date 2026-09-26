import { useEffect, useState } from "react";

import type { BoardOut, SystemMap } from "../api/types.ts";
import { DefendPanel } from "../quiz/DefendPanel.tsx";
import { ActivityLog } from "./ActivityLog.tsx";
import { AskBox } from "./AskBox.tsx";
import { AttackPaths } from "./AttackPaths.tsx";
import { useBoardUi } from "./store.ts";
import { ThreatList } from "./ThreatList.tsx";
import "./Panel.css";

// =============================================================================
// Module Overview
// =============================================================================
// The side panel of a finished board, in tabs: the threat list, attack paths,
// questions to the analyst, the defend panel with the quiz and voice coach, and
// the activity log. A pin click or an "ask about this" jumps to its tab.

type Tab = "threats" | "paths" | "ask" | "defend" | "activity";

/** The panel for a board with a threat model. */
export function ReadyPanel({ board, map, askSignal }: { board: BoardOut; map: SystemMap; askSignal: number }) {
  const [tab, setTab] = useState<Tab>("threats");
  const focusThreat = useBoardUi((s) => s.focusThreat);
  const analysis = board.analysis;

  useEffect(() => {
    if (focusThreat) setTab("threats");
  }, [focusThreat]);
  useEffect(() => {
    if (askSignal > 0) setTab("ask");
  }, [askSignal]);

  if (analysis === null) {
    return (
      <div className="panel">
        <p className="muted">No threat model yet.</p>
        <ActivityLog board={board} open />
      </div>
    );
  }

  const tabs: { id: Tab; label: string }[] = [
    { id: "threats", label: `Threats ${analysis.threats.length}` },
    { id: "paths", label: `Paths ${analysis.paths.length}` },
    { id: "ask", label: "Ask" },
    { id: "defend", label: "Defend" },
    { id: "activity", label: "Log" },
  ];

  return (
    <div className="panel panel-tabs">
      <div className="tab-bar" role="tablist" aria-label="Threat model">
        {tabs.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            id={`tab-${item.id}`}
            aria-selected={tab === item.id}
            aria-controls={`tabpanel-${item.id}`}
            tabIndex={tab === item.id ? 0 : -1}
            className={`tab ${item.id === "defend" ? "tab-defend" : ""}`}
            onClick={() => setTab(item.id)}
            onKeyDown={(event) => {
              const index = tabs.findIndex((t) => t.id === tab);
              const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
              if (step !== 0) {
                const next = tabs[(index + step + tabs.length) % tabs.length]!;
                setTab(next.id);
                document.getElementById(`tab-${next.id}`)?.focus();
              }
            }}
          >
            {item.label}
          </button>
        ))}
      </div>
      <div className="tab-panel" role="tabpanel" id={`tabpanel-${tab}`} aria-labelledby={`tab-${tab}`}>
        {tab === "threats" && <ThreatList analysis={analysis} map={map} />}
        {tab === "paths" && <AttackPaths analysis={analysis} map={map} />}
        {tab === "ask" && <AskBox board={board} map={map} />}
        {tab === "defend" && <DefendPanel board={board} map={map} />}
        {tab === "activity" && <ActivityLog board={board} open />}
      </div>
    </div>
  );
}
