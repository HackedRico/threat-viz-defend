import { RoughGenerator } from "roughjs/bin/generator.js";
import type { Options } from "roughjs/bin/core.js";

import type { ElementKind } from "../api/types.ts";
import type { Box } from "./layout.ts";

// =============================================================================
// Module Overview
// =============================================================================
// Hand-drawn outlines for the whiteboard. roughjs only computes path data here;
// the canvas renders it as ordinary SVG `<path>` elements styled by CSS, so no
// library touches the DOM or injects styles. Each shape is seeded from its id so
// a node keeps the same wobble across renders instead of shimmering.

const generator = new RoughGenerator();

const BASE: Options = { roughness: 0.85, bowing: 0.7, strokeWidth: 1, preserveVertices: true };

/** A stable seed from a string, so the same id always draws the same wobble. */
export function seedOf(text: string): number {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  // roughjs needs a positive seed; zero would mean "pick a random one".
  return (Math.abs(hash) % 2_000_000_000) + 1;
}

/** SVG path data for the rough outline of `drawable`. */
function outline(drawable: ReturnType<RoughGenerator["path"]>): string[] {
  return generator.toPaths(drawable).map((info) => info.d);
}

/** A clean rounded rectangle path, used for fills and hit areas under rough strokes. */
export function roundedRect(box: Box, radius: number): string {
  const { x, y, width: w, height: h } = box;
  const r = Math.min(radius, w / 2, h / 2);
  return `M${x + r},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y + h - r} Q${x + w},${y + h} ${x + w - r},${y + h} H${x + r} Q${x},${y + h} ${x},${y + h - r} V${y + r} Q${x},${y} ${x + r},${y} Z`;
}

/** Height of the lid ellipse on a store's cylinder. */
export const LID = 8;

/** The clean fill shape for a node of `kind`. */
export function nodeFill(kind: ElementKind, box: Box): string {
  if (kind !== "store") return roundedRect(box, kind === "external" ? 6 : 14);
  const { x, y, width: w, height: h } = box;
  const rx = w / 2;
  return `M${x},${y + LID} A${rx},${LID} 0 0 1 ${x + w},${y + LID} V${y + h - LID} A${rx},${LID} 0 0 1 ${x},${y + h - LID} Z`;
}

/** Rough outline strokes for a node of `kind`. */
export function nodeOutline(kind: ElementKind, box: Box, id: string): string[] {
  const options = { ...BASE, seed: seedOf(id) };
  if (kind !== "store") return outline(generator.path(nodeFill(kind, box), options));
  const { x, y, width: w, height: h } = box;
  const rx = w / 2;
  // The body is open at the top; the full lid ellipse closes it, as a cylinder is drawn by hand.
  const body = `M${x},${y + LID} V${y + h - LID} A${rx},${LID} 0 0 0 ${x + w},${y + h - LID} V${y + LID}`;
  return [
    ...outline(generator.path(body, options)),
    ...outline(generator.ellipse(x + rx, y + LID, w, LID * 2, { ...options, seed: options.seed + 1 })),
  ];
}

/** A rough single-stroke rectangle for a trust boundary; CSS dashes it, since path data cannot. */
export function boundaryOutline(box: Box, id: string): string[] {
  return outline(
    generator.path(roundedRect(box, 18), { ...BASE, roughness: 1.1, seed: seedOf(`boundary:${id}`), disableMultiStroke: true }),
  );
}

/** A small person glyph, head and shoulders, for external entities. */
export function personGlyph(x: number, y: number): string {
  return `M${x + 6},${y + 5} m-3.6,0 a3.6,3.6 0 1,0 7.2,0 a3.6,3.6 0 1,0 -7.2,0 M${x},${y + 17} Q${x},${y + 10} ${x + 6},${y + 10} Q${x + 12},${y + 10} ${x + 12},${y + 17}`;
}

/** Rough strokes for a free-form path, used by the drawing animation. */
export function roughPath(d: string, seed: string, roughness = 1): string[] {
  return outline(generator.path(d, { ...BASE, roughness, seed: seedOf(seed) }));
}
