import { bestSource, facesToEmbed, firstFamily, rasterScale, type FaceRule } from "./exportPlan.ts";

// =============================================================================
// Module Overview
// =============================================================================
// Turns a drawn map into files. `standaloneSvg` copies a drawing with every
// style it wears written onto its elements and the fonts its text uses
// embedded, so the file looks the same in any viewer and theme; `svgToPng`
// paints that file onto a canvas; `saveFile` hands a blob to the browser as a
// download. The drawing's text is still SVG text, never markup.

// Everything the map's CSS sets on SVG elements. Inlining computed values carries the page's
// theme and fonts into the file without a stylesheet that could drift from the canvas.
const STYLE_PROPERTIES = [
  "fill",
  "fill-opacity",
  "stroke",
  "stroke-width",
  "stroke-dasharray",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-opacity",
  "opacity",
  "paint-order",
  "filter",
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "letter-spacing",
  "text-anchor",
  "dominant-baseline",
] as const;

// Initial values; leaving them out keeps the file small.
const INITIAL: Partial<Record<(typeof STYLE_PROPERTIES)[number], string>> = {
  "fill-opacity": "1",
  "stroke-dasharray": "none",
  "stroke-linecap": "butt",
  "stroke-linejoin": "miter",
  "stroke-opacity": "1",
  opacity: "1",
  "paint-order": "normal",
  filter: "none",
  "font-style": "normal",
  "letter-spacing": "normal",
  "text-anchor": "start",
  "dominant-baseline": "auto",
};

// What makes the live canvas interactive; a file has nothing to press or focus.
const INTERACTIVE = ["role", "tabindex", "aria-label", "aria-pressed", "data-el", "class"];

/** A self-contained SVG document of `svg`: styles inlined, fonts embedded, `background` behind the map and `title` as its name. */
export async function standaloneSvg(svg: SVGSVGElement, title: string, background: string): Promise<string> {
  const copy = svg.cloneNode(true) as SVGSVGElement;
  const originals = [svg, ...svg.querySelectorAll("*")];
  const copies = [copy, ...copy.querySelectorAll("*")];
  const families = new Set<string>();

  originals.forEach((element, index) => {
    const target = copies[index]!;
    const style = getComputedStyle(element);
    const declarations = STYLE_PROPERTIES.flatMap((name) => {
      const value = style.getPropertyValue(name);
      return value && value !== INITIAL[name] ? [`${name}:${value}`] : [];
    });
    if (element instanceof SVGTextElement) {
      families.add(firstFamily(style.fontFamily));
      // Not every SVG viewer applies CSS text-transform, so the capitals go into the text itself.
      if (style.textTransform === "uppercase") target.textContent = (target.textContent ?? "").toUpperCase();
    }
    INTERACTIVE.forEach((name) => target.removeAttribute(name));
    if (declarations.length > 0) target.setAttribute("style", declarations.join(";"));
  });

  copy.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  copy.setAttribute("role", "img");
  const name = document.createElementNS("http://www.w3.org/2000/svg", "title");
  name.textContent = title;
  const board = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  const box = svg.viewBox.baseVal;
  board.setAttribute("x", String(box.x));
  board.setAttribute("y", String(box.y));
  board.setAttribute("width", String(box.width));
  board.setAttribute("height", String(box.height));
  board.setAttribute("fill", background);
  const fonts = document.createElementNS("http://www.w3.org/2000/svg", "style");
  fonts.textContent = await embeddedFonts(families);
  copy.prepend(name, fonts, board);
  return new XMLSerializer().serializeToString(copy);
}

/** `@font-face` rules for `families`, each font file inlined as a data URL, since an SVG shown as an image loads nothing. */
async function embeddedFonts(families: ReadonlySet<string>): Promise<string> {
  const faces = facesToEmbed(pageFaces(), families);
  const rules = await Promise.all(
    faces.map(async (face) => {
      const source = bestSource(face.src);
      if (source === null) return "";
      const data = await dataUrl(new URL(source, face.base).href);
      const range = face.unicodeRange ? `unicode-range:${face.unicodeRange};` : "";
      return `@font-face{font-family:"${face.family}";font-style:${face.style || "normal"};font-weight:${face.weight || "normal"};src:url(${data});${range}}`;
    }),
  );
  return rules.join("\n");
}

/** Every `@font-face` rule on the page with the URL its relative sources resolve against. */
function pageFaces(): Array<FaceRule & { base: string }> {
  const faces: Array<FaceRule & { base: string }> = [];
  for (const sheet of document.styleSheets) {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      // A stylesheet from another origin cannot be read; ours are all on this one.
      continue;
    }
    for (const rule of rules) {
      if (!(rule instanceof CSSFontFaceRule)) continue;
      faces.push({
        family: firstFamily(rule.style.getPropertyValue("font-family")),
        style: rule.style.getPropertyValue("font-style"),
        weight: rule.style.getPropertyValue("font-weight"),
        unicodeRange: rule.style.getPropertyValue("unicode-range"),
        src: rule.style.getPropertyValue("src"),
        base: sheet.href ?? document.baseURI,
      });
    }
  }
  return faces;
}

async function dataUrl(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) throw new Error("A font for the image could not be loaded. Reload the page and try again.");
  const blob = await response.blob();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("A font for the image could not be read. Try again."));
    reader.readAsDataURL(blob);
  });
}

/** A PNG of an SVG document `width` by `height` map units, drawn at `rasterScale` for sharp text. */
export async function svgToPng(svgText: string, width: number, height: number): Promise<Blob> {
  const url = URL.createObjectURL(new Blob([svgText], { type: "image/svg+xml" }));
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const scale = rasterScale(width, height);
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    const context = canvas.getContext("2d");
    if (context === null) throw new Error("This browser cannot draw the image. Try the SVG instead.");
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("The image could not be made. Try the SVG instead."))), "image/png"),
    );
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Download `blob` as a file named `name`. */
export function saveFile(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  // Firefox only follows a link that is in the document.
  document.body.append(link);
  link.click();
  link.remove();
  // The download has started by now; a later revoke gives slow browsers room to begin reading.
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
