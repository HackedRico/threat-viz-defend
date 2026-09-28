import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";

import type { BoardOut, SystemMap, ThreatAnalysis } from "../api/types.ts";
import { CloseIcon, SidebarIcon } from "../shell/icons.tsx";
import { ResizeHandle, useStoredWidth } from "../shell/ResizeHandle.tsx";
import { clampWidth } from "../shell/resize.ts";
import { guardLeaving } from "../shell/route.ts";
import { isBusy } from "../shell/statusText.ts";
import { ProviderLine } from "../settings/ProviderSettings.tsx";
import { ActivityLog } from "./ActivityLog.tsx";
import { AskDock } from "./AskDock.tsx";
import { findingsLine } from "./brief.ts";
import { expandHighlight, labelOf } from "./elements.ts";
import { Inspector } from "./Inspector.tsx";
import { MapCanvas } from "./MapCanvas.tsx";
import { diffMaps } from "./mapDiff.ts";
import { ReadyPanel } from "./ReadyPanel.tsx";
import { ReviewPanel } from "./ReviewPanel.tsx";
import { rankThreats } from "./severity.ts";
import { useBoardUi, type HighlightSource } from "./store.ts";
import { useMapLayout } from "./useMapLayout.ts";
import { VersionBar } from "./VersionBar.tsx";
import { VersionCompare } from "./VersionCompare.tsx";
import { comparePair } from "./versions.ts";
import "./Panel.css";
import "./Workspace.css";

// =============================================================================
// Module Overview
// =============================================================================
// A board with a map: the canvas on the left, the review or threat panel on
// the right, and on a finished board the ask bar docked under the canvas. In
// review the map is a local draft the user edits and saves; once ready it is
// read only and lights up from answers, quiz results, the voice coach and
// attack paths. The selected node or flow shows its details in the side panel,
// over the panel's lists, so nothing ever covers the map.

const SOURCE_TEXT: Record<HighlightSource, string> = {
  ask: "Lit by the answer",
  quiz: "Lit by your quiz result",
  voice: "Lit by the voice coach",
  weak: "Your weak spots",
  threat: "Lit by the threat",
};

const DISCARD_EDITS = "Discard your unsaved map edits?";
const PANEL_WIDTH_KEY = "panel-width";
const BRIEF_FOLDED_KEY = "brief-folded";
const PANEL_DEFAULT = 380;
const PANEL_BOUNDS = { min: 320, max: 900 };

/** The map and its side panel for a board in review, analysis or ready. */
export function Workspace({
  board,
  onApply,
  top,
}: {
  board: BoardOut;
  onApply: (next: BoardOut) => void;
  /** The board's header and banners, drawn above the map so the side panel can take the full height. */
  top: ReactNode;
}) {
  const review = board.status === "review";
  const serverMap = board.map!;
  const [draft, setDraft] = useState<SystemMap>(serverMap);
  const [dirty, setDirty] = useState(false);
  // The server's map as it was when editing began, so only a change to the map itself, not a rename, reads as stale.
  const [editBase, setEditBase] = useState<string | null>(null);
  const serverMapJson = useMemo(() => JSON.stringify(serverMap), [serverMap]);
  const [panelOpen, setPanelOpen] = useState(true);
  const [askSignal, setAskSignal] = useState(0);
  // The two versions the compare dialog shows, or `null` while it is closed.
  const [comparing, setComparing] = useState<{ before: number; after: number } | null>(null);
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

  // The draft lives only here, so while it holds unsaved edits, going to another screen, adding material
  // or closing the page asks first. Back and forward move the URL before any code runs, so they cannot ask.
  useEffect(() => {
    if (!dirty) return undefined;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // Chrome and Edge before version 119 ask only when this is set.
      event.returnValue = true;
    };
    window.addEventListener("beforeunload", warn);
    const release = guardLeaving(() => window.confirm(DISCARD_EDITS));
    return () => {
      window.removeEventListener("beforeunload", warn);
      release();
    };
  }, [dirty]);

  const map = review ? draft : serverMap;
  const { layouts, key, error } = useMapLayout(map);
  const diff = useMemo(() => (review && board.previous_map ? diffMaps(board.previous_map, map) : null), [review, board.previous_map, map]);
  const analysis = board.status === "ready" ? board.analysis : null;
  const threats = analysis?.threats ?? [];

  const selected = useBoardUi((s) => s.selected);
  const select = useBoardUi((s) => s.select);
  const highlight = useBoardUi((s) => s.highlight);
  const source = useBoardUi((s) => s.highlightSource);
  const hoverPath = useBoardUi((s) => s.hoverPath);
  const pinnedPath = useBoardUi((s) => s.pinnedPath);
  const clearHighlight = useBoardUi((s) => s.clearHighlight);

  const activePath = hoverPath ?? pinnedPath;
  const lit = useMemo(() => {
    const ids = activePath ? [activePath] : highlight;
    if (ids.length === 0) return null;
    // Threat and path ids expand to nothing once the board leaves ready, and an empty set would dim the whole map.
    const shown = expandHighlight(ids, map, analysis);
    return shown.length > 0 ? new Set(shown) : null;
  }, [activePath, highlight, map, analysis]);

  // Leaving ready, say for a coding agent's change, ends what was lit: those ids belong to the threats just retired.
  const ready = board.status === "ready";
  useEffect(() => {
    if (ready) return;
    const ui = useBoardUi.getState();
    ui.clearHighlight();
    ui.setHoverPath(null);
    ui.showThreat(null);
  }, [ready]);

  const edit = (next: SystemMap) => {
    if (!dirty) setEditBase(serverMapJson);
    setDraft(next);
    setDirty(true);
  };
  // Someone else, such as a coding agent, saved the board while these edits were open.
  const staleEdits = dirty && editBase !== null && serverMapJson !== editBase;

  const busy = isBusy(board.status);
  const asking = analysis !== null;
  const shownLabels = highlight.slice(0, 4).map((id) => labelOf(id, map, analysis));
  // Only a node or flow still on the map has details; a deleted one shows none.
  const inspected = selected !== null && (map.nodes.some((n) => n.id === selected) || map.flows.some((f) => f.id === selected)) ? selected : null;
  // The panel is where details show, so selecting opens a hidden panel, and it hides again
  // when the details close: the reader who hid it gets the whole map back.
  const panelShown = panelOpen || inspected !== null;

  return (
    <div
      className={`workspace ${panelShown ? "" : "panel-closed"}`}
      style={{ "--panel-width": `${panelWidth}px` } as CSSProperties}
    >
      <div className="workspace-stage">
        {top}
        <div className="workspace-canvas">
          {layouts && key && error && (
            <div className="banner banner-error workspace-layout-error" role="alert">
              The latest changes could not be laid out, so the map may be out of date: {error}
            </div>
          )}
          {layouts && key ? (
            <MapCanvas
              map={map}
              layouts={layouts}
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

          {analysis && <Brief board={board} map={map} analysis={analysis} />}

          {source && !activePath && lit !== null && (
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

          {busy && (
            <div className="workspace-busy" role="status">
              <span className="spinner" aria-hidden="true" />
              <span className="hand">{board.status === "analyzing" ? "Finding threats on this map..." : "Redrawing the map..."}</span>
            </div>
          )}

          <button
            type="button"
            className="btn btn-sm panel-toggle"
            aria-expanded={panelShown}
            aria-controls="workspace-panel"
            onClick={() => {
              // Hiding the panel puts away the details it holds, or they would open it again.
              if (panelShown) select(null);
              setPanelOpen(!panelShown);
            }}
          >
            <SidebarIcon /> {panelShown ? "Hide panel" : "Show panel"}
          </button>

          <VersionBar versions={board.versions} onOpen={(clicked) => setComparing(comparePair(board.versions, clicked))} />
        </div>

        {asking && <AskDock board={board} map={map} focusSignal={askSignal} />}
      </div>

      {comparing && (
        <VersionCompare boardId={board.id} versions={board.versions} initial={comparing} onClose={() => setComparing(null)} />
      )}

      {panelShown && (
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
          {/* Stays mounted under the details, so the tab, scroll, open cards, quiz and voice
              session are all still there after a look at one element. */}
          <div className="workspace-panel-main" inert={inspected !== null}>
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
          </div>
          {inspected && (
            <Inspector
              map={map}
              id={inspected}
              backTo={review ? "Review" : "Threat model"}
              editable={review}
              threats={threats}
              exposure={board.status === "ready" ? board.exposure : []}
              crossings={board.crossings}
              onChange={edit}
              onAsk={asking ? () => setAskSignal((n) => n + 1) : null}
            />
          )}
        </aside>
      )}
    </div>
  );
}

// A reader who opens a finished board cold, with no security background, gets
// what the system is, what was found, what to fix and how to read the drawing.
function Brief({ board, map, analysis }: { board: BoardOut; map: SystemMap; analysis: ThreatAnalysis }) {
  // Someone who folded it once has read it; later boards open with the map in full view.
  const [folded, setFolded] = useState(readBriefFolded);
  const toggle = () => {
    setFolded((was) => {
      try {
        localStorage.setItem(BRIEF_FOLDED_KEY, was ? "0" : "1");
      } catch {
        // Not remembering the choice is harmless.
      }
      return !was;
    });
  };
  return (
    <section className={`brief ${folded ? "is-folded" : ""}`} aria-labelledby="brief-title">
      <div className="brief-head">
        <h2 id="brief-title" className="brief-label">
          The short version
        </h2>
        <button
          type="button"
          className="btn btn-ghost btn-icon btn-sm"
          aria-label={folded ? "Show the short version" : "Fold the short version away"}
          aria-expanded={!folded}
          onClick={toggle}
        >
          {folded ? "+" : <CloseIcon width={14} height={14} />}
        </button>
      </div>
      {!folded && (
        <>
          <div className="brief-body">
            <div className="brief-part brief-what">
              <h3 className="brief-label">What this is</h3>
              <p>
                <strong>{map.name}.</strong> {map.summary}
              </p>
            </div>
            <div className="brief-part brief-risk">
              <h3 className="brief-label">What could go wrong</h3>
              <p>{findingsLine(board.counts, analysis.paths.length)}</p>
            </div>
            {analysis.verdict && (
              <div className="brief-part brief-fix">
                <h3 className="brief-label">Fix first</h3>
                <p className="brief-verdict hand">{analysis.verdict}</p>
              </div>
            )}
          </div>
          <p className="brief-howto">
            <strong>How to read the map:</strong> boxes are parts of the system and arrows are data moving between
            them. Each numbered pin is a threat: select one to see what could happen and how to fix it.
          </p>
        </>
      )}
    </section>
  );
}

function readBriefFolded(): boolean {
  try {
    return localStorage.getItem(BRIEF_FOLDED_KEY) === "1";
  } catch {
    // Storage can be blocked in private windows; the brief just starts open.
    return false;
  }
}
