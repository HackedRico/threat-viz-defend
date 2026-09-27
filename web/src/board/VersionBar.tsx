import type { MapVersionSummary } from "../api/types.ts";
import { HistoryIcon } from "../shell/icons.tsx";
import { versionBar, versionFacts, versionTitle } from "./versions.ts";
import "./VersionBar.css";

// =============================================================================
// Module Overview
// =============================================================================
// The map's version chips in the canvas's top right corner: the newest few
// versions and a history button that folds the older ones away, so the corner
// stays small however long the history grows. Every control opens the compare
// dialog. A board with one map shows nothing, since there is nothing to compare.

/** The version chips; `onOpen` gets the clicked version's number, or `null` for the history button. */
export function VersionBar({ versions, onOpen }: { versions: readonly MapVersionSummary[]; onOpen: (clicked: number | null) => void }) {
  const bar = versionBar(versions);
  if (bar === null) return null;
  const older = bar.hidden > 0 ? `, and ${bar.hidden} older` : "";
  return (
    <div className="version-bar" role="toolbar" aria-label="Map versions">
      <button
        type="button"
        className="version-history"
        title={`Compare versions: ${versions.length} kept${older}`}
        aria-label={`Compare versions, ${versions.length} kept`}
        onClick={() => onOpen(null)}
      >
        <HistoryIcon width={15} height={15} />
        {bar.hidden > 0 && <span className="version-more">+{bar.hidden}</span>}
      </button>
      {bar.chips.map((version) => {
        const current = version.number === bar.current;
        return (
          <button
            key={version.number}
            type="button"
            className={`version-chip ${current ? "is-current" : ""}`}
            aria-current={current ? "true" : undefined}
            title={`${versionTitle(version, bar.current)}. ${versionFacts(version)}. ${current ? "Compare with the version before." : "Compare with the current map."}`}
            aria-label={`Version ${version.number}${current ? ", current" : ""}: compare`}
            onClick={() => onOpen(version.number)}
          >
            v{version.number}
          </button>
        );
      })}
    </div>
  );
}
