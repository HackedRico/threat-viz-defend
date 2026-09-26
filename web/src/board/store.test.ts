import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";

import { useBoardUi } from "./store.ts";

// =============================================================================
// Module Overview
// =============================================================================
// Checks how opening a threat and lighting the map treat the selection, which
// decides whether the side panel shows an element's details or its lists.

beforeEach(() => useBoardUi.getState().reset());

test("opening a threat puts the details away and lights the threat", () => {
  const ui = useBoardUi.getState();
  ui.select("db");
  ui.togglePinnedPath("P1");
  ui.openThreat("T6");

  const after = useBoardUi.getState();
  assert.equal(after.selected, null);
  assert.deepEqual(after.focusThreat, { id: "T6" });
  assert.deepEqual(after.highlight, ["T6"]);
  assert.equal(after.highlightSource, "threat");
  assert.equal(after.pinnedPath, null);
});

test("asking for the same threat twice is a new request each time", () => {
  const ui = useBoardUi.getState();
  ui.openThreat("T1");
  const first = useBoardUi.getState().focusThreat;
  ui.showThreat("T1");
  const second = useBoardUi.getState().focusThreat;

  assert.deepEqual(second, { id: "T1" });
  assert.notEqual(first, second);
  ui.showThreat(null);
  assert.equal(useBoardUi.getState().focusThreat, null);
});

test("an answer keeps the selection but a quiz result clears it", () => {
  const ui = useBoardUi.getState();
  ui.select("api");
  ui.setHighlight(["db"], "ask");
  assert.equal(useBoardUi.getState().selected, "api");

  ui.setHighlight(["db"], "quiz");
  assert.equal(useBoardUi.getState().selected, null);
});
