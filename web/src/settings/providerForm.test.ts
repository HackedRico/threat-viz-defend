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
  kind: "openai_compatible",
  base_url: "https://inference.do-ai.run/v1",
  model: "openai-gpt-oss-120b",
  key_preview: "...9f3a",
  label: "openai-gpt-oss-120b (your provider)",
  updated_at: "2026-09-26T12:00:00Z",
};

test("starts from the saved provider without its key", () => {
  const form = initialForm(saved);
  assert.equal(form.apiKey, "");
  assert.equal(form.model, "openai-gpt-oss-120b");
  assert.deepEqual(initialForm({ ...saved, source: "server", kind: null }), { baseUrl: "", model: "", apiKey: "" });
});

test("presets fill the base URL and keep a typed key", () => {
  const typed = { ...initialForm(null), apiKey: "sk-typed" };
  const filled = applyPreset(typed, PRESETS.find((p) => p.id === "digitalocean")!);
  assert.equal(filled.baseUrl, "https://inference.do-ai.run/v1");
  assert.equal(filled.apiKey, "sk-typed");
  assert.ok(PRESETS.every((p) => !p.baseUrl.includes("backboard")));
});

test("names what to fix before saving", () => {
  const form = initialForm(null);
  assert.match(formProblem(form) ?? "", /base URL/);
  assert.match(formProblem({ ...form, baseUrl: "https://x.test/v1" }) ?? "", /model/);
  assert.equal(formProblem({ ...form, baseUrl: "https://x.test/v1", model: "m" }), null);
});

test("an empty key field keeps the saved key", () => {
  const body = toProviderIn({ baseUrl: " https://api.openai.com/v1/ ", model: " gpt-4o ", apiKey: "  " });
  assert.deepEqual(body, { kind: "openai_compatible", base_url: "https://api.openai.com/v1", model: "gpt-4o", api_key: null });
});
