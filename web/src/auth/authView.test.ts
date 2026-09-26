import { test } from "node:test";
import assert from "node:assert/strict";

import { authView, authViewPath, isFormPath } from "./authView.ts";

// =============================================================================
// Module Overview
// =============================================================================
// Checks which signed-out screen each path shows, and which paths give way to
// the app's home after signing in.

test("shows the home page at the root and each form at its own path", () => {
  assert.equal(authView("/"), "home");
  assert.equal(authView(""), "home");
  assert.equal(authView("/signin"), "signin");
  assert.equal(authView("/signup"), "signup");
  assert.equal(authView("/signup/"), "signup");
});

test("asks to sign in first for any link into the app", () => {
  assert.equal(authView("/boards/b1"), "signin");
  assert.equal(authView("/settings/provider"), "signin");
  assert.equal(authView("/signup/extra"), "signin");
  assert.equal(authView("/nope"), "signin");
});

test("reads back the path of every screen", () => {
  for (const view of ["home", "signin", "signup"] as const) assert.equal(authView(authViewPath(view)), view);
});

test("hands only the form paths back to the app's home after sign in", () => {
  assert.equal(isFormPath("/signin"), true);
  assert.equal(isFormPath("/signup/"), true);
  assert.equal(isFormPath("/"), false);
  assert.equal(isFormPath("/boards/b1"), false);
  assert.equal(isFormPath("/settings"), false);
});
