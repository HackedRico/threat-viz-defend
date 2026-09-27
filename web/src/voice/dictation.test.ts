import { test } from "node:test";
import assert from "node:assert/strict";

import { audioTypeOf, clock, joinDictation, preferredRecordingType, toBase64 } from "./dictation.ts";

// =============================================================================
// Module Overview
// =============================================================================
// Checks the plain parts of dictation: the recording format each browser gets,
// the name the server knows it by, the base64 body, and how heard words join
// what was typed.

test("asks for opus in webm first and falls back to mp4 for Safari", () => {
  assert.equal(preferredRecordingType(() => true), "audio/webm;codecs=opus");
  assert.equal(preferredRecordingType((type) => type === "audio/mp4"), "audio/mp4");
  assert.equal(preferredRecordingType((type) => type.startsWith("audio/ogg")), "audio/ogg;codecs=opus");
  assert.equal(preferredRecordingType(() => false), undefined);
});

test("names the recorder's format the way the server expects", () => {
  assert.equal(audioTypeOf("audio/webm;codecs=opus"), "audio/webm");
  assert.equal(audioTypeOf("video/webm; codecs=opus"), "audio/webm");
  assert.equal(audioTypeOf("Audio/MP4"), "audio/mp4");
  assert.equal(audioTypeOf("audio/ogg;codecs=opus"), "audio/ogg");
  assert.equal(audioTypeOf("audio/flac"), null);
  assert.equal(audioTypeOf(""), null);
});

test("encodes clips as base64, including ones longer than one slice", () => {
  assert.equal(toBase64(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3])), "GkXfow==");
  const long = new Uint8Array(100_000).map((_, i) => i % 256);
  assert.deepEqual(new Uint8Array(Buffer.from(toBase64(long), "base64")), long);
});

test("adds heard words after typed ones with one space", () => {
  assert.equal(joinDictation("", "  What happens if the database leaks? ", 2000), "What happens if the database leaks?");
  assert.equal(joinDictation("About the triage agent,", "what can it send?", 2000), "About the triage agent, what can it send?");
  assert.equal(joinDictation("Ends in a space ", "then words", 2000), "Ends in a space then words");
  assert.equal(joinDictation("Kept as typed", "   ", 2000), "Kept as typed");
  assert.equal(joinDictation("abc", "defgh", 6), "abc de");
});

test("shows the recording time as minutes and seconds", () => {
  assert.equal(clock(0), "0:00");
  assert.equal(clock(7.9), "0:07");
  assert.equal(clock(60), "1:00");
  assert.equal(clock(-3), "0:00");
});
