import { test } from "node:test";
import assert from "node:assert/strict";

import { findingsLine } from "./brief.ts";

// =============================================================================
// Module Overview
// =============================================================================
// Checks the plain sentence the brief card builds from a board's counts.

test("names each severity present and the attack paths", () => {
  assert.equal(
    findingsLine({ critical: 1, high: 3, medium: 3, low: 0 }, 3),
    "The analysis found 7 ways an attacker could cause harm: 1 critical, 3 high and 3 medium. " +
      "3 attack paths chain them into step by step attacks.",
  );
});

test("reads in the singular and without paths", () => {
  assert.equal(
    findingsLine({ critical: 0, high: 1, medium: 0, low: 0 }, 0),
    "The analysis found 1 way an attacker could cause harm: 1 high.",
  );
  assert.match(findingsLine({ critical: 0, high: 0, medium: 2, low: 1 }, 1), /2 medium and 1 low\. 1 attack path chains/);
});

test("says so when nothing was found", () => {
  assert.equal(findingsLine({ critical: 0, high: 0, medium: 0, low: 0 }, 0), "The analysis found no threats on this map.");
});
