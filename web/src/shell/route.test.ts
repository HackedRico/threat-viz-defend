import { test } from "node:test";
import assert from "node:assert/strict";

import { parseRoute, routePath } from "./route.ts";

// =============================================================================
// Module Overview
// =============================================================================
// Checks that every route survives a round trip through the URL.

test("reads and writes each route", () => {
  for (const route of [
    { name: "home" as const },
    { name: "board" as const, boardId: "b 1" },
    { name: "settings" as const, section: "agents" as const, boardId: "abc" },
    { name: "settings" as const, section: "agents" as const, boardId: null },
    { name: "settings" as const, section: "provider" as const, boardId: "abc" },
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
