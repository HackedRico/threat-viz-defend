import type { ProviderIn, ProviderKind, ProviderOut } from "../api/types.ts";

// =============================================================================
// Module Overview
// =============================================================================
// The model provider form without the React: presets that fill a base URL,
// the form's starting values from the saved provider, a check that says what
// to fix before saving, and the body the API takes. A saved key is never put
// back in the form; leaving the key empty keeps it.

/** A shortcut that fills the base URL and suggests a model. */
export interface Preset {
  id: string;
  label: string;
  kind: ProviderKind;
  baseUrl: string;
  model: string;
  note: string;
}

/** The base URL a Backboard provider starts with. */
export const BACKBOARD_URL = "https://app.backboard.io/api";

/** Services people commonly point the analyst at. */
export const PRESETS: readonly Preset[] = [
  { id: "openai", label: "OpenAI", kind: "openai_compatible", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini", note: "" },
  {
    id: "digitalocean",
    label: "DigitalOcean",
    kind: "openai_compatible",
    baseUrl: "https://inference.do-ai.run/v1",
    model: "",
    note: "Use a model access key from DigitalOcean's serverless inference.",
  },
  { id: "openrouter", label: "OpenRouter", kind: "openai_compatible", baseUrl: "https://openrouter.ai/api/v1", model: "", note: "" },
  {
    id: "ollama",
    label: "Ollama",
    kind: "openai_compatible",
    baseUrl: "http://localhost:11434/v1",
    model: "",
    note: "The server calls this address, so localhost means the server's own machine.",
  },
  {
    id: "backboard",
    label: "Backboard",
    kind: "backboard",
    baseUrl: BACKBOARD_URL,
    model: "openai/gpt-4o",
    note: "Write the model as provider/model. Memory lets it remember your progress across boards.",
  },
];

/** What the form holds while the user edits it. */
export interface ProviderForm {
  kind: ProviderKind;
  baseUrl: string;
  model: string;
  apiKey: string;
  memory: boolean;
}

/** Starting values: the saved custom provider, or an OpenAI shaped blank. The key always starts empty. */
export function initialForm(saved: ProviderOut | null): ProviderForm {
  if (saved?.source === "custom" && saved.kind) {
    return { kind: saved.kind, baseUrl: saved.base_url ?? "", model: saved.model ?? "", apiKey: "", memory: saved.memory };
  }
  return { kind: "openai_compatible", baseUrl: "", model: "", apiKey: "", memory: false };
}

/** Apply a preset, keeping whatever key the user already typed. */
export function applyPreset(form: ProviderForm, preset: Preset): ProviderForm {
  return {
    ...form,
    kind: preset.kind,
    baseUrl: preset.baseUrl,
    model: preset.model || form.model,
    memory: preset.kind === "backboard" ? form.memory : false,
  };
}

/** What stops the form from being tested or saved, or `null` when it is ready. */
export function formProblem(form: ProviderForm): string | null {
  const url = form.baseUrl.trim();
  if (!/^https?:\/\/[^\s/]+/i.test(url)) return "Enter a base URL that starts with https:// or http://.";
  if (form.model.trim() === "") return "Enter the model name.";
  if (form.kind === "backboard" && !form.model.includes("/")) return "Backboard models are written as provider/model, such as openai/gpt-4o.";
  return null;
}

/** The request body; an empty key field becomes `null`, which keeps the saved key. */
export function toProviderIn(form: ProviderForm): ProviderIn {
  const key = form.apiKey.trim();
  return {
    kind: form.kind,
    base_url: form.baseUrl.trim().replace(/\/+$/, ""),
    model: form.model.trim(),
    api_key: key === "" ? null : key,
    memory: form.kind === "backboard" && form.memory,
  };
}
