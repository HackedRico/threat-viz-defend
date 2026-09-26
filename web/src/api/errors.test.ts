import { test } from "node:test";
import assert from "node:assert/strict";

import { ApiError, formatWait, toApiError } from "./errors.ts";

// =============================================================================
// Module Overview
// =============================================================================
// Checks that server errors keep their message, that rate limits say when to
// retry, and that bodies of the wrong shape fall back to a readable message.

test("keeps the server's code and message", () => {
  const error = toApiError(409, { error: { code: "conflict", message: "Confirm the map first." } }, null);
  assert.ok(error instanceof ApiError);
  assert.equal(error.code, "conflict");
  assert.equal(error.message, "Confirm the map first.");
  assert.equal(error.signedOut, false);
});

test("marks 401 as signed out", () => {
  const error = toApiError(401, { error: { code: "unauthorized", message: "Sign in to continue." } }, null);
  assert.equal(error.signedOut, true);
});

test("adds the wait to a rate limit message that lacks one", () => {
  const error = toApiError(429, { error: { code: "rate_limited", message: "Slow down." } }, "30");
  assert.equal(error.retryAfter, 30);
  assert.equal(error.message, "Slow down. Try again in 30 seconds.");
});

test("leaves a rate limit message alone when it already names the wait", () => {
  const error = toApiError(429, { error: { code: "rate_limited", message: "Try again in 2 minutes." } }, "120");
  assert.equal(error.message, "Try again in 2 minutes.");
});

test("falls back when the body is not the error shape", () => {
  assert.equal(toApiError(502, "<html>bad gateway</html>", null).message, "The server hit a problem. Try again in a moment.");
  assert.equal(toApiError(404, { detail: "nope" }, null).message, "That was not found. It may have been deleted.");
  assert.equal(toApiError(400, { error: { code: "x", message: "  " } }, null).message, "The request did not work.");
});

test("formats waits in seconds then minutes", () => {
  assert.equal(formatWait(1), "1 second");
  assert.equal(formatWait(45), "45 seconds");
  assert.equal(formatWait(600), "10 minutes");
});
