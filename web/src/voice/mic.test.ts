import { test } from "node:test";
import assert from "node:assert/strict";

import { micProblem } from "./mic.ts";

// =============================================================================
// Module Overview
// =============================================================================
// Checks what the dictate button and the voice coach say when the microphone
// will not open. The errors are the names and messages Chrome and Firefox
// reject `getUserMedia` with.

test("points a blocked microphone to a browser that can allow it", () => {
  const blocked = micProblem(new DOMException("Permission denied", "NotAllowedError"));
  assert.match(blocked, /icon beside the address/);
  assert.match(blocked, /inside another app, open it in Chrome, Edge, Firefox or Safari/);
  assert.equal(micProblem(new DOMException("The operation is insecure.", "SecurityError")), blocked);
});

test("sends a microphone the computer blocks to the system settings", () => {
  assert.match(micProblem(new DOMException("Permission denied by system", "NotAllowedError")), /privacy settings/);
});

test("asks again when the microphone prompt was closed", () => {
  assert.match(micProblem(new DOMException("Permission dismissed", "NotAllowedError")), /choose Allow/);
});

test("tells a missing microphone from a busy one", () => {
  assert.match(micProblem(new DOMException("Requested device not found", "NotFoundError")), /No microphone was found/);
  assert.match(micProblem(new DOMException("Could not start audio source", "NotReadableError")), /could not start/);
  assert.match(micProblem(new Error("Something else")), /could not start/);
});
