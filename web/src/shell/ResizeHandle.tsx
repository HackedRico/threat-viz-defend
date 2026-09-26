import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";

import { clampWidth, dragWidth, keyWidth, parseWidth, type Edge, type WidthBounds } from "./resize.ts";
import "./ResizeHandle.css";

// =============================================================================
// Module Overview
// =============================================================================
// A draggable edge that sets a pane's width, and the hook that remembers the
// width in this browser. The handle is a focusable separator, so arrow keys
// resize it too, and a double click puts the default width back.

function readStored(key: string, fallback: number, bounds: WidthBounds): number {
  try {
    return parseWidth(localStorage.getItem(key), fallback, bounds);
  } catch {
    // Storage can be blocked in private windows; the pane starts at its default.
    return fallback;
  }
}

/** A pane width that survives reloads. Pass fixed bounds; clamp to the window at render. */
export function useStoredWidth(key: string, fallback: number, bounds: WidthBounds): [number, (next: number) => void] {
  const [width, setWidth] = useState(() => readStored(key, fallback, bounds));
  useEffect(() => {
    try {
      localStorage.setItem(key, String(width));
    } catch {
      // Not remembering the width is harmless.
    }
  }, [key, width]);
  return [width, setWidth];
}

/** A vertical drag handle on one edge of a pane. */
export function ResizeHandle({
  label,
  controls,
  edge,
  width,
  bounds,
  fallback,
  onResize,
}: {
  label: string;
  controls: string;
  edge: Edge;
  width: number;
  bounds: WidthBounds;
  fallback: number;
  onResize: (next: number) => void;
}) {
  const drag = useRef<{ x: number; start: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  // The body class stops text selection and keeps the resize cursor while the pointer
  // is over the map or panel instead of the thin handle.
  useEffect(() => {
    if (!dragging) return undefined;
    document.body.classList.add("is-resizing");
    return () => document.body.classList.remove("is-resizing");
  }, [dragging]);

  const down = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { x: event.clientX, start: width };
    setDragging(true);
  };

  const move = (event: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    onResize(dragWidth(drag.current.start, event.clientX - drag.current.x, edge, bounds));
  };

  const up = () => {
    drag.current = null;
    setDragging(false);
  };

  const key = (event: KeyboardEvent<HTMLDivElement>) => {
    const next = keyWidth(width, event.key, edge, bounds);
    if (next === null) return;
    event.preventDefault();
    onResize(next);
  };

  return (
    <div
      role="separator"
      tabIndex={0}
      aria-label={label}
      aria-controls={controls}
      aria-orientation="vertical"
      aria-valuenow={width}
      aria-valuemin={bounds.min}
      aria-valuemax={bounds.max}
      title="Drag to resize, double click to reset"
      className={`resize-handle edge-${edge} ${dragging ? "is-dragging" : ""}`}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      onKeyDown={key}
      onDoubleClick={() => onResize(clampWidth(fallback, bounds))}
    />
  );
}
