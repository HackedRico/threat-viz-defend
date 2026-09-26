import { memo, useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";

import type { ExposureOut, Flow, MapNode, SystemMap, Threat } from "../api/types.ts";
import { FitIcon, ZoomInIcon, ZoomOutIcon } from "../shell/icons.tsx";
import { STRIDE } from "./severity.ts";
import { clip, roundedPath, TECH_MAX, trimEnd, type Box, type MapLayout } from "./layout.ts";
import type { MapDiff } from "./mapDiff.ts";
import { placePins, type Pin } from "./pins.ts";
import { boundaryOutline, LID, nodeFill, nodeOutline, personGlyph } from "./shapes.ts";
import { PinMark } from "./PinMark.tsx";
import { useBoardUi } from "./store.ts";
import "./MapCanvas.css";

// =============================================================================
// Module Overview
// =============================================================================
// The whiteboard itself: trust boundaries, nodes and flows drawn as SVG from a
// `MapLayout`, with threat pins, lethal trifecta rings, crossing flows and
// highlights on top. The view pans and zooms by pointer, wheel and keyboard;
// every element is focusable and selects on Enter, so the map works without a
// mouse.

interface View {
  x: number;
  y: number;
  k: number;
}

const MIN_ZOOM = 0.2;
// Below this scale node labels drop under about 11px; the opening view stops here and centers
// on what matters instead of shrinking a wide map into an unreadable strip.
const READABLE_ZOOM = 0.55;
const MAX_ZOOM = 2.4;
const FIT_PAD = 36;
const PAN_STEP = 60;
const DRAG_THRESHOLD = 4;

const KIND_WORD: Record<MapNode["kind"], string> = { external: "external entity", process: "process", store: "data store" };

/** Everything the canvas draws. */
export interface MapCanvasProps {
  map: SystemMap;
  layout: MapLayout;
  layoutKey: string;
  threats: readonly Threat[];
  exposure: readonly ExposureOut[];
  crossings: readonly string[];
  diff: MapDiff | null;
  lit: ReadonlySet<string> | null;
  draft: boolean;
  /** The element to center on when the whole map cannot fit at a readable size. */
  focus: string | null;
}

function clampZoom(k: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, k));
}

/** The map canvas with pan, zoom, selection and highlights. */
export function MapCanvas({ map, layout, layoutKey, threats, exposure, crossings, diff, lit, draft, focus }: MapCanvasProps) {
  const container = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>({ x: 0, y: 0, k: 1 });
  const [size, setSize] = useState({ width: 0, height: 0 });
  const moved = useRef(false);
  const drag = useRef<{ id: number; startX: number; startY: number; view: View; dragging: boolean } | null>(null);
  const selected = useBoardUi((s) => s.selected);
  const select = useBoardUi((s) => s.select);
  const showThreat = useBoardUi((s) => s.showThreat);
  const hintId = useId();

  // ---------- fitting and resizing ----------

  const fitView = useCallback((): View | null => {
    if (size.width === 0 || size.height === 0 || layout.width === 0) return null;
    const k = clampZoom(
      Math.min((size.width - FIT_PAD * 2) / layout.width, (size.height - FIT_PAD * 2) / layout.height, 1.25),
    );
    return { k, x: (size.width - layout.width * k) / 2, y: (size.height - layout.height * k) / 2 };
  }, [size, layout.width, layout.height]);

  const fit = useCallback(() => {
    const next = fitView();
    if (next) setView(next);
    moved.current = false;
  }, [fitView]);

  useEffect(() => {
    const element = container.current;
    if (!element) return undefined;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const openingView = useCallback((): View | null => {
    const fitted = fitView();
    if (fitted === null || fitted.k >= READABLE_ZOOM) return fitted;
    const box = (focus && (layout.nodes[focus] ?? layout.edges[focus]?.label)) || null;
    const cx = box ? box.x + box.width / 2 : layout.width / 2;
    const cy = box ? box.y + box.height / 2 : layout.height / 2;
    const k = READABLE_ZOOM;
    return { k, x: size.width / 2 - cx * k, y: size.height / 2 - cy * k };
  }, [fitView, focus, layout, size]);

  // Reset the view on a new structure or a resize, unless the user has already moved it themselves.
  const fittedKey = useRef<string | null>(null);
  useEffect(() => {
    if (fittedKey.current !== layoutKey || !moved.current) {
      const next = openingView();
      if (next) {
        setView(next);
        fittedKey.current = layoutKey;
        moved.current = false;
      }
    }
  }, [layoutKey, openingView]);

  // ---------- zoom and pan ----------

  const zoomAt = useCallback((factor: number, cx: number, cy: number) => {
    moved.current = true;
    setView((v) => {
      const k = clampZoom(v.k * factor);
      return { k, x: cx - ((cx - v.x) * k) / v.k, y: cy - ((cy - v.y) * k) / v.k };
    });
  }, []);

  const panBy = useCallback((dx: number, dy: number) => {
    moved.current = true;
    setView((v) => ({ ...v, x: v.x + dx, y: v.y + dy }));
  }, []);

  useEffect(() => {
    const element = container.current;
    if (!element) return undefined;
    // React registers wheel listeners as passive, so preventDefault needs a native listener.
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = element.getBoundingClientRect();
      if (event.ctrlKey || event.metaKey) {
        zoomAt(Math.exp(-event.deltaY * 0.0022), event.clientX - rect.left, event.clientY - rect.top);
      } else {
        panBy(-event.deltaX, -event.deltaY);
      }
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, [zoomAt, panBy]);

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || (event.target as Element).closest(".canvas-controls")) return;
    drag.current = { id: event.pointerId, startX: event.clientX, startY: event.clientY, view, dragging: false };
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const state = drag.current;
    if (!state || state.id !== event.pointerId) return;
    const dx = event.clientX - state.startX;
    const dy = event.clientY - state.startY;
    if (!state.dragging && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    if (!state.dragging) {
      state.dragging = true;
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    moved.current = true;
    setView({ ...state.view, x: state.view.x + dx, y: state.view.y + dy });
  };

  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    const state = drag.current;
    drag.current = null;
    if (!state || state.id !== event.pointerId) return;
    if (state.dragging) {
      // Swallow the click that follows a drag so panning never selects what it ends on.
      const swallow = (click: MouseEvent) => {
        click.stopPropagation();
        click.preventDefault();
      };
      window.addEventListener("click", swallow, { capture: true, once: true });
      window.setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 0);
    }
  };

  const center = () => ({ x: size.width / 2, y: size.height / 2 });

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const onElement = (event.target as Element).closest("[data-el]") !== null;
    if (onElement && (event.key === "Enter" || event.key === " ")) return;
    const c = center();
    const keys: Record<string, () => void> = {
      ArrowLeft: () => panBy(PAN_STEP, 0),
      ArrowRight: () => panBy(-PAN_STEP, 0),
      ArrowUp: () => panBy(0, PAN_STEP),
      ArrowDown: () => panBy(0, -PAN_STEP),
      "+": () => zoomAt(1.2, c.x, c.y),
      "=": () => zoomAt(1.2, c.x, c.y),
      "-": () => zoomAt(1 / 1.2, c.x, c.y),
      "0": fit,
      Escape: () => select(null),
    };
    const action = keys[event.key];
    if (action && !event.metaKey && !event.ctrlKey && !event.altKey) {
      event.preventDefault();
      action();
    }
  };

  // Keep a keyboard-focused element on screen: tabbing should never move focus somewhere invisible.
  const reveal = useCallback(
    (box: Box) => {
      setView((v) => {
        const left = v.x + box.x * v.k;
        const top = v.y + box.y * v.k;
        const right = left + box.width * v.k;
        const bottom = top + box.height * v.k;
        const margin = 40;
        let { x, y } = v;
        if (left < margin) x += margin - left;
        else if (right > size.width - margin) x -= right - (size.width - margin);
        if (top < margin) y += margin - top;
        else if (bottom > size.height - margin) y -= bottom - (size.height - margin);
        return x === v.x && y === v.y ? v : { ...v, x, y };
      });
    },
    [size],
  );

  // ---------- derived drawing data ----------

  const crossingSet = useMemo(() => new Set(crossings), [crossings]);
  const lethal = useMemo(() => new Set(exposure.filter((x) => x.lethal).map((x) => x.node)), [exposure]);
  const threatsOn = useMemo(() => {
    const counts = new Map<string, number>();
    threats.forEach((t) => counts.set(t.element, (counts.get(t.element) ?? 0) + 1));
    return counts;
  }, [threats]);
  const pins = useMemo(() => placePins(threats, layout), [threats, layout]);
  const added = useMemo(() => new Set(diff?.added ?? []), [diff]);
  const changed = useMemo(() => new Set(diff?.changed ?? []), [diff]);
  const nodeLabels = useMemo(() => new Map(map.nodes.map((n) => [n.id, n.label])), [map.nodes]);

  const activate = useCallback(
    (id: string) => {
      select(selected === id ? null : id);
    },
    [select, selected],
  );

  const litState = (id: string): "lit" | "dim" | "" => (lit === null ? "" : lit.has(id) ? "lit" : "dim");

  return (
    <div
      ref={container}
      className={`canvas ${draft ? "is-draft" : ""} ${lit ? "has-highlight" : ""}`}
      role="group"
      aria-label={`Map of ${map.name}`}
      aria-describedby={hintId}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => (drag.current = null)}
      onKeyDown={onKeyDown}
      onClick={(event) => {
        if ((event.target as Element).closest("[data-el], .canvas-controls") === null) select(null);
      }}
    >
      <p id={hintId} className="visually-hidden">
        Tab moves between elements; Enter selects one. Arrow keys pan, plus and minus zoom, zero fits the map.
      </p>
      <svg className="canvas-svg" width="100%" height="100%">
        <defs>
          <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0,1 L9,5 L0,9 Q2,5 0,1 Z" className="arrow-head" />
          </marker>
          <marker id="arrow-cross" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0,1 L9,5 L0,9 Q2,5 0,1 Z" className="arrow-head is-crossing" />
          </marker>
          <marker id="arrow-selected" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0,1 L9,5 L0,9 Q2,5 0,1 Z" className="arrow-head is-selected" />
          </marker>
        </defs>
        <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
          {map.boundaries.map((boundary) => {
            const box = layout.boundaries[boundary.id];
            return box ? <BoundaryShape key={boundary.id} id={boundary.id} label={boundary.label} box={box} /> : null;
          })}

          {map.flows.map((flow) => {
            const route = layout.edges[flow.id];
            if (!route || route.points.length < 2) return null;
            return (
              <FlowShape
                key={flow.id}
                flow={flow}
                points={route.points}
                label={route.label}
                sourceLabel={nodeLabels.get(flow.source) ?? flow.source}
                targetLabel={nodeLabels.get(flow.target) ?? flow.target}
                crossing={crossingSet.has(flow.id)}
                selected={selected === flow.id}
                state={litState(flow.id)}
                diffTag={added.has(flow.id) ? "new" : changed.has(flow.id) ? "edited" : null}
                threatCount={threatsOn.get(flow.id) ?? 0}
                onActivate={activate}
                onReveal={reveal}
              />
            );
          })}

          {map.nodes.map((node) => {
            const box = layout.nodes[node.id];
            if (!box) return null;
            return (
              <NodeShape
                key={node.id}
                node={node}
                box={box}
                lethal={lethal.has(node.id)}
                selected={selected === node.id}
                state={litState(node.id)}
                diffTag={added.has(node.id) ? "new" : changed.has(node.id) ? "edited" : null}
                threatCount={threatsOn.get(node.id) ?? 0}
                onActivate={activate}
                onReveal={reveal}
              />
            );
          })}

          {pins.map((pin) => (
            <PinButton
              key={pin.threat.id}
              pin={pin}
              state={litState(pin.threat.id) || litState(pin.threat.element)}
              onOpen={() => {
                showThreat(pin.threat.id);
                select(pin.threat.element);
              }}
            />
          ))}
        </g>
      </svg>

      {draft && (
        <p className="canvas-stamp hand" aria-hidden="true">
          draft
        </p>
      )}

      <div className="canvas-controls" role="toolbar" aria-label="Map view">
        <button type="button" className="btn btn-icon" aria-label="Zoom in" onClick={() => zoomAt(1.25, size.width / 2, size.height / 2)}>
          <ZoomInIcon />
        </button>
        <button type="button" className="btn btn-icon" aria-label="Zoom out" onClick={() => zoomAt(0.8, size.width / 2, size.height / 2)}>
          <ZoomOutIcon />
        </button>
        <button type="button" className="btn btn-icon" aria-label="Fit map to screen" onClick={fit}>
          <FitIcon />
        </button>
        <span className="canvas-zoom mono" aria-live="off">
          {Math.round(view.k * 100)}%
        </span>
      </div>
    </div>
  );
}

// =============================================================================
// Shapes
// =============================================================================

const BoundaryShape = memo(function BoundaryShape({ id, label, box }: { id: string; label: string; box: Box }) {
  const strokes = useMemo(() => boundaryOutline(box, id), [box, id]);
  return (
    <g className="boundary">
      <rect x={box.x} y={box.y} width={box.width} height={box.height} rx={18} className="boundary-fill" />
      {strokes.map((d, i) => (
        <path key={i} d={d} className="boundary-stroke" />
      ))}
      <text x={box.x + 18} y={box.y + 28} className="boundary-label">
        {label}
      </text>
      <text x={box.x + 18} y={box.y + 40} className="boundary-kind">
        trust boundary
      </text>
    </g>
  );
});

type LitState = "lit" | "dim" | "";

interface NodeShapeProps {
  node: MapNode;
  box: Box;
  lethal: boolean;
  selected: boolean;
  state: LitState;
  diffTag: "new" | "edited" | null;
  threatCount: number;
  onActivate: (id: string) => void;
  onReveal: (box: Box) => void;
}

const NodeShape = memo(function NodeShape({ node, box, lethal, selected, state, diffTag, threatCount, onActivate, onReveal }: NodeShapeProps) {
  const fill = useMemo(() => nodeFill(node.kind, box), [node.kind, box]);
  const strokes = useMemo(() => nodeOutline(node.kind, box, node.id), [node.kind, box, node.id]);
  const external = node.kind === "external";
  const textX = box.x + box.width / 2 + (external ? 10 : 0);
  const midY = box.y + box.height / 2 + (node.kind === "store" ? LID / 2 : 0);
  const tech = node.tech ? clip(node.tech, TECH_MAX) : null;
  const tags = [node.ai ? "AI" : null, node.sensitive ? "sensitive" : null].filter((tag): tag is string => tag !== null);

  const describe = [
    node.label,
    KIND_WORD[node.kind],
    node.tech,
    node.ai ? "uses AI" : null,
    node.sensitive ? "holds sensitive data" : null,
    lethal ? "has the lethal trifecta" : null,
    threatCount > 0 ? `${threatCount} threat${threatCount === 1 ? "" : "s"}` : null,
    diffTag === "new" ? "new in this update" : diffTag === "edited" ? "changed in this update" : null,
  ]
    .filter(Boolean)
    .join(", ");

  return (
    <g
      className={`map-node kind-${node.kind} ${selected ? "is-selected" : ""} ${state ? `is-${state}` : ""} ${diffTag ? `diff-${diffTag}` : ""}`}
      data-el={node.id}
      role="button"
      tabIndex={0}
      aria-label={describe}
      aria-pressed={selected}
      onClick={() => onActivate(node.id)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onActivate(node.id);
        }
      }}
      onFocus={() => onReveal(box)}
    >
      {state === "lit" && <path d={fill} className="node-highlighter" />}
      {lethal && (
        <g className="trifecta">
          <rect x={box.x - 9} y={box.y - 9} width={box.width + 18} height={box.height + 18} rx={20} className="trifecta-ring" />
          <text x={box.x + box.width / 2} y={box.y + box.height + 26} className="trifecta-label">
            lethal trifecta
          </text>
        </g>
      )}
      <path d={fill} className="node-fill" />
      {strokes.map((d, i) => (
        <path key={i} d={d} className="node-stroke" />
      ))}
      {external && <path d={personGlyph(box.x + 12, box.y + box.height / 2 - 9)} className="node-glyph" />}
      <text x={textX} y={tech ? midY - 7 : midY} className="node-label">
        {node.label}
      </text>
      {tech && (
        <text x={textX} y={midY + 13} className="node-tech">
          {tech}
        </text>
      )}
      {tags.length > 0 && <NodeTags x={box.x + 8} y={box.y - 9} tags={tags} />}
      {diffTag && (
        <g className={`diff-tag diff-tag-${diffTag}`}>
          <rect x={box.x + box.width - 48} y={box.y + box.height - 8} width={46} height={16} rx={8} />
          <text x={box.x + box.width - 25} y={box.y + box.height + 3.5}>
            {diffTag}
          </text>
        </g>
      )}
      <rect x={box.x - 6} y={box.y - 6} width={box.width + 12} height={box.height + 12} rx={16} className="focus-ring" />
    </g>
  );
});

function NodeTags({ x, y, tags }: { x: number; y: number; tags: string[] }) {
  let cursor = x;
  return (
    <g className="node-tags">
      {tags.map((tag) => {
        const width = tag.length * 6.6 + 12;
        const left = cursor;
        cursor += width + 4;
        return (
          <g key={tag} className={`node-tag tag-${tag === "AI" ? "ai" : "sensitive"}`}>
            <rect x={left} y={y} width={width} height={16} rx={4} />
            <text x={left + width / 2} y={y + 11.5}>
              {tag}
            </text>
          </g>
        );
      })}
    </g>
  );
}

interface FlowShapeProps {
  flow: Flow;
  points: { x: number; y: number }[];
  label: Box | null;
  sourceLabel: string;
  targetLabel: string;
  crossing: boolean;
  selected: boolean;
  state: LitState;
  diffTag: "new" | "edited" | null;
  threatCount: number;
  onActivate: (id: string) => void;
  onReveal: (box: Box) => void;
}

const FlowShape = memo(function FlowShape({
  flow,
  points,
  label,
  sourceLabel,
  targetLabel,
  crossing,
  selected,
  state,
  diffTag,
  threatCount,
  onActivate,
  onReveal,
}: FlowShapeProps) {
  const d = useMemo(() => roundedPath(points, 12), [points]);
  const inner = useMemo(() => (crossing ? roundedPath(trimEnd(points, 9), 12) : null), [crossing, points]);
  const marker = selected ? "url(#arrow-selected)" : crossing ? "url(#arrow-cross)" : "url(#arrow)";
  const text = clip(flow.label, 28);
  const describe = [
    `Flow from ${sourceLabel} to ${targetLabel}: ${flow.label}`,
    flow.data ? `carries ${flow.data}` : null,
    crossing ? "crosses a trust boundary" : null,
    threatCount > 0 ? `${threatCount} threat${threatCount === 1 ? "" : "s"}` : null,
    diffTag === "new" ? "new in this update" : diffTag === "edited" ? "changed in this update" : null,
  ]
    .filter(Boolean)
    .join(", ");
  const box = label ?? { x: points[0]!.x, y: points[0]!.y, width: 1, height: 1 };

  return (
    <g
      className={`map-flow ${crossing ? "is-crossing" : ""} ${selected ? "is-selected" : ""} ${state ? `is-${state}` : ""} ${diffTag ? `diff-${diffTag}` : ""}`}
      data-el={flow.id}
      role="button"
      tabIndex={0}
      aria-label={describe}
      aria-pressed={selected}
      onClick={() => onActivate(flow.id)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onActivate(flow.id);
        }
      }}
      onFocus={() => onReveal(box)}
    >
      <path d={d} className="flow-hit" />
      {state === "lit" && <path d={d} className="flow-highlighter" />}
      <path d={d} className="flow-line" markerEnd={marker} />
      {inner && <path d={inner} className="flow-inner" />}
      {label && (
        <g className="flow-chip">
          <rect x={label.x} y={label.y} width={label.width} height={label.height} rx={6} />
          <text x={label.x + label.width / 2} y={label.y + label.height / 2 + 1}>
            {text}
          </text>
          {diffTag && (
            <text x={label.x + label.width / 2} y={label.y - 4} className={`flow-diff diff-tag-${diffTag}`}>
              {diffTag}
            </text>
          )}
        </g>
      )}
    </g>
  );
});

function PinButton({ pin, state, onOpen }: { pin: Pin; state: LitState; onOpen: () => void }) {
  const { threat } = pin;
  return (
    <g
      className={`pin sev-${threat.severity} ${state ? `is-${state}` : ""}`}
      transform={`translate(${pin.x} ${pin.y})`}
      data-el={threat.id}
      role="button"
      tabIndex={0}
      aria-label={`Threat ${threat.id}, ${threat.severity}, ${STRIDE[threat.stride].name}: ${threat.title}`}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen();
        }
      }}
    >
      <title>{`${threat.id} ${threat.title} (${threat.severity})`}</title>
      <PinMark severity={threat.severity} label={pin.number} />
    </g>
  );
}
