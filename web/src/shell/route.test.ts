import { test } from "node:test";
import assert from "node:assert/strict";

import { guardLeaving, mayLeave, parseRoute, routePath } from "./route.ts";

// =============================================================================
// Module Overview
// =============================================================================
// Checks that every route survives a round trip through the URL, and that
// leaving asks a screen with unsaved work until it lets go.

test("reads and writes each route", () => {
  for (const route of [
    { name: "home" as const },
    { name: "board" as const, boardId: "b 1" },
    { name: "settings" as const, section: "agents" as const, boardId: "abc" },
    { name: "settings" as const, section: "agents" as const, boardId: null },
    { name: "settings" as const, section: "provider" as const, boardId: "abc" },
    { name: "settings" as const, section: "memory" as const, boardId: null },
  ]) {
    const path = routePath(route);
    const [pathname, search] = path.split("?");
    assert.deepEqual(parseRoute(pathname!, search ? `?${search}` : ""), route);
  }
});

test("sends unknown and malformed paths home or keeps them readable", () => {
  assert.deepEqual(parseRoute("/nope"), { name: "home" });
  assert.deepEqual(parseRoute("/boards/"), { name: "home" });
  assert.deepEqual(parseRoute("/boards/%E0"), { name: "board", boardId: "%E0" });
});

test("leaving asks the screen with unsaved work until it lets go", () => {
  assert.equal(mayLeave(), true);
  let asked = 0;
  const release = guardLeaving(() => {
    asked += 1;
    return false;
  });
  assert.equal(mayLeave(), false);
  assert.equal(asked, 1);
  release();
  assert.equal(mayLeave(), true);
  assert.equal(asked, 1);
});

test("an old guard letting go keeps a newer one in place", () => {
  const releaseOld = guardLeaving(() => true);
  const releaseNew = guardLeaving(() => false);
  releaseOld();
  assert.equal(mayLeave(), false);
  releaseNew();
  assert.equal(mayLeave(), true);
});
