import { test } from "node:test";
import assert from "node:assert/strict";

import { parseThemeChoice, resolveTheme } from "./theme.ts";

// =============================================================================
// Module Overview
// =============================================================================
// Checks that stored choices parse safely and resolve to the right theme.

test("reads a stored choice and falls back to system for anything else", () => {
  assert.equal(parseThemeChoice("umbc"), "umbc");
  assert.equal(parseThemeChoice("dark"), "dark");
  assert.equal(parseThemeChoice(null), "system");
  assert.equal(parseThemeChoice("neon"), "system");
});

test("system follows the preference and a picked theme ignores it", () => {
  assert.equal(resolveTheme("system", true), "dark");
  assert.equal(resolveTheme("system", false), "light");
  assert.equal(resolveTheme("light", true), "light");
  assert.equal(resolveTheme("umbc", false), "umbc");
});
