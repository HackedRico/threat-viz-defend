import { useEffect, useId, useRef } from "react";

import type { ElementKind, ExposureOut, Flow, MapNode, SystemMap, Threat } from "../api/types.ts";
import { BackIcon, TrashIcon } from "../shell/icons.tsx";
import { SeverityBadge } from "../shell/SeverityBadge.tsx";
import { flowLabel, isInferred } from "./elements.ts";
import { flowsTouching, removeElement, updateFlow, updateNode } from "./mapEdit.ts";
import { rankThreats, STRIDE } from "./severity.ts";
import { useBoardUi } from "./store.ts";
import "./Inspector.css";

// =============================================================================
// Module Overview
// =============================================================================
// The details for the selected node or flow, laid over the side panel's lists
// so nothing covers the map. A bar where the tabs were leads back to them. It
// always shows the evidence the map was drawn from; in review it also edits the
// element, and on a finished board it lists the threats pinned there and what
// an AI part is exposed to.

const KINDS: { value: ElementKind; label: string }[] = [
  { value: "external", label: "External person or vendor" },
  { value: "process", label: "Process" },
  { value: "store", label: "Data store" },
];

interface InspectorProps {
  map: SystemMap;
  id: string;
  /** The name of what the panel shows under the details, for the way back to it. */
  backTo: string;
  editable: boolean;
  threats: readonly Threat[];
  exposure: readonly ExposureOut[];
  crossings: readonly string[];
  onChange: (next: SystemMap) => void;
  onAsk: (() => void) | null;
}

/** The inspector for element `id`, or nothing when the id is not a node or flow. */
export function Inspector({ map, id, backTo, editable, threats, exposure, crossings, onChange, onAsk }: InspectorProps) {
  const select = useBoardUi((s) => s.select);
  const openThreat = useBoardUi((s) => s.openThreat);
  const root = useRef<HTMLElement>(null);
  const nav = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const node = map.nodes.find((n) => n.id === id);
  const flow = map.flows.find((f) => f.id === id);

  useEffect(() => {
    const details = root.current;
    if (!details) return;
    body.current?.scrollTo({ top: 0 });
    // A narrow window stacks the panel under the map, below the fold. Scroll up only the top of
    // the details, the bar's scroll margin in Inspector.css, so most of the map stays in view.
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
    nav.current?.scrollIntoView({ block: "nearest", behavior: motion });
    // A link that selected this may have left with what it sat in, or gone inert under the details.
    const active = document.activeElement;
    if (active === null || active === document.body || active.closest("[inert]")) details.focus({ preventScroll: true });
  }, [id]);

  if (!node && !flow) return null;
  const pinned = rankThreats(threats.filter((t) => t.element === id));
  const close = () => {
    select(null);
    focusOnMap(id);
  };

  return (
    <section
      ref={root}
      className="inspector"
      aria-label={`Details for ${node ? node.label : flow!.label}`}
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !event.nativeEvent.isComposing) {
          event.preventDefault();
          close();
        }
      }}
    >
      {/* Built from the tab bar's own classes, so it sits exactly where the tabs were. */}
      <div ref={nav} className="tab-bar inspector-nav">
        <button type="button" className="tab inspector-back" aria-label={`Back to ${backTo}`} onClick={close}>
          <BackIcon width={15} height={15} /> {backTo}
        </button>
      </div>
      <div ref={body} className="inspector-body">
        <div className="inspector-head">
          <span className="inspector-kind mono">{node ? node.kind : crossings.includes(id) ? "flow, crosses a boundary" : "flow"}</span>
          <span className="inspector-id mono">{id}</span>
        </div>
        {node ? (
          <NodeDetails map={map} node={node} editable={editable} exposure={exposure.find((x) => x.node === node.id)} onChange={onChange} />
        ) : (
          <FlowDetails map={map} flow={flow!} editable={editable} onChange={onChange} />
        )}

        {pinned.length > 0 && (
          <section className="inspector-section">
            <h3 className="inspector-label">Threats here</h3>
            <ul className="inspector-threats">
              {pinned.map((threat) => (
                <li key={threat.id}>
                  <button type="button" className="inspector-threat" onClick={() => openThreat(threat.id)}>
                    <span className="mono">{threat.id}</span>
                    <span className="inspector-threat-title">{threat.title}</span>
                    <SeverityBadge severity={threat.severity} />
                    <span className="chip">{STRIDE[threat.stride].name}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        {onAsk && (
          <button type="button" className="btn btn-sm inspector-ask" onClick={onAsk}>
            Ask about this
          </button>
        )}
        {editable && (
          <DeleteButton
            label={node ? node.label : flow!.label}
            extra={node ? flowsTouching(map, node.id).length : 0}
            onDelete={() => {
              onChange(removeElement(map, id));
              select(null);
              focusOnMap(null);
            }}
          />
        )}
      </div>
    </section>
  );
}

// Closing from inside the details hands the keyboard back to the element on the map, or to the
// map itself when the element is gone, so focus never falls to the top of the page.
function focusOnMap(id: string | null) {
  const element = id === null ? null : document.querySelector<SVGElement>(`[data-el="${CSS.escape(id)}"]`);
  (element ?? document.querySelector<HTMLElement>(".canvas"))?.focus();
}

function NodeDetails({
  map,
  node,
  editable,
  exposure,
  onChange,
}: {
  map: SystemMap;
  node: MapNode;
  editable: boolean;
  exposure: ExposureOut | undefined;
  onChange: (next: SystemMap) => void;
}) {
  const ids = useId();
  const name = (id: string) => map.nodes.find((n) => n.id === id)?.label ?? id;
  const flows = map.flows.filter((f) => f.source === node.id || f.target === node.id);
  const patch = (fields: Parameters<typeof updateNode>[2]) => onChange(updateNode(map, node.id, fields));

  return (
    <>
      {editable ? (
        <div className="inspector-form">
          <div className="field">
            <label className="field-label" htmlFor={`${ids}-label`}>
              Name
            </label>
            <input id={`${ids}-label`} className="input" value={node.label} maxLength={80} onChange={(e) => patch({ label: e.target.value })} />
          </div>
          <div className="field">
            <label className="field-label" htmlFor={`${ids}-tech`}>
              Technology
            </label>
            <input
              id={`${ids}-tech`}
              className="input"
              value={node.tech ?? ""}
              placeholder="Such as Postgres or FastAPI"
              maxLength={80}
              onChange={(e) => patch({ tech: e.target.value.trim() === "" ? null : e.target.value })}
            />
          </div>
          <div className="inspector-row">
            <div className="field">
              <label className="field-label" htmlFor={`${ids}-kind`}>
                Kind
              </label>
              <select id={`${ids}-kind`} className="select" value={node.kind} onChange={(e) => patch({ kind: e.target.value as ElementKind })}>
                {KINDS.map((kind) => (
                  <option key={kind.value} value={kind.value}>
                    {kind.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label className="field-label" htmlFor={`${ids}-zone`}>
                Trust boundary
              </label>
              <select
                id={`${ids}-zone`}
                className="select"
                value={node.boundary ?? ""}
                onChange={(e) => patch({ boundary: e.target.value === "" ? null : e.target.value })}
              >
                <option value="">Outside every boundary</option>
                {map.boundaries.map((boundary) => (
                  <option key={boundary.id} value={boundary.id}>
                    {boundary.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="inspector-toggles">
            <label className="toggle">
              <input type="checkbox" checked={node.ai} onChange={(e) => patch({ ai: e.target.checked })} />
              <span>Is or calls an AI model</span>
            </label>
            <label className="toggle">
              <input type="checkbox" checked={node.sensitive} onChange={(e) => patch({ sensitive: e.target.checked })} />
              <span>Holds sensitive data</span>
            </label>
          </div>
        </div>
      ) : (
        <div className="inspector-summary">
          <h2 className="hand inspector-title">{node.label}</h2>
          {node.tech && <p className="mono inspector-tech">{node.tech}</p>}
          <p className="inspector-flags">
            {node.ai && <span className="chip chip-ai">AI</span>}
            {node.sensitive && <span className="chip chip-sensitive">sensitive data</span>}
            <span className="chip">
              {node.boundary ? map.boundaries.find((b) => b.id === node.boundary)?.label ?? node.boundary : "outside every boundary"}
            </span>
          </p>
        </div>
      )}

      <Evidence text={node.evidence} />

      {exposure && (
        <section className="inspector-section">
          <h3 className="inspector-label">{exposure.lethal ? "Lethal trifecta" : "What this AI part touches"}</h3>
          <dl className="inspector-exposure">
            <dt>Reads sensitive data from</dt>
            <dd>{exposure.private_data.length ? exposure.private_data.map(name).join(", ") : "nothing"}</dd>
            <dt>Takes untrusted input from</dt>
            <dd>{exposure.untrusted.length ? exposure.untrusted.map(name).join(", ") : "nothing"}</dd>
            <dt>Can send data out to</dt>
            <dd>{exposure.outbound.length ? exposure.outbound.map(name).join(", ") : "nothing"}</dd>
          </dl>
        </section>
      )}

      {flows.length > 0 && (
        <section className="inspector-section">
          <h3 className="inspector-label">Flows</h3>
          <ul className="inspector-flows">
            {flows.map((f) => (
              <li key={f.id}>
                <button type="button" className="inspector-link" onClick={() => useBoardUi.getState().select(f.id)}>
                  {f.source === node.id ? "to" : "from"} {name(f.source === node.id ? f.target : f.source)}: {f.label}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

function FlowDetails({ map, flow, editable, onChange }: { map: SystemMap; flow: Flow; editable: boolean; onChange: (next: SystemMap) => void }) {
  const ids = useId();
  const patch = (fields: Parameters<typeof updateFlow>[2]) => onChange(updateFlow(map, flow.id, fields));
  const name = (id: string) => map.nodes.find((n) => n.id === id)?.label ?? id;
  return (
    <>
      <p className="inspector-route">
        <button type="button" className="inspector-link" onClick={() => useBoardUi.getState().select(flow.source)}>
          {name(flow.source)}
        </button>
        <span aria-hidden="true"> to </span>
        <button type="button" className="inspector-link" onClick={() => useBoardUi.getState().select(flow.target)}>
          {name(flow.target)}
        </button>
      </p>
      {editable ? (
        <div className="inspector-form">
          <div className="field">
            <label className="field-label" htmlFor={`${ids}-label`}>
              Label
            </label>
            <input id={`${ids}-label`} className="input" value={flow.label} maxLength={80} onChange={(e) => patch({ label: e.target.value })} />
          </div>
          <div className="field">
            <label className="field-label" htmlFor={`${ids}-data`}>
              What it carries
            </label>
            <input
              id={`${ids}-data`}
              className="input"
              value={flow.data ?? ""}
              maxLength={200}
              onChange={(e) => patch({ data: e.target.value.trim() === "" ? null : e.target.value })}
            />
          </div>
        </div>
      ) : (
        <div className="inspector-summary">
          <h2 className="hand inspector-title">{flow.label}</h2>
          {flow.data && <p className="inspector-data">Carries {flow.data}</p>}
          <p className="visually-hidden">{flowLabel(map, flow)}</p>
        </div>
      )}
      <Evidence text={flow.evidence} />
    </>
  );
}

function Evidence({ text }: { text: string | null }) {
  if (!text) return null;
  const inferred = isInferred(text);
  return (
    <section className="inspector-section">
      <h3 className="inspector-label">{inferred ? "Inferred, not quoted" : "Evidence"}</h3>
      <blockquote className={`inspector-evidence ${inferred ? "is-inferred" : ""}`}>
        {inferred ? text.slice("inferred:".length).trim() : text}
      </blockquote>
    </section>
  );
}

function DeleteButton({ label, extra, onDelete }: { label: string; extra: number; onDelete: () => void }) {
  return (
    <button type="button" className="btn btn-sm btn-danger inspector-delete" onClick={onDelete}>
      <TrashIcon width={15} height={15} /> Delete {label}
      {extra > 0 && ` and its ${extra} flow${extra === 1 ? "" : "s"}`}
    </button>
  );
}
