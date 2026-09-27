import { test } from "node:test";
import assert from "node:assert/strict";

import { bestSource, coversLatin, facesToEmbed, fileBase, firstFamily, pageFor, rasterScale, type FaceRule } from "./exportPlan.ts";

// =============================================================================
// Module Overview
// =============================================================================
// Checks the choices an export makes before it touches the page: file names
// every system accepts, the page the map prints on, a PNG size a browser canvas
// can hold, and which font faces an SVG file has to carry to look the same.

test("a board title becomes a file name any system accepts", () => {
  assert.equal(fileBase("Shop API"), "Shop API");
  assert.equal(fileBase('a/b\\c:d*e?f"g<h>i|j'), "a b c d e f g h i j");
  assert.equal(fileBase("  ..hidden. "), "hidden");
  assert.equal(fileBase("line\nbreak\ttab"), "line break tab");
  assert.equal(fileBase("x".repeat(200)).length, 80);
});

test("a title with nothing a file name can keep falls back to a plain name", () => {
  assert.equal(fileBase(""), "threat model");
  assert.equal(fileBase("///"), "threat model");
  assert.equal(fileBase(". ."), "threat model");
});

test("a wide map prints on its side and a tall or square one upright", () => {
  assert.equal(pageFor({ width: 1800, height: 600 }), "landscape");
  assert.equal(pageFor({ width: 700, height: 1400 }), "portrait");
  assert.equal(pageFor({ width: 900, height: 900 }), "portrait");
});

test("a map only turns the page when that prints it clearly larger", () => {
  // On its side this map prints about 4% larger: not worth turning the reader's page for.
  assert.equal(pageFor({ width: 1150, height: 800 }), "portrait");
  assert.equal(pageFor({ width: 1300, height: 800 }), "landscape");
  assert.equal(pageFor({ width: 0, height: 0 }), "portrait");
});

test("a PNG doubles the map for sharp text but never outgrows a browser canvas", () => {
  assert.equal(rasterScale(1200, 800), 2);
  const huge = rasterScale(6000, 5000);
  assert.ok(huge < 2);
  assert.ok(6000 * huge * 5000 * huge <= 16_000_000 + 1);
  const long = rasterScale(40_000, 100);
  assert.ok(40_000 * long <= 16_384);
});

test("the font a text asked for is the first in its stack, unquoted", () => {
  assert.equal(firstFamily('Caveat, "Segoe Print", cursive'), "Caveat");
  assert.equal(firstFamily('"IBM Plex Mono", ui-monospace, monospace'), "IBM Plex Mono");
  assert.equal(firstFamily("'Instrument Sans Variable'"), "Instrument Sans Variable");
});

test("a unicode range covers the map's text only when it reaches basic Latin", () => {
  assert.equal(coversLatin(""), true);
  assert.equal(coversLatin("U+0000-00FF, U+0131, U+0152-0153"), true);
  assert.equal(coversLatin("u+0-ff"), true);
  assert.equal(coversLatin("U+0100-02BA, U+1E00-1E9F"), false);
  assert.equal(coversLatin("U+00??"), true);
  assert.equal(coversLatin("U+0041"), true);
});

test("the embedded file is the WOFF2 when a face offers one", () => {
  assert.equal(
    bestSource('url("/files/caveat-latin-700-normal.woff2") format("woff2"), url("/files/caveat-latin-700-normal.woff") format("woff")'),
    "/files/caveat-latin-700-normal.woff2",
  );
  assert.equal(bestSource('url(/a.woff) format("woff"), url(/a.woff2?v=2)'), "/a.woff2?v=2");
  assert.equal(bestSource("url('/sans.woff2') format('woff2-variations')"), "/sans.woff2");
  assert.equal(bestSource('url("/only.ttf") format("truetype")'), "/only.ttf");
  assert.equal(bestSource('local("Arial")'), null);
});

test("an SVG file carries the Latin faces of the families its text uses and nothing else", () => {
  const face = (family: string, unicodeRange = ""): FaceRule => ({ family, style: "normal", weight: "400", unicodeRange, src: "" });
  const faces = [face("Caveat"), face("IBM Plex Mono"), face("Instrument Sans Variable", "U+0000-00FF"), face("Instrument Sans Variable", "U+0100-02BA")];
  const kept = facesToEmbed(faces, new Set(["Caveat", "Instrument Sans Variable"]));
  assert.deepEqual(
    kept.map((f) => [f.family, f.unicodeRange]),
    [
      ["Caveat", ""],
      ["Instrument Sans Variable", "U+0000-00FF"],
    ],
  );
});
