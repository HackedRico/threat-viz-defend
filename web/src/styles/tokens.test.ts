import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// =============================================================================
// Module Overview
// =============================================================================
// Guards what lets `.theme-light` print a light report inside a dark or
// hackUMBC page: every token another theme sets has a light value of its own,
// so none leaks from the page's theme into the paper.

const css = readFileSync(new URL("./tokens.css", import.meta.url), "utf8");

function blocks(): Map<string, Set<string>> {
  const found = new Map<string, Set<string>>();
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = (match[1] ?? "").replace(/\/\*[\s\S]*?\*\//g, "").trim();
    const names = new Set([...(match[2] ?? "").matchAll(/(--[\w-]+)\s*:/g)].map((name) => name[1]!));
    if (names.size > 0) found.set(selector, names);
  }
  return found;
}

test("the light tokens also apply to .theme-light", () => {
  assert.ok(blocks().has(":root,\n.theme-light"));
});

test("every token a theme sets has a light value, so .theme-light resets it", () => {
  const all = blocks();
  const light = all.get(":root,\n.theme-light")!;
  for (const [selector, names] of all) {
    if (selector === ":root,\n.theme-light") continue;
    const missing = [...names].filter((name) => !light.has(name));
    assert.deepEqual(missing, [], `${selector} sets tokens with no light value`);
  }
});
