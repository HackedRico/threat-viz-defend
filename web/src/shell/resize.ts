// =============================================================================
// Module Overview
// =============================================================================
// Size math for the draggable edges on the sidebar, the side panel and the ask
// bar. A handle sits on one edge of its pane; dragging away from the pane
// grows it. Left and right edges set a width, top and bottom edges a height.

/** Which edge of its pane a handle sits on. */
export type Edge = "left" | "right" | "top" | "bottom";

/** The sizes a pane may take, in pixels. */
export interface WidthBounds {
  min: number;
  max: number;
}

/** Keep a width inside its bounds, whole pixels only. */
export function clampWidth(width: number, { min, max }: WidthBounds): number {
  return Math.round(Math.min(Math.max(min, max), Math.max(min, width)));
}

/** The size after the pointer moves `delta` pixels along the edge's axis from where the drag started. */
export function dragWidth(start: number, delta: number, edge: Edge, bounds: WidthBounds): number {
  return clampWidth(edge === "right" || edge === "bottom" ? start + delta : start - delta, bounds);
}

const ARROWS: Record<Edge, { grow: string; shrink: string }> = {
  right: { grow: "ArrowRight", shrink: "ArrowLeft" },
  left: { grow: "ArrowLeft", shrink: "ArrowRight" },
  bottom: { grow: "ArrowDown", shrink: "ArrowUp" },
  top: { grow: "ArrowUp", shrink: "ArrowDown" },
};

/** The size a key press asks for, or null when the key does not resize. */
export function keyWidth(width: number, key: string, edge: Edge, bounds: WidthBounds, step = 16): number | null {
  // Arrows move the edge, so the arrow that points away from the pane grows it.
  const { grow, shrink } = ARROWS[edge];
  if (key === grow) return clampWidth(width + step, bounds);
  if (key === shrink) return clampWidth(width - step, bounds);
  if (key === "Home") return bounds.min;
  if (key === "End") return bounds.max;
  return null;
}

/** Read a stored size, falling back when it is missing or not a number. */
export function parseWidth(raw: string | null, fallback: number, bounds: WidthBounds): number {
  const value = raw === null ? Number.NaN : Number(raw);
  return clampWidth(Number.isFinite(value) ? value : fallback, bounds);
}
