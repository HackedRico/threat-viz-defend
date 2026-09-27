import { useEffect, useState } from "react";

import type { SystemMap } from "../api/types.ts";
import { layoutKey, layOutMap, type LayoutEngine, type MapLayouts } from "./layout.ts";

// =============================================================================
// Module Overview
// =============================================================================
// Lays out a map with ELK both top to bottom and left to right, so the canvas
// can show whichever fits its space. ELK loads on first use, keeping it out of
// the first bundle, and runs again only when the map's structure changes;
// flipping a flag or editing evidence reuses the layouts on screen.

let enginePromise: Promise<LayoutEngine> | null = null;
const RELAYOUT_DELAY_MS = 350;

function loadEngine(): Promise<LayoutEngine> {
  // The bundled build runs ELK on the main thread; a worker would need a blob URL the CSP forbids.
  enginePromise ??= import("elkjs/lib/elk.bundled.js").then(({ default: ELK }) => new ELK());
  return enginePromise;
}

/** Both layouts for `map`, `null` until the first pair is ready, plus any layout failure. */
export function useMapLayout(map: SystemMap | null): { layouts: MapLayouts | null; key: string | null; error: string | null } {
  const [state, setState] = useState<{ layouts: MapLayouts | null; key: string | null; error: string | null }>({
    layouts: null,
    key: null,
    error: null,
  });
  const key = map ? layoutKey(map) : null;

  useEffect(() => {
    if (key !== null && key === state.key) {
      // Back on the map that last laid out, as after undoing an edit that failed: its layout is current again.
      if (state.error !== null) setState((prev) => ({ ...prev, error: null }));
      return undefined;
    }
    if (map === null || key === null) return undefined;
    let cancelled = false;
    const run = () =>
      loadEngine()
        .then(async (engine) => {
          if (cancelled) return;
          // One direction after the other: ELK holds the main thread while it works, so two short
          // holds with a break between them keep the page responsive on a large map.
          const down = await layOutMap(engine, map, "DOWN");
          const right = await layOutMap(engine, map, "RIGHT");
          if (!cancelled) setState({ layouts: { DOWN: down, RIGHT: right }, key, error: null });
        })
        .catch((error: unknown) => {
          if (!cancelled) setState((prev) => ({ ...prev, error: error instanceof Error ? error.message : "Layout failed." }));
        });
    // Typing a name changes the key on every keystroke; waiting for a pause runs ELK once, not per letter.
    const timer = setTimeout(() => void run(), state.layouts ? RELAYOUT_DELAY_MS : 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // `map` is read only when `key` changes; its other fields do not move anything on the canvas.
  }, [key]);

  return state;
}
