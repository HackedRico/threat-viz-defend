import { test } from "node:test";
import assert from "node:assert/strict";

import { clampWidth, dragWidth, keyWidth, parseWidth } from "./resize.ts";

// =============================================================================
// Module Overview
// =============================================================================
// Checks the size math behind the draggable sidebar, side panel and ask bar edges.

const bounds = { min: 200, max: 500 };

test("clamps widths to the bounds", () => {
  assert.equal(clampWidth(100, bounds), 200);
  assert.equal(clampWidth(900, bounds), 500);
  assert.equal(clampWidth(321.6, bounds), 322);
  // A window too narrow for the usual maximum still leaves the minimum.
  assert.equal(clampWidth(300, { min: 200, max: 150 }), 200);
});

test("dragging away from the pane widens it", () => {
  assert.equal(dragWidth(300, 40, "right", bounds), 340);
  assert.equal(dragWidth(300, 40, "left", bounds), 260);
  assert.equal(dragWidth(300, -40, "left", bounds), 340);
  assert.equal(dragWidth(300, -500, "right", bounds), 200);
  assert.equal(dragWidth(300, -40, "top", bounds), 340);
  assert.equal(dragWidth(300, 40, "bottom", bounds), 340);
});

test("arrow keys move the edge and Home and End jump to the bounds", () => {
  assert.equal(keyWidth(300, "ArrowRight", "right", bounds), 316);
  assert.equal(keyWidth(300, "ArrowLeft", "right", bounds), 284);
  assert.equal(keyWidth(300, "ArrowLeft", "left", bounds), 316);
  assert.equal(keyWidth(300, "Home", "left", bounds), 200);
  assert.equal(keyWidth(300, "End", "right", bounds), 500);
  assert.equal(keyWidth(300, "ArrowUp", "top", bounds), 316);
  assert.equal(keyWidth(300, "ArrowDown", "top", bounds), 284);
  assert.equal(keyWidth(300, "ArrowLeft", "top", bounds), null);
  assert.equal(keyWidth(300, "Enter", "right", bounds), null);
});

test("reads a stored width or falls back", () => {
  assert.equal(parseWidth("420", 272, bounds), 420);
  assert.equal(parseWidth("9999", 272, bounds), 500);
  assert.equal(parseWidth(null, 272, bounds), 272);
  assert.equal(parseWidth("wide", 272, bounds), 272);
});
