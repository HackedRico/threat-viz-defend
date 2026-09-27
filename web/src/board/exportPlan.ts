import type { MapLayout } from "./layout.ts";

// =============================================================================
// Module Overview
// =============================================================================
// The decisions behind an export, kept apart from the DOM so they are tested
// directly: a safe file name from a board's title (`fileBase`), which way to
// turn the page the map prints on (`pageFor`), how far to scale a PNG
// (`rasterScale`), and which of the page's font faces an SVG file must carry
// (`facesToEmbed`, with `bestSource` to pick each face's file).

/** A file name from a board title: characters file systems refuse become spaces, and an empty title becomes "threat model". */
export function fileBase(title: string): string {
  const cleaned = title
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ")
    .replace(/\s+/g, " ")
    .slice(0, 80)
    // A leading dot hides a file on macOS and Linux, and Windows drops a trailing dot or space.
    .replace(/^[\s.]+|[\s.]+$/g, "");
  return cleaned || "threat model";
}

/** Which way a printed page is turned. */
export type Orientation = "portrait" | "landscape";

/**
 * Room for the drawing on the map's printed page, in millimeters: the smaller of A4 and US Letter
 * each way, less the page margins in `PaperReport.css` and the heading and key around the drawing.
 */
export const MAP_ROOM: Record<Orientation, { width: number; height: number }> = {
  portrait: { width: 182, height: 200 },
  landscape: { width: 251, height: 132 },
};

/** The way to turn the map's page: on its side only when that prints the map clearly larger. */
export function pageFor(layout: Pick<MapLayout, "width" | "height">): Orientation {
  const scale = (room: { width: number; height: number }) =>
    Math.min(room.width / Math.max(layout.width, 1), room.height / Math.max(layout.height, 1));
  return scale(MAP_ROOM.landscape) > scale(MAP_ROOM.portrait) * 1.1 ? "landscape" : "portrait";
}

// Safari refuses a canvas over about 16.7 million pixels, and some browsers a side over 16,384.
const MAX_PIXELS = 16_000_000;
const MAX_SIDE = 16_384;

/** Canvas pixels per map unit for a PNG: two for sharp text on any screen, fewer when a huge map would pass what a browser canvas holds. */
export function rasterScale(width: number, height: number): number {
  const w = Math.max(width, 1);
  const h = Math.max(height, 1);
  return Math.min(2, Math.sqrt(MAX_PIXELS / (w * h)), MAX_SIDE / w, MAX_SIDE / h);
}

/** One `@font-face` rule as the page declares it. */
export interface FaceRule {
  family: string;
  style: string;
  weight: string;
  unicodeRange: string;
  src: string;
}

/** The first family in a CSS font-family list, without quotes: the font the text asked for. */
export function firstFamily(stack: string): string {
  return (stack.split(",")[0] ?? "").trim().replace(/^(["'])(.*)\1$/, "$2");
}

/** Whether a unicode-range reaches basic Latin letters, where the map's text lives; an empty range reaches everything. */
export function coversLatin(range: string): boolean {
  if (range.trim() === "") return true;
  const letter = 0x41;
  return range.split(",").some((part) => {
    const spec = part.trim().replace(/^u\+/i, "");
    const [from = "", to = from] = spec.split("-");
    // `U+4??` is shorthand for the range U+400 to U+4FF.
    const low = Number.parseInt(from.replace(/\?/g, "0"), 16);
    const high = Number.parseInt(to.replace(/\?/g, "f"), 16);
    return low <= letter && letter <= high;
  });
}

/** The file to embed from a CSS `src` descriptor: the first WOFF2, else the first URL, or `null` when it names none. */
export function bestSource(src: string): string | null {
  const sources = [...src.matchAll(/url\(\s*(["']?)(.*?)\1\s*\)(?:\s*format\(\s*["']?([^"')]*)["']?\s*\))?/g)].map((match) => ({
    url: match[2] ?? "",
    format: (match[3] ?? "").toLowerCase(),
  }));
  const woff2 = sources.find((source) => source.format.startsWith("woff2") || /\.woff2([?#].*)?$/i.test(source.url));
  return (woff2 ?? sources[0])?.url || null;
}

/** The faces an SVG file needs: every face of each family its text uses that covers Latin; the rest of the page's faces stay out. */
export function facesToEmbed<Face extends FaceRule>(faces: readonly Face[], families: ReadonlySet<string>): Face[] {
  return faces.filter((face) => families.has(face.family) && coversLatin(face.unicodeRange));
}
