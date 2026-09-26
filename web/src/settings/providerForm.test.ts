import { test } from "node:test";
import assert from "node:assert/strict";

import type { ProviderOut } from "../api/types.ts";
import { applyPreset, formProblem, initialForm, PRESETS, toProviderIn } from "./providerForm.ts";

// =============================================================================
// Module Overview
// =============================================================================
// Checks that a saved key never returns to the form, presets fill the right
// fields, and the body keeps the saved key when the key field is left empty.

const saved: ProviderOut = {
  source: "custom",
  kind: "backboard",
  base_url: "https://app.backboard.io/api",
  model: "openai/gpt-4o",
  key_preview: "...9f3a",
  memory: true,
  label: "Backboard openai/gpt-4o",
  updated_at: "2026-09-26T12:00:00Z",
};

test("starts from the saved provider without its key", () => {
  const form = initialForm(saved);
  assert.equal(form.apiKey, "");
  assert.equal(form.kind, "backboard");
  assert.equal(form.memory, true);
  assert.equal(initialForm({ ...saved, source: "server", kind: null }).kind, "openai_compatible");
});

test("presets fill the base URL and keep a typed key", () => {
  const typed = { ...initialForm(null), apiKey: "sk-typed" };
  const filled = applyPreset(typed, PRESETS.find((p) => p.id === "digitalocean")!);
  assert.equal(filled.baseUrl, "https://inference.do-ai.run/v1");
  assert.equal(filled.apiKey, "sk-typed");
  assert.equal(applyPreset({ ...typed, memory: true }, PRESETS[0]!).memory, false);
});

test("names what to fix before saving", () => {
  const form = initialForm(null);
  assert.match(formProblem(form) ?? "", /base URL/);
  assert.match(formProblem({ ...form, baseUrl: "https://x.test/v1" }) ?? "", /model/);
  assert.match(formProblem({ ...form, kind: "backboard", baseUrl: "https://x.test", model: "gpt-4o" }) ?? "", /provider\/model/);
  assert.equal(formProblem({ ...form, baseUrl: "https://x.test/v1", model: "m" }), null);
});

test("an empty key field keeps the saved key", () => {
  const body = toProviderIn({ kind: "openai_compatible", baseUrl: " https://api.openai.com/v1/ ", model: " gpt-4o ", apiKey: "  ", memory: true });
  assert.deepEqual(body, { kind: "openai_compatible", base_url: "https://api.openai.com/v1", model: "gpt-4o", api_key: null, memory: false });
});
