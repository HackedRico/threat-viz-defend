// =============================================================================
// Module Overview
// =============================================================================
// Width math for the draggable edges on the sidebar and the side panel. A
// handle sits on one edge of its pane; dragging away from the pane widens it.

/** Which edge of its pane a handle sits on. */
export type Edge = "left" | "right";

/** The widths a pane may take, in pixels. */
export interface WidthBounds {
  min: number;
  max: number;
}

/** Keep a width inside its bounds, whole pixels only. */
export function clampWidth(width: number, { min, max }: WidthBounds): number {
  return Math.round(Math.min(Math.max(min, max), Math.max(min, width)));
}

/** The width after the pointer moves `dx` pixels from where the drag started. */
export function dragWidth(start: number, dx: number, edge: Edge, bounds: WidthBounds): number {
  return clampWidth(edge === "right" ? start + dx : start - dx, bounds);
}

/** The width a key press asks for, or null when the key does not resize. */
export function keyWidth(width: number, key: string, edge: Edge, bounds: WidthBounds, step = 16): number | null {
  // Arrows move the edge, so the arrow that points away from the pane widens it.
  const grow = edge === "right" ? "ArrowRight" : "ArrowLeft";
  const shrink = edge === "right" ? "ArrowLeft" : "ArrowRight";
  if (key === grow) return clampWidth(width + step, bounds);
  if (key === shrink) return clampWidth(width - step, bounds);
  if (key === "Home") return bounds.min;
  if (key === "End") return bounds.max;
  return null;
}

/** Read a stored width, falling back when it is missing or not a number. */
export function parseWidth(raw: string | null, fallback: number, bounds: WidthBounds): number {
  const value = raw === null ? Number.NaN : Number(raw);
  return clampWidth(Number.isFinite(value) ? value : fallback, bounds);
}
