import type { ProviderIn, ProviderOut } from "../api/types.ts";

// =============================================================================
// Module Overview
// =============================================================================
// The model provider form without the React: presets that fill a base URL,
// the form's starting values from the saved provider, a check that says what
// to fix before saving, and the body the API takes. A saved key is never put
// back in the form; leaving the key empty keeps it. Every provider speaks the
// OpenAI Chat Completions API; Backboard is memory, set on its own page.

/** A shortcut that fills the base URL and suggests a model. */
export interface Preset {
  id: string;
  label: string;
  baseUrl: string;
  model: string;
  note: string;
}

/** Services people commonly point the analyst at. */
export const PRESETS: readonly Preset[] = [
  {
    id: "digitalocean",
    label: "DigitalOcean",
    baseUrl: "https://inference.do-ai.run/v1",
    model: "",
    note: "Use a model access key from DigitalOcean's serverless inference.",
  },
  { id: "openai", label: "OpenAI", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini", note: "" },
  { id: "openrouter", label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", model: "", note: "" },
  { id: "featherless", label: "Featherless", baseUrl: "https://api.featherless.ai/v1", model: "", note: "" },
  {
    id: "ollama",
    label: "Ollama",
    baseUrl: "http://localhost:11434/v1",
    model: "",
    note: "The server calls this address, so localhost means the server's own machine.",
  },
];

/** What the form holds while the user edits it. */
export interface ProviderForm {
  baseUrl: string;
  model: string;
  apiKey: string;
}

/** Starting values: the saved custom provider, or a blank. The key always starts empty. */
export function initialForm(saved: ProviderOut | null): ProviderForm {
  if (saved?.source === "custom") {
    return { baseUrl: saved.base_url ?? "", model: saved.model ?? "", apiKey: "" };
  }
  return { baseUrl: "", model: "", apiKey: "" };
}

/** Apply a preset, keeping whatever key the user already typed. */
export function applyPreset(form: ProviderForm, preset: Preset): ProviderForm {
  return { ...form, baseUrl: preset.baseUrl, model: preset.model || form.model };
}

/** What stops the form from being tested or saved, or `null` when it is ready. */
export function formProblem(form: ProviderForm): string | null {
  const url = form.baseUrl.trim();
  if (!/^https?:\/\/[^\s/]+/i.test(url)) return "Enter a base URL that starts with https:// or http://.";
  if (form.model.trim() === "") return "Enter the model name.";
  return null;
}

/** The request body; an empty key field becomes `null`, which keeps the saved key. */
export function toProviderIn(form: ProviderForm): ProviderIn {
  const key = form.apiKey.trim();
  return {
    kind: "openai_compatible",
    base_url: form.baseUrl.trim().replace(/\/+$/, ""),
    model: form.model.trim(),
    api_key: key === "" ? null : key,
  };
}
