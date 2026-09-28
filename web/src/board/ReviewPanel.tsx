import { useState } from "react";

import { api, errorMessage } from "../api/client.ts";
import type { BoardOut, SystemMap } from "../api/types.ts";
import { useSession } from "../shell/session.tsx";
import { ActivityLog } from "./ActivityLog.tsx";
import { hasChanges, type MapDiff } from "./mapDiff.ts";
import { mapProblem } from "./mapEdit.ts";
import { useBoardUi } from "./store.ts";
import "./Panel.css";

// =============================================================================
// Module Overview
// =============================================================================
// The review side panel. Threats are pinned to nodes and flows, so a wrong map
// means wrong threats; this panel asks the user to check the draft, shows what
// changed since the last map, saves hand edits and confirms the map.

interface ReviewPanelProps {
  board: BoardOut;
  draft: SystemMap;
  dirty: boolean;
  staleEdits: boolean;
  diff: MapDiff | null;
  onSaved: (next: BoardOut) => void;
  onDiscard: () => void;
  onApply: (next: BoardOut) => void;
}

/** Review, edit and confirm a draft map. */
export function ReviewPanel({ board, draft, dirty, staleEdits, diff, onSaved, onDiscard, onApply }: ReviewPanelProps) {
  const { refreshMe } = useSession();
  const [busy, setBusy] = useState<"save" | "confirm" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const select = useBoardUi((s) => s.select);

  const save = async (): Promise<BoardOut | null> => {
    const problem = mapProblem(draft);
    if (problem) {
      setError(problem);
      return null;
    }
    const next = await api.saveMap(board.id, draft);
    onSaved(next);
    return next;
  };

  const run = async (kind: "save" | "confirm") => {
    setBusy(kind);
    setError(null);
    try {
      if (dirty && (await save()) === null) return;
      if (kind === "confirm") {
        onApply(await api.confirm(board.id));
        // Finding threats spent a model call, and the count beside the user's name should say so.
        refreshMe();
      }
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(null);
    }
  };

  const label = (id: string) =>
    draft.nodes.find((n) => n.id === id)?.label ?? draft.flows.find((f) => f.id === id)?.label ?? id;

  return (
    <div className="panel">
      <div className="sticky-note">
        <h2 className="hand sticky-title">Check the map before threats are found</h2>
        <p>
          Every threat is pinned to a node or flow here, so a wrong map gives wrong threats. Click anything to see the
          evidence it was drawn from, and fix names, kinds, boundaries or flags.
        </p>
        <button type="button" className="btn btn-primary sticky-confirm" onClick={() => void run("confirm")} disabled={busy !== null}>
          {busy === "confirm" && <span className="spinner" aria-hidden="true" />}
          {dirty ? "Save and find threats" : "Looks right, find threats"}
        </button>
      </div>

      {dirty && (
        <div className={`banner ${staleEdits ? "banner-error" : ""}`} role="status">
          <div className="banner-body">
            {staleEdits
              ? "Someone else changed this map while you were editing. Saving replaces their version with yours."
              : "You have unsaved edits."}
            <div className="panel-row">
              <button type="button" className="btn btn-sm btn-accent" onClick={() => void run("save")} disabled={busy !== null}>
                {busy === "save" && <span className="spinner" aria-hidden="true" />} Save changes
              </button>
              <button type="button" className="btn btn-sm btn-ghost" onClick={onDiscard} disabled={busy !== null}>
                Discard
              </button>
            </div>
          </div>
        </div>
      )}

      {error && (
        <p className="panel-error" role="alert">
          {error}
        </p>
      )}

      {diff && hasChanges(diff) && (
        <section className="panel-section">
          <h3 className="panel-label">Changed since the last map</h3>
          <ul className="diff-list">
            {diff.added.map((id) => (
              <li key={`a-${id}`}>
                <span className="diff-mark diff-added">new</span>
                <button type="button" className="panel-link" onClick={() => select(id)}>
                  {label(id)}
                </button>
              </li>
            ))}
            {diff.changed.map((id) => (
              <li key={`c-${id}`}>
                <span className="diff-mark diff-changed">edited</span>
                <button type="button" className="panel-link" onClick={() => select(id)}>
                  {label(id)}
                </button>
              </li>
            ))}
            {diff.removed.map((item) => (
              <li key={`r-${item.id}`}>
                <span className="diff-mark diff-removed">gone</span>
                <s>{item.label}</s>
                <span className="muted"> {item.type}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="panel-section">
        <h3 className="panel-label">Things to check</h3>
        <ul className="check-list">
          <li>Every part your team runs sits inside the right trust boundary.</li>
          <li>Stores with credentials, personal or payment data are marked sensitive.</li>
          <li>Anything that calls a language model or agent is marked AI.</li>
          <li>No flow is missing, especially ones that leave your systems.</li>
        </ul>
        <p className="panel-meta">
          {draft.nodes.length} nodes, {draft.flows.length} flows, {draft.boundaries.length} trust boundaries
        </p>
      </section>

      {draft.assumptions.length > 0 && (
        <section className="panel-section">
          <h3 className="panel-label">What was assumed</h3>
          <ul className="assumption-list">
            {draft.assumptions.map((assumption) => (
              <li key={assumption}>{assumption}</li>
            ))}
          </ul>
        </section>
      )}

      <details className="panel-section">
        <summary className="panel-label">Everything on the map</summary>
        <ul className="element-list">
          {draft.nodes.map((node) => (
            <li key={node.id}>
              <button type="button" className="panel-link" onClick={() => select(node.id)}>
                {node.label}
              </button>
              <span className="muted"> {node.kind}</span>
            </li>
          ))}
          {draft.flows.map((flow) => (
            <li key={flow.id}>
              <button type="button" className="panel-link" onClick={() => select(flow.id)}>
                {label(flow.source)} to {label(flow.target)}: {flow.label}
              </button>
            </li>
          ))}
        </ul>
      </details>

      <ActivityLog board={board} />
    </div>
  );
}
