import { useEffect, useState } from "react";

import type { SystemMap } from "../api/types.ts";
import { layoutKey, placeLabels, readLayout, toElkGraph, type MapLayout } from "./layout.ts";

// =============================================================================
// Module Overview
// =============================================================================
// Lays out a map with ELK, loaded on first use so the layout engine stays out
// of the first bundle. A new layout runs only when the map's structure changes;
// flipping a flag or editing evidence reuses the one on screen.

type Elk = { layout: (graph: ReturnType<typeof toElkGraph>) => Promise<ReturnType<typeof toElkGraph>> };

let elkPromise: Promise<Elk> | null = null;

function loadElk(): Promise<Elk> {
  // The bundled build runs ELK on the main thread; a worker would need a blob URL the CSP forbids.
  elkPromise ??= import("elkjs/lib/elk.bundled.js").then(({ default: ELK }) => new ELK());
  return elkPromise;
}

/** The layout for `map`, `null` until the first one is ready, plus any layout failure. */
export function useMapLayout(map: SystemMap | null): { layout: MapLayout | null; key: string | null; error: string | null } {
  const [state, setState] = useState<{ layout: MapLayout | null; key: string | null; error: string | null }>({
    layout: null,
    key: null,
    error: null,
  });
  const key = map ? layoutKey(map) : null;

  useEffect(() => {
    if (map === null || key === null || key === state.key) return undefined;
    let cancelled = false;
    loadElk()
      .then((elk) => elk.layout(toElkGraph(map)))
      .then((result) => {
        if (!cancelled) setState({ layout: placeLabels(readLayout(result), map.flows), key, error: null });
      })
      .catch((error: unknown) => {
        if (!cancelled) setState((prev) => ({ ...prev, error: error instanceof Error ? error.message : "Layout failed." }));
      });
    return () => {
      cancelled = true;
    };
    // `map` is read only when `key` changes; its other fields do not move anything on the canvas.
  }, [key]);

  return state;
}
