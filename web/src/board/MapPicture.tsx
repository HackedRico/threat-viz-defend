import { useId, type CSSProperties } from "react";

import type { ExposureOut, SystemMap, Threat } from "../api/types.ts";
import type { MapLayout } from "./layout.ts";
import type { MapDiff } from "./mapDiff.ts";
import { ArrowMarkers, MapScene } from "./MapCanvas.tsx";
import "./MapCanvas.css";

// =============================================================================
// Module Overview
// =============================================================================
// The map drawn once at its natural size, with no view, controls or pointing:
// the same `MapScene` the canvas draws, so the printed report and the image
// files show the very drawing on the board. Its arrowheads get their own ids,
// since the canvas can be on the same page.

// Room around the layout, so a pin or a trifecta caption at the edge is never cut off.
const MARGIN = 16;

/** A still drawing of a laid out map; its viewBox lets CSS scale it to any box. */
export function MapPicture({
  map,
  layout,
  threats,
  exposure,
  crossings,
  label,
  diff = null,
  style,
}: {
  map: SystemMap;
  layout: MapLayout;
  threats: readonly Threat[];
  exposure: readonly ExposureOut[];
  crossings: readonly string[];
  /** What the picture shows, for screen readers and the file's title. */
  label: string;
  /** Marks what is new or edited against another map, as review does; the version compare dialog uses it. */
  diff?: MapDiff | null;
  style?: CSSProperties;
}) {
  const prefix = `picture${useId().replace(/[^\w-]/g, "")}-`;
  const width = layout.width + MARGIN * 2;
  const height = layout.height + MARGIN * 2;
  return (
    <svg
      className="map-picture"
      viewBox={`${-MARGIN} ${-MARGIN} ${width} ${height}`}
      width={width}
      height={height}
      role="img"
      aria-label={label}
      style={style}
    >
      <ArrowMarkers prefix={prefix} />
      <MapScene
        map={map}
        layout={layout}
        threats={threats}
        exposure={exposure}
        crossings={crossings}
        diff={diff}
        draft={false}
        pinsShown
        still
        markers={prefix}
      />
    </svg>
  );
}
