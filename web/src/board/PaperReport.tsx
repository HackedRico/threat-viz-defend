import type { BoardOut, SystemMap, ThreatAnalysis } from "../api/types.ts";
import { SeverityBadge } from "../shell/SeverityBadge.tsx";
import { findingsLine } from "./brief.ts";
import { codeLocation, codeSpans, flowLabel, labelOf } from "./elements.ts";
import { MAP_ROOM, pageFor } from "./exportPlan.ts";
import type { MapLayout } from "./layout.ts";
import { MapKeyItems } from "./MapLegend.tsx";
import { MapPicture } from "./MapPicture.tsx";
import { PinBadge } from "./PinMark.tsx";
import { rankThreats, SEVERITIES, severityRank, STRIDE } from "./severity.ts";
import "./PaperReport.css";

// =============================================================================
// Module Overview
// =============================================================================
// The board as a printed report, which the PDF export prints. It never shows
// on screen; while it is mounted, printing shows it alone. A cover with the
// short version and every threat at a glance, the drawn map on a page of its
// own turned to fit it (`pageFor`), then each threat in full, the attack paths
// and AI exposure, and from a fresh page the parts, the flows and the
// assumptions for reference. It wears the light theme whatever the page
// wears, since paper is white. Model text renders as React text only.

const KIND: Record<SystemMap["nodes"][number]["kind"], string> = {
  external: "External",
  process: "Process",
  store: "Data store",
};

/** Everything the report prints, from a ready board. */
export interface PaperReportProps {
  board: BoardOut;
  map: SystemMap;
  analysis: ThreatAnalysis;
  layout: MapLayout;
  appName: string;
  exportedAt: Date;
}

/** The printable threat model; mount it as a child of `<body>`, then print. */
export function PaperReport({ board, map, analysis, layout, appName, exportedAt }: PaperReportProps) {
  const threats = rankThreats(analysis.threats);
  const paths = [...analysis.paths].sort((a, b) => severityRank(a.severity) - severityRank(b.severity));
  const orientation = pageFor(layout);
  const zones = new Map(map.boundaries.map((b) => [b.id, b.label]));
  const crossings = new Set(board.crossings);
  const exposure = board.exposure.filter((x) => x.lethal);
  const date = exportedAt.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
  const where = (id: string) => labelOf(id, map, analysis);
  const threatIds = (element: string) => threats.filter((t) => t.element === element).map((t) => t.id);
  const detailed = map.nodes.filter((node) => node.how.length > 0 || node.code.length > 0);
  const tally = SEVERITIES.filter((level) => board.counts[level] > 0);

  return (
    <article className="paper theme-light" aria-label={`${board.title}, printable threat model`}>
      <header className="paper-head">
        <p className="paper-kicker">{appName} threat model</p>
        <h1 className="paper-title">{board.title}</h1>
        <p className="paper-meta">
          Exported {date}
          {board.analyzed_by ? `. Analyzed by ${board.analyzed_by}` : ""}. {count(map.nodes.length, "part")},{" "}
          {count(map.flows.length, "flow")} and {count(map.boundaries.length, "trust boundary", "trust boundaries")}.
        </p>
        {tally.length > 0 && (
          <p className="paper-tally">
            {tally.map((level) => (
              <SeverityBadge key={level} severity={level} count={board.counts[level]} />
            ))}
          </p>
        )}
      </header>

      <section className="paper-brief" aria-label="The short version">
        <div className="paper-brief-part">
          <h2 className="paper-label">What this is</h2>
          <p>
            <strong>{map.name}.</strong> {map.summary}
          </p>
        </div>
        <div className="paper-brief-part">
          <h2 className="paper-label">What could go wrong</h2>
          <p>{findingsLine(board.counts, analysis.paths.length)}</p>
        </div>
        {analysis.verdict && (
          <div className="paper-brief-part paper-fix">
            <h2 className="paper-label">Fix first</h2>
            <p className="paper-verdict">{analysis.verdict}</p>
          </div>
        )}
      </section>

      <p className="paper-caveat">
        A language model wrote these findings from a map a person checked. Check each one against its evidence before
        acting on it.
      </p>

      {threats.length > 0 && (
        <section className="paper-section">
          <h2 className="paper-heading">Threats at a glance</h2>
          <table className="paper-table paper-glance">
            <thead>
              <tr>
                <th scope="col">Pin</th>
                <th scope="col">Threat</th>
                <th scope="col">Severity</th>
                <th scope="col">Kind</th>
                <th scope="col">Where</th>
              </tr>
            </thead>
            <tbody>
              {threats.map((threat) => (
                <tr key={threat.id}>
                  <td>
                    <PinBadge severity={threat.severity} label={pinNumber(threat.id)} />
                  </td>
                  <td>
                    <span className="mono">{threat.id}</span> {threat.title}
                  </td>
                  <td>
                    <SeverityBadge severity={threat.severity} />
                  </td>
                  <td>{STRIDE[threat.stride].name}</td>
                  <td>{where(threat.element)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <section className={`paper-map is-${orientation}`} aria-labelledby="paper-map-title">
        <h2 id="paper-map-title" className="paper-heading">
          The map
        </h2>
        <p className="paper-caption">
          Boxes are parts of the system and arrows are data moving between them. Each numbered pin is a threat, described
          in full after the map.
        </p>
        <figure className="paper-figure">
          <MapPicture
            map={map}
            layout={layout}
            threats={analysis.threats}
            exposure={board.exposure}
            crossings={board.crossings}
            label={`Data flow diagram of ${map.name} with ${count(threats.length, "threat")} pinned`}
            style={{ maxHeight: `${MAP_ROOM[orientation].height}mm` }}
          />
        </figure>
        <div className="paper-key">
          <MapKeyItems draft={false} />
        </div>
      </section>

      <section className="paper-section paper-threats">
        <h2 className="paper-heading">Threats, worst first</h2>
        {threats.length === 0 ? (
          <p>No threats were found on this map.</p>
        ) : (
          <ol className="paper-threat-list">
            {threats.map((threat) => (
              <li key={threat.id} className={`paper-threat paper-edge-${threat.severity}`}>
                <div className="paper-threat-head">
                  <PinBadge severity={threat.severity} label={pinNumber(threat.id)} />
                  <h3>
                    <span className="mono">{threat.id}</span> {threat.title}
                  </h3>
                </div>
                <p className="paper-threat-tags">
                  <SeverityBadge severity={threat.severity} />
                  <span className="chip">{STRIDE[threat.stride].name}</span>
                  <span>on {where(threat.element)}</span>
                </p>
                <p className="paper-threat-summary">{threat.summary}</p>
                <p>{threat.statement}</p>
                <p>
                  <strong>Impact.</strong> {threat.impact}
                </p>
                {threat.fixes.length > 0 && (
                  <div>
                    <p className="paper-label">Fixes to start today</p>
                    <ul className="paper-list">
                      {threat.fixes.map((fix, index) => (
                        <li key={`${fix}-${index}`}>{fix}</li>
                      ))}
                    </ul>
                  </div>
                )}
                <blockquote className="paper-evidence">
                  <span className="paper-label">Evidence</span> {threat.evidence}
                </blockquote>
                {threat.refs.length > 0 && (
                  <p className="paper-refs">
                    {threat.refs.map((ref, index) => (
                      <span key={`${ref}-${index}`} className="chip mono">
                        {ref}
                      </span>
                    ))}
                  </p>
                )}
              </li>
            ))}
          </ol>
        )}
      </section>

      {paths.length > 0 && (
        <section className="paper-section">
          <h2 className="paper-heading">Attack paths</h2>
          <ol className="paper-path-list">
            {paths.map((path) => (
              <li key={path.id} className="paper-path">
                <h3>
                  <span className="mono">{path.id}</span> {path.title} <SeverityBadge severity={path.severity} />
                </h3>
                <p>{path.story}</p>
                <ol className="paper-steps" aria-label="Steps">
                  {path.steps.map((step, index) => (
                    <li key={`${step}-${index}`}>{where(step)}</li>
                  ))}
                </ol>
                {path.threats.length > 0 && <p className="paper-muted">Through {path.threats.map(where).join(", ")}</p>}
              </li>
            ))}
          </ol>
        </section>
      )}

      {exposure.length > 0 && (
        <section className="paper-section">
          <h2 className="paper-heading">Lethal trifecta</h2>
          <p className="paper-muted">
            An AI part that reads sensitive data, takes in untrusted content and can send data out can be talked into
            leaking that data.
          </p>
          <ul className="paper-list">
            {exposure.map((x) => (
              <li key={x.node}>
                <strong>{where(x.node)}</strong> reads sensitive data from {names(x.private_data, where)}, takes untrusted
                input from {names(x.untrusted, where)} and can send data out to {names(x.outbound, where)}.
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="paper-section paper-appendix">
        <h2 className="paper-heading">Parts of the system</h2>
        <table className="paper-table">
          <thead>
            <tr>
              <th scope="col">Part</th>
              <th scope="col">Kind</th>
              <th scope="col">Tech</th>
              <th scope="col">Trust zone</th>
              <th scope="col">Marks</th>
              <th scope="col">Threats</th>
            </tr>
          </thead>
          <tbody>
            {map.nodes.map((node) => (
              <tr key={node.id}>
                <td>{node.label}</td>
                <td>{KIND[node.kind]}</td>
                <td>{node.tech ?? ""}</td>
                <td>{(node.boundary && zones.get(node.boundary)) || "Outside"}</td>
                <td>{[node.ai ? "AI" : null, node.sensitive ? "Sensitive data" : null].filter(Boolean).join(", ")}</td>
                <td className="mono">{threatIds(node.id).join(", ")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {detailed.length > 0 && (
        <section className="paper-section">
          <h2 className="paper-heading">How each part works</h2>
          <div className="paper-parts">
            {detailed.map((node) => (
              <div key={node.id} className="paper-part">
                <h3>{node.label}</h3>
                {node.how.length > 0 && (
                  <ul className="paper-list">
                    {node.how.map((point, index) => (
                      <li key={index}>
                        <CodeText text={point} />
                      </li>
                    ))}
                  </ul>
                )}
                {node.code.length > 0 && (
                  <p className="paper-muted">
                    In the code:{" "}
                    {node.code.map((ref, index) => (
                      <span key={index}>
                        {index > 0 && ", "}
                        <code>{codeLocation(ref)}</code>
                        {ref.symbol && ` (${ref.symbol})`}
                      </span>
                    ))}
                  </p>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="paper-section">
        <h2 className="paper-heading">Data flows</h2>
        <table className="paper-table">
          <thead>
            <tr>
              <th scope="col">Flow</th>
              <th scope="col">Carries</th>
              <th scope="col">Crosses a trust boundary</th>
              <th scope="col">Threats</th>
            </tr>
          </thead>
          <tbody>
            {map.flows.map((flow) => (
              <tr key={flow.id}>
                <td>{flowLabel(map, flow)}</td>
                <td>{flow.data ?? ""}</td>
                <td>{crossings.has(flow.id) ? "Yes" : "No"}</td>
                <td className="mono">{threatIds(flow.id).join(", ")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {map.assumptions.length > 0 && (
        <section className="paper-section">
          <h2 className="paper-heading">Assumptions</h2>
          <ul className="paper-list">
            {map.assumptions.map((assumption, index) => (
              <li key={`${assumption}-${index}`}>{assumption}</li>
            ))}
          </ul>
        </section>
      )}

      <footer className="paper-foot">
        Exported with {appName} on {date}.
      </footer>
    </article>
  );
}

/** The number a threat's pin shows, as on the canvas. */
function pinNumber(id: string): string {
  return id.replace(/\D/g, "") || id;
}

function count(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function names(ids: readonly string[], name: (id: string) => string): string {
  return ids.length > 0 ? ids.map(name).join(", ") : "nothing";
}

// Backticked names in model text print in mono; every run is still a React text node, never HTML.
function CodeText({ text }: { text: string }) {
  return (
    <>
      {codeSpans(text).map((span, index) => (span.code ? <code key={index}>{span.text}</code> : span.text))}
    </>
  );
}
