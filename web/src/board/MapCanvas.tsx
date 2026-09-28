import { memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";

import type { ExposureOut, Flow, MapNode, SystemMap, Threat } from "../api/types.ts";
import { FitIcon, FlowDirectionIcon, PinIcon, ZoomInIcon, ZoomOutIcon } from "../shell/icons.tsx";
import { isInferred } from "./elements.ts";
import { STRIDE } from "./severity.ts";
import {
  clip,
  FLOW_LABEL_MAX,
  LINE_HEIGHT,
  nodeText,
  pickDirection,
  roundedPath,
  trimEnd,
  type Box,
  type Direction,
  type MapLayout,
  type MapLayouts,
} from "./layout.ts";
import type { MapDiff } from "./mapDiff.ts";
import { MapLegend } from "./MapLegend.tsx";
import { pinBox, pinState, placePins, type LitState, type Pin } from "./pins.ts";
import { boundaryOutline, LID, nodeFill, nodeOutline, personGlyph } from "./shapes.ts";
import { PinMark } from "./PinMark.tsx";
import { useBoardUi } from "./store.ts";
import "./MapCanvas.css";

// =============================================================================
// Module Overview
// =============================================================================
// The whiteboard itself: trust boundaries, nodes and flows drawn as SVG from
// the `MapLayouts`, top to bottom or left to right, whichever shows larger in
// the canvas, with threat pins, lethal trifecta rings, crossing flows and
// highlights on top. The view pans and zooms by pointer, wheel and keyboard, and
// every element is focusable and selects on Enter, so the map works without a mouse.
// `MapScene` draws the map itself, so an export draws the very same shapes.

interface View {
  x: number;
  y: number;
  k: number;
}

const MIN_ZOOM = 0.2;
// Below this scale node labels drop under about 9px; the opening view stops here and centers
// on what matters instead of shrinking a large map into an unreadable strip. Above it, seeing
// the whole map at once is worth a slightly smaller hand.
const READABLE_ZOOM = 0.45;
const MAX_ZOOM = 2.4;
const FIT_PAD = 36;
const PAN_STEP = 60;
const DRAG_THRESHOLD = 4;
// Space between the first line of a node's name and its tech line.
const TECH_GAP = 20;
// How far a crossing flow's 16px arrowhead reaches back from the tip; its hollow middle stops there.
const ARROW_LENGTH = 14;

const KIND_WORD: Record<MapNode["kind"], string> = { external: "external entity", process: "process", store: "data store" };

/** Everything the canvas draws. */
export interface MapCanvasProps {
  map: SystemMap;
  layouts: MapLayouts;
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
export function MapCanvas({ map, layouts, threats, exposure, crossings, diff, lit, draft, focus }: MapCanvasProps) {
  const container = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>({ x: 0, y: 0, k: 1 });
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [direction, setDirection] = useState<Direction | null>(null);
  const [pinsShown, setPinsShown] = useState(true);
  const moved = useRef(false);
  const drag = useRef<{ id: number; startX: number; startY: number; view: View; dragging: boolean } | null>(null);
  const selected = useBoardUi((s) => s.selected);
  const select = useBoardUi((s) => s.select);
  const openThreat = useBoardUi((s) => s.openThreat);
  const showDirection = useBoardUi((s) => s.showDirection);
  const hintId = useId();
  const layout = layouts[direction ?? "DOWN"];

  useEffect(() => showDirection(direction), [direction, showDirection]);

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

  // Each new canvas size picks the direction that shows the map largest, as opening or closing
  // the side panel reshapes it, until the reader pans, zooms or turns the map themselves. A new
  // map keeps the direction, so an update from a coding agent never flips the board around.
  // Layout effects run this and the fit below before the browser paints, so no frame shows the
  // map unfitted at full size.
  const pickedFor = useRef<{ width: number; height: number } | null>(null);
  const turned = useRef(false);
  useLayoutEffect(() => {
    if (size.width === 0 || size.height === 0) return;
    const resized = pickedFor.current?.width !== size.width || pickedFor.current?.height !== size.height;
    if (!resized || turned.current || (direction !== null && moved.current)) return;
    pickedFor.current = size;
    setDirection(pickDirection(layouts, size.width - FIT_PAD * 2, size.height - FIT_PAD * 2));
  }, [direction, layouts, size]);

  const openingView = useCallback((): View | null => {
    const fitted = fitView();
    if (fitted === null || fitted.k >= READABLE_ZOOM) return fitted;
    const box = (focus && (layout.nodes[focus] ?? layout.edges[focus]?.label)) || null;
    const cx = box ? box.x + box.width / 2 : layout.width / 2;
    const cy = box ? box.y + box.height / 2 : layout.height / 2;
    const k = READABLE_ZOOM;
    return { k, x: size.width / 2 - cx * k, y: size.height / 2 - cy * k };
  }, [fitView, focus, layout, size]);

  // Reset the view on a new structure, a new direction or a resize, unless the user has already moved it themselves.
  // Structure means which parts and flows exist and where they sit, so renaming a part keeps the user's view.
  const structure = useMemo(
    () =>
      JSON.stringify([
        map.boundaries.map((b) => b.id),
        map.nodes.map((n) => [n.id, n.boundary]),
        map.flows.map((f) => [f.id, f.source, f.target]),
      ]),
    [map],
  );
  const fittedKey = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (direction === null) return;
    if (fittedKey.current !== structure || !moved.current) {
      const next = openingView();
      if (next) {
        setView(next);
        fittedKey.current = structure;
        moved.current = false;
      }
    }
  }, [direction, structure, openingView]);

  const turn = () => {
    turned.current = true;
    moved.current = false;
    setDirection((was) => (was === "RIGHT" ? "DOWN" : "RIGHT"));
  };

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
    if (event.button !== 0 || (event.target as Element).closest(".canvas-controls, .map-legend")) return;
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

  const activate = useCallback(
    (id: string) => {
      select(selected === id ? null : id);
    },
    [select, selected],
  );

  const turnLabel = direction === "RIGHT" ? "Lay out top to bottom" : "Lay out left to right";

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
        if ((event.target as Element).closest("[data-el], .canvas-controls, .map-legend") === null) select(null);
      }}
    >
      <p id={hintId} className="visually-hidden">
        Tab moves between elements; Enter selects one. Arrow keys pan, plus and minus zoom, zero fits the map.
      </p>
      <svg className="canvas-svg" width="100%" height="100%">
        <ArrowMarkers />
        {/* Nothing is drawn until the first measure picks a direction, so the map never flashes the other way round. */}
        {direction !== null && (
          <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
            <MapScene
              map={map}
              layout={layout}
              threats={threats}
              exposure={exposure}
              crossings={crossings}
              diff={diff}
              draft={draft}
              pinsShown={pinsShown}
              selected={selected}
              lit={lit}
              onActivate={activate}
              onReveal={reveal}
              onOpenThreat={openThreat}
            />
          </g>
        )}
      </svg>

      {draft && (
        <p className="canvas-stamp hand" aria-hidden="true">
          draft
        </p>
      )}

      <div className="canvas-controls" role="toolbar" aria-label="Map view">
        <button type="button" className="btn btn-icon" aria-label="Zoom in" title="Zoom in" onClick={() => zoomAt(1.25, size.width / 2, size.height / 2)}>
          <ZoomInIcon />
        </button>
        <button type="button" className="btn btn-icon" aria-label="Zoom out" title="Zoom out" onClick={() => zoomAt(0.8, size.width / 2, size.height / 2)}>
          <ZoomOutIcon />
        </button>
        <button type="button" className="btn btn-icon" aria-label="Fit map to screen" title="Fit map to screen" onClick={fit}>
          <FitIcon />
        </button>
        <button type="button" className="btn btn-icon" aria-label={turnLabel} title={turnLabel} onClick={turn}>
          <FlowDirectionIcon className={direction === "RIGHT" ? "icon-upright" : undefined} />
        </button>
        {threats.length > 0 && (
          <button
            type="button"
            className="btn btn-icon"
            aria-label="Show threat pins"
            title="Show threat pins"
            aria-pressed={pinsShown}
            onClick={() => setPinsShown((shown) => !shown)}
          >
            <PinIcon />
          </button>
        )}
        <span className="canvas-zoom mono" aria-live="off">
          {Math.round(view.k * 100)}%
        </span>
      </div>
      <MapLegend draft={draft} />
    </div>
  );
}

// =============================================================================
// Scene
// =============================================================================

/** Ids for the arrowhead markers under `prefix`, so two drawings on one page never share one. */
function markerIds(prefix: string) {
  return { plain: `${prefix}arrow`, crossing: `${prefix}arrow-cross`, selected: `${prefix}arrow-selected` };
}

/** The arrowheads every flow ends in; a drawing that sits beside the canvas passes its own `prefix`. */
export function ArrowMarkers({ prefix = "" }: { prefix?: string }) {
  const ids = markerIds(prefix);
  return (
    <defs>
      {/* Sized in canvas units, not stroke widths: a head scaled by a crossing flow's thick line grows wider than the gap between lanes. */}
      <marker id={ids.plain} viewBox="0 0 10 10" refX="9" refY="5" markerUnits="userSpaceOnUse" markerWidth="12" markerHeight="12" orient="auto-start-reverse">
        <path d="M0,1 L9,5 L0,9 Q2,5 0,1 Z" className="arrow-head" />
      </marker>
      <marker id={ids.crossing} viewBox="0 0 10 10" refX="9" refY="5" markerUnits="userSpaceOnUse" markerWidth="16" markerHeight="16" orient="auto-start-reverse">
        <path d="M0,1 L9,5 L0,9 Q2,5 0,1 Z" className="arrow-head is-crossing" />
      </marker>
      <marker id={ids.selected} viewBox="0 0 10 10" refX="9" refY="5" markerUnits="userSpaceOnUse" markerWidth="16" markerHeight="16" orient="auto-start-reverse">
        <path d="M0,1 L9,5 L0,9 Q2,5 0,1 Z" className="arrow-head is-selected" />
      </marker>
    </defs>
  );
}

/** What `MapScene` draws, and on the live canvas how a reader points at it; a still picture leaves the pointing out. */
export interface MapSceneProps {
  map: SystemMap;
  layout: MapLayout;
  threats: readonly Threat[];
  exposure: readonly ExposureOut[];
  crossings: readonly string[];
  diff: MapDiff | null;
  draft: boolean;
  pinsShown: boolean;
  /** The prefix given to `ArrowMarkers` in the same SVG. */
  markers?: string;
  selected?: string | null;
  lit?: ReadonlySet<string> | null;
  onActivate?: (id: string) => void;
  onReveal?: (box: Box) => void;
  onOpenThreat?: (id: string) => void;
}

const ignore = () => undefined;

/** Every mark on the map in canvas coordinates: boundaries, flows, boundary names, nodes, then pins, so names and pins sit over lines. */
export const MapScene = memo(function MapScene({
  map,
  layout,
  threats,
  exposure,
  crossings,
  diff,
  draft,
  pinsShown,
  markers = "",
  selected = null,
  lit = null,
  onActivate = ignore,
  onReveal = ignore,
  onOpenThreat = ignore,
}: MapSceneProps) {
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
  const ids = markerIds(markers);

  const litState = (id: string): LitState => (lit === null ? "" : lit.has(id) ? "lit" : "dim");

  return (
    <>
      {map.boundaries.map((boundary) => {
        const box = layout.boundaries[boundary.id];
        return box ? <BoundaryShape key={boundary.id} id={boundary.id} box={box} /> : null;
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
            inferred={draft && isInferred(flow.evidence)}
            selected={selected === flow.id}
            state={litState(flow.id)}
            diffTag={added.has(flow.id) ? "new" : changed.has(flow.id) ? "edited" : null}
            threatCount={threatsOn.get(flow.id) ?? 0}
            marker={selected === flow.id ? ids.selected : crossingSet.has(flow.id) ? ids.crossing : ids.plain}
            onActivate={onActivate}
            onReveal={onReveal}
          />
        );
      })}

      {/* Boundary names sit over the lines, so a flow that must cross one never strikes through it. */}
      {map.boundaries.map((boundary) => {
        const spot = layout.boundaryLabels[boundary.id];
        return spot ? <BoundaryName key={boundary.id} label={boundary.label} spot={spot} /> : null;
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
            inferred={draft && isInferred(node.evidence)}
            selected={selected === node.id}
            state={litState(node.id)}
            diffTag={added.has(node.id) ? "new" : changed.has(node.id) ? "edited" : null}
            threatCount={threatsOn.get(node.id) ?? 0}
            onActivate={onActivate}
            onReveal={onReveal}
          />
        );
      })}

      {pinsShown &&
        pins.map((pin) => (
          <PinButton
            key={pin.threat.id}
            pin={pin}
            state={pinState(pin.threat, lit)}
            onOpen={() => onOpenThreat(pin.threat.id)}
            onReveal={onReveal}
          />
        ))}
    </>
  );
});

// =============================================================================
// Shapes
// =============================================================================

const BoundaryShape = memo(function BoundaryShape({ id, box }: { id: string; box: Box }) {
  const strokes = useMemo(() => boundaryOutline(box, id), [box, id]);
  return (
    <g className="boundary">
      <rect x={box.x} y={box.y} width={box.width} height={box.height} rx={18} className="boundary-fill" />
      {strokes.map((d, i) => (
        <path key={i} d={d} className="boundary-stroke" />
      ))}
    </g>
  );
});

function BoundaryName({ label, spot }: { label: string; spot: Box }) {
  return (
    <g className="boundary-name">
      <text x={spot.x} y={spot.y + 18} className="boundary-label">
        {label}
      </text>
      <text x={spot.x} y={spot.y + 30} className="boundary-kind">
        trust boundary
      </text>
    </g>
  );
}

interface NodeShapeProps {
  node: MapNode;
  box: Box;
  lethal: boolean;
  inferred: boolean;
  selected: boolean;
  state: LitState;
  diffTag: "new" | "edited" | null;
  threatCount: number;
  onActivate: (id: string) => void;
  onReveal: (box: Box) => void;
}

const NodeShape = memo(function NodeShape({ node, box, lethal, inferred, selected, state, diffTag, threatCount, onActivate, onReveal }: NodeShapeProps) {
  const fill = useMemo(() => nodeFill(node.kind, box), [node.kind, box]);
  const strokes = useMemo(() => nodeOutline(node.kind, box, node.id), [node.kind, box, node.id]);
  const text = useMemo(() => nodeText(node), [node]);
  const external = node.kind === "external";
  const textX = box.x + box.width / 2 + (external ? 10 : 0);
  const midY = box.y + box.height / 2 + (node.kind === "store" ? LID / 2 : 0);
  // Center the name and tech as one block; Caveat sits high in its line, so the block drops 3px with a tech line under it.
  const block = (text.label.length - 1) * LINE_HEIGHT + (text.tech ? TECH_GAP : 0);
  const firstY = midY - block / 2 + (text.tech ? 3 : 0);
  const cut = text.label.join(" ") !== node.label || (node.tech !== null && text.tech !== node.tech);
  const tags = [node.ai ? "AI" : null, node.sensitive ? "sensitive" : null].filter((tag): tag is string => tag !== null);

  const describe = [
    node.label,
    KIND_WORD[node.kind],
    node.tech,
    node.ai ? "uses AI" : null,
    node.sensitive ? "holds sensitive data" : null,
    lethal ? "has the lethal trifecta" : null,
    inferred ? "inferred, check it" : null,
    threatCount > 0 ? `${threatCount} threat${threatCount === 1 ? "" : "s"}` : null,
    diffTag === "new" ? "new in this update" : diffTag === "edited" ? "changed in this update" : null,
  ]
    .filter(Boolean)
    .join(", ");

  return (
    <g
      className={`map-node kind-${node.kind} ${selected ? "is-selected" : ""} ${state ? `is-${state}` : ""} ${diffTag ? `diff-${diffTag}` : ""} ${inferred ? "is-inferred" : ""}`}
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
      {cut && <title>{node.tech ? `${node.label} (${node.tech})` : node.label}</title>}
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
      {text.label.map((line, i) => (
        <text key={i} x={textX} y={firstY + i * LINE_HEIGHT} className="node-label">
          {line}
        </text>
      ))}
      {text.tech && (
        <text x={textX} y={firstY + (text.label.length - 1) * LINE_HEIGHT + TECH_GAP} className="node-tech">
          {text.tech}
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
  inferred: boolean;
  selected: boolean;
  state: LitState;
  diffTag: "new" | "edited" | null;
  threatCount: number;
  /** The id of the arrowhead marker to end the line in. */
  marker: string;
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
  inferred,
  selected,
  state,
  diffTag,
  threatCount,
  marker,
  onActivate,
  onReveal,
}: FlowShapeProps) {
  const d = useMemo(() => roundedPath(points, 12), [points]);
  const inner = useMemo(() => (crossing ? roundedPath(trimEnd(points, ARROW_LENGTH), 12) : null), [crossing, points]);
  const text = clip(flow.label, FLOW_LABEL_MAX);
  const describe = [
    `Flow from ${sourceLabel} to ${targetLabel}: ${flow.label}`,
    flow.data ? `carries ${flow.data}` : null,
    crossing ? "crosses a trust boundary" : null,
    inferred ? "inferred, check it" : null,
    threatCount > 0 ? `${threatCount} threat${threatCount === 1 ? "" : "s"}` : null,
    diffTag === "new" ? "new in this update" : diffTag === "edited" ? "changed in this update" : null,
  ]
    .filter(Boolean)
    .join(", ");
  const box = label ?? { x: points[0]!.x, y: points[0]!.y, width: 1, height: 1 };

  return (
    <g
      className={`map-flow ${crossing ? "is-crossing" : ""} ${selected ? "is-selected" : ""} ${state ? `is-${state}` : ""} ${diffTag ? `diff-${diffTag}` : ""} ${inferred ? "is-inferred" : ""}`}
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
      {text !== flow.label && <title>{flow.label}</title>}
      <path d={d} className="flow-hit" />
      {state === "lit" && <path d={d} className="flow-highlighter" />}
      <path d={d} className="flow-line" markerEnd={`url(#${marker})`} />
      {inner && <path d={inner} className="flow-inner" />}
      {label && (
        <g className="flow-chip">
          <rect x={label.x} y={label.y} width={label.width} height={label.height} rx={6} />
          <text x={label.x + label.width / 2} y={label.y + label.height / 2 + 1}>
            {text}
          </text>
          {diffTag && (
            // On the chip's top edge like a legend, so the tag never lands on a neighboring label.
            <text x={label.x + label.width / 2} y={label.y + 3.5} className={`flow-diff diff-tag-${diffTag}`}>
              {diffTag}
            </text>
          )}
        </g>
      )}
    </g>
  );
});

function PinButton({ pin, state, onOpen, onReveal }: { pin: Pin; state: LitState; onOpen: () => void; onReveal: (box: Box) => void }) {
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
      onFocus={() => onReveal(pinBox(pin))}
    >
      <title>{`${threat.id} ${threat.title} (${threat.severity})`}</title>
      <PinMark severity={threat.severity} label={pin.number} />
    </g>
  );
}
