import { useEffect, useId, useMemo, useRef, useState } from "react";

import { api, errorMessage } from "../api/client.ts";
import type { MapVersionOut, MapVersionSummary, SystemMap } from "../api/types.ts";
import { CloseIcon } from "../shell/icons.tsx";
import { formatTime } from "./ActivityLog.tsx";
import { pickDirection, type Direction, type MapLayouts } from "./layout.ts";
import { diffMaps, type MapDiff } from "./mapDiff.ts";
import { MapPicture } from "./MapPicture.tsx";
import { layOutBoth } from "./useMapLayout.ts";
import { sourceWord, threatChanges, versionFacts, versionTitle } from "./versions.ts";
import "./Panel.css";
import "./VersionCompare.css";

// =============================================================================
// Module Overview
// =============================================================================
// The compare dialog the version chips open: two versions of the map side by
// side, drawn with the same marks as the canvas, the later one marked where it
// is new or edited. Either side can be set to any kept version, so the long
// history lives in two menus here rather than on the canvas. Below the maps, a
// line says what changed, and the full list waits behind a disclosure.

// A pane's drawing area, for picking one direction that suits both maps.
const PANE = { width: 560, height: 440 };

type Loaded = { version: MapVersionOut; layouts: MapLayouts } | { error: string };

/** The compare dialog for one board; it opens on mount and calls `onClose` when dismissed. */
export function VersionCompare({
  boardId,
  versions,
  initial,
  onClose,
}: {
  boardId: string;
  versions: readonly MapVersionSummary[];
  initial: { before: number; after: number };
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [before, setBefore] = useState(initial.before);
  const [after, setAfter] = useState(initial.after);
  const [loaded, setLoaded] = useState<Record<string, Loaded>>({});
  const current = versions[versions.length - 1]?.number ?? after;
  // Newest first in the menus, where the recent past is what people look for.
  const newestFirst = useMemo(() => [...versions].reverse(), [versions]);

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.current?.showModal();
    return () => opener?.focus();
  }, []);

  // A version's threats can arrive after it was loaded, when a confirm finishes, so its counts are in the key.
  const keyOf = (number: number) => `${number}:${JSON.stringify(versions.find((v) => v.number === number)?.counts ?? null)}`;
  const beforeKey = keyOf(before);
  const afterKey = keyOf(after);

  useEffect(() => {
    let alive = true;
    for (const [number, key] of [
      [before, beforeKey],
      [after, afterKey],
    ] as const) {
      if (loaded[key]) continue;
      api
        .version(boardId, number)
        .then(async (version) => ({ version, layouts: await layOutBoth(version.map) }))
        .then(
          (entry) => alive && setLoaded((was) => ({ ...was, [key]: entry })),
          (caught: unknown) => alive && setLoaded((was) => ({ ...was, [key]: { error: errorMessage(caught) } })),
        );
    }
    return () => {
      alive = false;
    };
    // `loaded` is read only to skip versions already fetched; refetching whenever it changes would loop.
  }, [boardId, before, after, beforeKey, afterKey]);

  const left = loaded[beforeKey];
  const right = loaded[afterKey];
  const leftMap = left && "version" in left ? left.version : null;
  const rightMap = right && "version" in right ? right.version : null;
  // One direction for both, picked from the later map, so the two drawings line up for the eye.
  const direction: Direction = rightMap && right && "layouts" in right ? pickDirection(right.layouts, PANE.width, PANE.height) : "DOWN";
  const diff = useMemo(() => (leftMap && rightMap ? diffMaps(leftMap.map, rightMap.map) : null), [leftMap, rightMap]);

  const summaryOf = (number: number) => versions.find((v) => v.number === number) ?? null;

  return (
    <dialog ref={dialog} className="version-compare" aria-labelledby={titleId} onClose={onClose}>
      <header className="vc-head">
        <h2 id={titleId} className="vc-title">
          Compare versions
        </h2>
        <button type="button" className="btn btn-ghost btn-icon" aria-label="Close" title="Close" onClick={() => dialog.current?.close()}>
          <CloseIcon />
        </button>
      </header>

      <div className="vc-panes">
        <Pane
          side="Before"
          number={before}
          other={after}
          summary={summaryOf(before)}
          entry={left}
          direction={direction}
          diff={null}
          options={newestFirst}
          current={current}
          onPick={setBefore}
        />
        <Pane
          side="After"
          number={after}
          other={before}
          summary={summaryOf(after)}
          entry={right}
          direction={direction}
          diff={diff}
          options={newestFirst}
          current={current}
          onPick={setAfter}
        />
      </div>

      <Changes diff={diff} before={summaryOf(before)} after={summaryOf(after)} afterMap={rightMap?.map ?? null} />
    </dialog>
  );
}

function Pane({
  side,
  number,
  other,
  summary,
  entry,
  direction,
  diff,
  options,
  current,
  onPick,
}: {
  side: "Before" | "After";
  number: number;
  other: number;
  summary: MapVersionSummary | null;
  entry: Loaded | undefined;
  direction: Direction;
  diff: MapDiff | null;
  options: readonly MapVersionSummary[];
  current: number;
  onPick: (number: number) => void;
}) {
  const pickId = useId();
  return (
    <section className="vc-pane" aria-label={`${side}: version ${number}`}>
      <div className="vc-pick">
        <label htmlFor={pickId} className="vc-side">
          {side}
        </label>
        <select id={pickId} className="vc-select" value={number} onChange={(event) => onPick(Number(event.target.value))}>
          {options.map((option) => (
            <option key={option.number} value={option.number} disabled={option.number === other}>
              {versionTitle(option, current)}
            </option>
          ))}
        </select>
      </div>
      {summary && (
        <p className="vc-facts">
          <span className={`vc-source vc-source-${summary.source}`}>{sourceWord(summary.source)}</span>
          <time dateTime={summary.created_at}>{formatTime(summary.created_at)}</time>
          <span aria-hidden="true">·</span>
          <span>{versionFacts(summary)}</span>
        </p>
      )}
      <div className="vc-stage">
        {entry === undefined ? (
          <span className="spinner" aria-label={`Loading version ${number}`} />
        ) : "error" in entry ? (
          <p className="vc-error" role="alert">
            {entry.error}
          </p>
        ) : (
          <MapPicture
            map={entry.version.map}
            layout={entry.layouts[direction]}
            threats={entry.version.analysis?.threats ?? []}
            exposure={entry.version.exposure}
            crossings={entry.version.crossings}
            diff={diff}
            label={`${side}: version ${number} of the map`}
          />
        )}
      </div>
    </section>
  );
}

function Changes({
  diff,
  before,
  after,
  afterMap,
}: {
  diff: MapDiff | null;
  before: MapVersionSummary | null;
  after: MapVersionSummary | null;
  afterMap: SystemMap | null;
}) {
  if (diff === null || afterMap === null || before === null || after === null) {
    return <p className="vc-changes muted">Working out what changed...</p>;
  }
  const label = (id: string) => afterMap.nodes.find((n) => n.id === id)?.label ?? afterMap.flows.find((f) => f.id === id)?.label ?? id;
  const threats = threatChanges(before.counts, after.counts);
  const total = diff.added.length + diff.changed.length + diff.removed.length;
  return (
    <section className="vc-changes" aria-label="What changed">
      <p className="vc-counts">
        {total === 0 ? (
          <span>The parts and flows are the same.</span>
        ) : (
          <>
            {diff.added.length > 0 && <span className="diff-mark diff-added">{diff.added.length} new</span>}
            {diff.changed.length > 0 && <span className="diff-mark diff-changed">{diff.changed.length} edited</span>}
            {diff.removed.length > 0 && <span className="diff-mark diff-removed">{diff.removed.length} gone</span>}
          </>
        )}
        <span className="vc-threats">
          {threats === null
            ? `No threats found on v${before.counts === null ? before.number : after.number} yet, so they can't be compared.`
            : threats.length === 0
              ? "Same threats by severity."
              : threats.map((t) => `${t.severity} ${t.before} to ${t.after}`).join(", ")}
        </span>
      </p>
      {total > 0 && (
        <details className="vc-details">
          <summary>Show every change</summary>
          <ul className="diff-list">
            {diff.added.map((id) => (
              <li key={`a-${id}`}>
                <span className="diff-mark diff-added">new</span>
                {label(id)}
              </li>
            ))}
            {diff.changed.map((id) => (
              <li key={`c-${id}`}>
                <span className="diff-mark diff-changed">edited</span>
                {label(id)}
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
        </details>
      )}
    </section>
  );
}
