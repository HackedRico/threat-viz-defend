import type { SystemMap, ThreatAnalysis } from "../api/types.ts";
import { SeverityBadge } from "../shell/SeverityBadge.tsx";
import { labelOf } from "./elements.ts";
import { rankThreats, severityRank } from "./severity.ts";
import { useBoardUi } from "./store.ts";

// =============================================================================
// Module Overview
// =============================================================================
// Attack paths, worst first. Hovering or focusing a path lights its steps and
// hops on the map; clicking pins the light on until clicked again.

/** The attack path list for a finished board. */
export function AttackPaths({ analysis, map }: { analysis: ThreatAnalysis; map: SystemMap }) {
  const setHoverPath = useBoardUi((s) => s.setHoverPath);
  const togglePinnedPath = useBoardUi((s) => s.togglePinnedPath);
  const pinnedPath = useBoardUi((s) => s.pinnedPath);
  const paths = [...analysis.paths].sort((a, b) => severityRank(a.severity) - severityRank(b.severity));
  const threatTitle = new Map(rankThreats(analysis.threats).map((t) => [t.id, t.title]));

  if (paths.length === 0) return <p className="muted">No attack paths were traced on this map.</p>;
  return (
    <ol className="path-list">
      {paths.map((path) => {
        const pinned = pinnedPath === path.id;
        return (
          <li key={path.id} className={`path-card ${pinned ? "is-pinned" : ""}`}>
            <button
              type="button"
              className="path-head"
              aria-pressed={pinned}
              onMouseEnter={() => setHoverPath(path.id)}
              onMouseLeave={() => setHoverPath(null)}
              onFocus={() => setHoverPath(path.id)}
              onBlur={() => setHoverPath(null)}
              onClick={() => togglePinnedPath(path.id)}
            >
              <span className="mono path-id">{path.id}</span>
              <span className="path-title">{path.title}</span>
              <SeverityBadge severity={path.severity} />
            </button>
            <p className="path-story">{path.story}</p>
            <ol className="path-steps" aria-label="Steps">
              {path.steps.map((step, i) => (
                <li key={`${step}-${i}`}>{labelOf(step, map, analysis)}</li>
              ))}
            </ol>
            {path.threats.length > 0 && (
              <p className="path-threats">
                Through{" "}
                {path.threats.map((id, i) => (
                  <span key={id}>
                    {i > 0 && ", "}
                    <button type="button" className="panel-link" onClick={() => useBoardUi.getState().showThreat(id)}>
                      {id} {threatTitle.get(id) ?? ""}
                    </button>
                  </span>
                ))}
              </p>
            )}
          </li>
        );
      })}
    </ol>
  );
}
