import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";

import type { BoardOut, SystemMap } from "../api/types.ts";
import { CloseIcon, SidebarIcon } from "../shell/icons.tsx";
import { ResizeHandle, useStoredWidth } from "../shell/ResizeHandle.tsx";
import { clampWidth } from "../shell/resize.ts";
import { isBusy } from "../shell/statusText.ts";
import { ProviderLine } from "../settings/ProviderSettings.tsx";
import { ActivityLog } from "./ActivityLog.tsx";
import { AskDock } from "./AskDock.tsx";
import { expandHighlight, labelOf } from "./elements.ts";
import { Inspector } from "./Inspector.tsx";
import { MapCanvas } from "./MapCanvas.tsx";
import { diffMaps } from "./mapDiff.ts";
import { ReadyPanel } from "./ReadyPanel.tsx";
import { ReviewPanel } from "./ReviewPanel.tsx";
import { rankThreats } from "./severity.ts";
import { useBoardUi, type HighlightSource } from "./store.ts";
import { useMapLayout } from "./useMapLayout.ts";
import "./Panel.css";
import "./Workspace.css";

// =============================================================================
// Module Overview
// =============================================================================
// A board with a map: the canvas on the left, the review or threat panel on
// the right, and on a finished board the ask bar docked under the canvas. In
// review the map is a local draft the user edits and saves; once ready it is
// read only and lights up from answers, quiz results, the voice coach and
// attack paths.

const SOURCE_TEXT: Record<HighlightSource, string> = {
  ask: "Lit by the answer",
  quiz: "Lit by your quiz result",
  voice: "Lit by the voice coach",
  weak: "Your weak spots",
  threat: "Lit by the threat",
};

const PANEL_WIDTH_KEY = "panel-width";
const PANEL_DEFAULT = 380;
const PANEL_BOUNDS = { min: 320, max: 900 };

/** The map and its side panel for a board in review, analysis or ready. */
export function Workspace({ board, onApply }: { board: BoardOut; onApply: (next: BoardOut) => void }) {
  const review = board.status === "review";
  const serverMap = board.map!;
  const [draft, setDraft] = useState<SystemMap>(serverMap);
  const [dirty, setDirty] = useState(false);
  const [editBase, setEditBase] = useState<number | null>(null);
  const [panelOpen, setPanelOpen] = useState(true);
  const [askSignal, setAskSignal] = useState(0);
  const [storedWidth, setPanelWidth] = useStoredWidth(PANEL_WIDTH_KEY, PANEL_DEFAULT, PANEL_BOUNDS);
  // The panel may take most of the window but always leaves some map to look at. The cap
  // applies only on screen, so a narrow window never overwrites the width the user chose.
  const panelBounds = { min: PANEL_BOUNDS.min, max: Math.min(PANEL_BOUNDS.max, Math.round(window.innerWidth * 0.6)) };
  const panelWidth = clampWidth(storedWidth, panelBounds);

  // Adopt the server's map when it changes, unless the user has unsaved edits to keep.
  const seenRevision = useRef(board.revision);
  useEffect(() => {
    if (board.revision !== seenRevision.current) {
      seenRevision.current = board.revision;
      if (!dirty) setDraft(serverMap);
    }
  }, [board.revision, serverMap, dirty]);

  const map = review ? draft : serverMap;
  const { layout, key, error } = useMapLayout(map);
  const diff = useMemo(() => (review && board.previous_map ? diffMaps(board.previous_map, map) : null), [review, board.previous_map, map]);
  const analysis = board.status === "ready" ? board.analysis : null;
  const threats = analysis?.threats ?? [];

  const selected = useBoardUi((s) => s.selected);
  const highlight = useBoardUi((s) => s.highlight);
  const source = useBoardUi((s) => s.highlightSource);
  const hoverPath = useBoardUi((s) => s.hoverPath);
  const pinnedPath = useBoardUi((s) => s.pinnedPath);
  const clearHighlight = useBoardUi((s) => s.clearHighlight);

  const activePath = hoverPath ?? pinnedPath;
  const lit = useMemo(() => {
    const ids = activePath ? [activePath] : highlight;
    if (ids.length === 0) return null;
    return new Set(expandHighlight(ids, map, analysis));
  }, [activePath, highlight, map, analysis]);

  const edit = (next: SystemMap) => {
    if (!dirty) setEditBase(board.revision);
    setDraft(next);
    setDirty(true);
  };
  // Someone else, such as a coding agent, saved the board while these edits were open.
  const staleEdits = dirty && editBase !== null && board.revision !== editBase;

  const busy = isBusy(board.status);
  const asking = analysis !== null;
  const shownLabels = highlight.slice(0, 4).map((id) => labelOf(id, map, analysis));

  return (
    <div
      className={`workspace ${panelOpen ? "" : "panel-closed"}`}
      style={{ "--panel-width": `${panelWidth}px` } as CSSProperties}
    >
      <div className="workspace-stage">
        <div className="workspace-canvas">
          {layout && key ? (
            <MapCanvas
              map={map}
              layout={layout}
              layoutKey={key}
              threats={threats}
              exposure={board.exposure}
              crossings={board.crossings}
              diff={diff}
              lit={lit}
              draft={review}
              focus={rankThreats(threats)[0]?.element ?? null}
            />
          ) : (
            <div className="workspace-wait" role="status">
              {error ? `The map could not be laid out: ${error}` : <span className="spinner" aria-label="Laying out the map" />}
            </div>
          )}

          {analysis?.verdict && <Verdict text={analysis.verdict} />}

          {source && !activePath && highlight.length > 0 && (
            <div className="lit-chip" role="status">
              <span className="lit-swatch" aria-hidden="true" />
              <span>
                {SOURCE_TEXT[source]}: {shownLabels.join(", ")}
                {highlight.length > 4 && ` and ${highlight.length - 4} more`}
              </span>
              <button type="button" className="btn btn-ghost btn-sm" onClick={clearHighlight}>
                Clear
              </button>
            </div>
          )}

          {selected && (
            <Inspector
              map={map}
              id={selected}
              editable={review}
              threats={threats}
              exposure={board.status === "ready" ? board.exposure : []}
              crossings={board.crossings}
              onChange={edit}
              onAsk={asking ? () => setAskSignal((n) => n + 1) : null}
            />
          )}

          {busy && (
            <div className="workspace-busy" role="status">
              <span className="spinner" aria-hidden="true" />
              <span className="hand">{board.status === "analyzing" ? "Finding threats on this map..." : "Redrawing the map..."}</span>
            </div>
          )}

          <button
            type="button"
            className="btn btn-sm panel-toggle"
            aria-expanded={panelOpen}
            aria-controls="workspace-panel"
            onClick={() => setPanelOpen((open) => !open)}
          >
            <SidebarIcon /> {panelOpen ? "Hide panel" : "Show panel"}
          </button>
        </div>

        {asking && <AskDock board={board} map={map} focusSignal={askSignal} />}
      </div>

      {panelOpen && (
        <aside id="workspace-panel" className="workspace-panel" aria-label={review ? "Review the map" : "Threat model"}>
          <ResizeHandle
            label="Resize side panel"
            controls="workspace-panel"
            edge="left"
            size={panelWidth}
            bounds={panelBounds}
            fallback={PANEL_DEFAULT}
            onResize={setPanelWidth}
          />
          {busy ? (
            <div className="panel">
              <p className="muted">
                {board.status === "analyzing"
                  ? "Threats appear here once the analysis finishes."
                  : "The map is being redrawn from the new material."}
              </p>
              <ProviderLine />
              <ActivityLog board={board} open />
            </div>
          ) : review ? (
            <ReviewPanel
              board={board}
              draft={draft}
              dirty={dirty}
              staleEdits={staleEdits}
              diff={diff}
              onSaved={(next) => {
                setDirty(false);
                setEditBase(null);
                seenRevision.current = next.revision;
                setDraft(next.map ?? draft);
                onApply(next);
              }}
              onDiscard={() => {
                setDraft(serverMap);
                setDirty(false);
                setEditBase(null);
              }}
              onApply={onApply}
            />
          ) : (
            <ReadyPanel board={board} map={map} />
          )}
        </aside>
      )}
    </div>
  );
}

function Verdict({ text }: { text: string }) {
  const [folded, setFolded] = useState(false);
  return (
    <div className={`verdict ${folded ? "is-folded" : ""}`}>
      <div className="verdict-head">
        <span className="verdict-label">Fix first</span>
        <button
          type="button"
          className="btn btn-ghost btn-icon btn-sm"
          aria-label={folded ? "Show the verdict" : "Fold the verdict away"}
          aria-expanded={!folded}
          onClick={() => setFolded((was) => !was)}
        >
          {folded ? "+" : <CloseIcon width={14} height={14} />}
        </button>
      </div>
      {!folded && <p className="verdict-text hand">{text}</p>}
    </div>
  );
}
