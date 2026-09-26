import { useEffect, useId, useState, type FormEvent } from "react";

import { api, errorMessage } from "../api/client.ts";
import type { ProviderKind, ProviderTestOut } from "../api/types.ts";
import { formatTime } from "../board/ActivityLog.tsx";
import { applyPreset, BACKBOARD_URL, formProblem, initialForm, PRESETS, toProviderIn, type ProviderForm } from "./providerForm.ts";
import { useProvider } from "./provider.ts";
import "./ProviderSettings.css";

// =============================================================================
// Module Overview
// =============================================================================
// Lets a user run their analyses on their own model: an OpenAI compatible
// service or Backboard. The form tests a connection before saving, offers the
// models the service lists, and never shows a saved key; leaving the key empty
// keeps it. Removing the provider goes back to the server's default.

const SOURCE_TEXT = {
  custom: "Your own model",
  server: "The server's default model",
  demo: "Demo mode, no model: only the built-in example can be mapped",
} as const;

/** The model provider settings section. */
export function ProviderSettings() {
  const { provider, load, set, error: loadError } = useProvider();
  const [form, setForm] = useState<ProviderForm>(() => initialForm(provider));
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState<"test" | "save" | "reset" | null>(null);
  const [result, setResult] = useState<ProviderTestOut | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const ids = useId();

  useEffect(() => {
    void load();
  }, [load]);

  // Fill the form from the saved provider once it arrives, unless the user already started typing.
  useEffect(() => {
    if (!touched) setForm(initialForm(provider));
  }, [provider, touched]);

  const edit = (patch: Partial<ProviderForm>) => {
    setTouched(true);
    setSaved(false);
    setForm((before) => ({ ...before, ...patch }));
  };

  const hasSavedKey = provider?.source === "custom" && provider.key_preview !== null;

  const run = async (kind: "test" | "save") => {
    const problem = formProblem(form);
    if (problem) {
      setError(problem);
      return;
    }
    setBusy(kind);
    setError(null);
    setSaved(false);
    try {
      if (kind === "test") {
        setResult(await api.testProvider(toProviderIn(form)));
      } else {
        const next = await api.saveProvider(toProviderIn(form));
        set(next);
        setTouched(false);
        setForm(initialForm(next));
        setSaved(true);
      }
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(null);
    }
  };

  const reset = async () => {
    setBusy("reset");
    setError(null);
    try {
      await api.resetProvider();
      setTouched(false);
      setResult(null);
      await useProvider.getState().load();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(null);
    }
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    void run("save");
  };

  const setKind = (kind: ProviderKind) =>
    edit(kind === "backboard" ? { kind, baseUrl: form.baseUrl || BACKBOARD_URL } : { kind, memory: false });

  return (
    <>
      <header>
        <h2 className="hand connect-title">Model provider</h2>
        <p className="connect-lede">
          Maps, threats, answers and quiz grading run on a language model. Bring your own and every analysis names it, so
          you know which model drew your board.
        </p>
      </header>

      <section className="connect-step" aria-labelledby={`${ids}-now`}>
        <h3 id={`${ids}-now`} className="connect-step-title">
          In use now
        </h3>
        {provider ? (
          <div className="provider-now">
            <p className="provider-label hand">{provider.label}</p>
            <p className="muted">
              {SOURCE_TEXT[provider.source]}
              {provider.key_preview && `, key ending ${provider.key_preview.replace(/^\.+/, "")}`}
              {provider.updated_at && `, saved ${formatTime(provider.updated_at)}`}
            </p>
            {provider.source === "custom" && (
              <button type="button" className="btn btn-sm btn-danger" onClick={() => void reset()} disabled={busy !== null}>
                {busy === "reset" && <span className="spinner" aria-hidden="true" />} Remove and use the server default
              </button>
            )}
          </div>
        ) : loadError ? (
          <p className="panel-error" role="alert">
            {loadError}
          </p>
        ) : (
          <p className="muted">Loading...</p>
        )}
      </section>

      <form className="connect-step provider-form" onSubmit={onSubmit} aria-labelledby={`${ids}-form`} noValidate>
        <h3 id={`${ids}-form`} className="connect-step-title">
          {provider?.source === "custom" ? "Change your model" : "Use your own model"}
        </h3>

        <fieldset className="provider-kinds">
          <legend className="field-label">Kind</legend>
          <label className={`provider-kind ${form.kind === "openai_compatible" ? "is-on" : ""}`}>
            <input type="radio" name={`${ids}-kind`} checked={form.kind === "openai_compatible"} onChange={() => setKind("openai_compatible")} />
            <span className="provider-kind-name">OpenAI compatible</span>
            <span className="field-hint">OpenAI, DigitalOcean, OpenRouter, Ollama and others</span>
          </label>
          <label className={`provider-kind ${form.kind === "backboard" ? "is-on" : ""}`}>
            <input type="radio" name={`${ids}-kind`} checked={form.kind === "backboard"} onChange={() => setKind("backboard")} />
            <span className="provider-kind-name">Backboard</span>
            <span className="field-hint">Any model through one key, with optional memory</span>
          </label>
        </fieldset>

        <div className="provider-presets" role="group" aria-label="Fill in a known service">
          {PRESETS.filter((preset) => preset.kind === form.kind).map((preset) => (
            <button key={preset.id} type="button" className="chip provider-preset" onClick={() => edit(applyPreset(form, preset))}>
              {preset.label}
            </button>
          ))}
        </div>
        {PRESETS.find((p) => p.baseUrl === form.baseUrl && p.note)?.note && (
          <p className="field-hint">{PRESETS.find((p) => p.baseUrl === form.baseUrl)!.note}</p>
        )}

        <div className="field">
          <label className="field-label" htmlFor={`${ids}-url`}>
            Base URL
          </label>
          <input
            id={`${ids}-url`}
            className="input mono"
            type="url"
            inputMode="url"
            placeholder={form.kind === "backboard" ? BACKBOARD_URL : "https://api.openai.com/v1"}
            value={form.baseUrl}
            maxLength={300}
            onChange={(e) => edit({ baseUrl: e.target.value })}
          />
        </div>

        <div className="field">
          <label className="field-label" htmlFor={`${ids}-model`}>
            Model
          </label>
          <input
            id={`${ids}-model`}
            className="input mono"
            list={`${ids}-models`}
            placeholder={form.kind === "backboard" ? "openai/gpt-4o" : "gpt-4o-mini"}
            value={form.model}
            maxLength={200}
            autoCapitalize="none"
            spellCheck={false}
            onChange={(e) => edit({ model: e.target.value })}
          />
          <datalist id={`${ids}-models`}>
            {result?.models.map((model) => (
              <option key={model} value={model} />
            ))}
          </datalist>
        </div>

        <div className="field">
          <label className="field-label" htmlFor={`${ids}-key`}>
            API key
          </label>
          <input
            id={`${ids}-key`}
            className="input mono"
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder={hasSavedKey ? "Leave empty to keep the saved key" : "Paste the key for this service"}
            value={form.apiKey}
            maxLength={500}
            onChange={(e) => edit({ apiKey: e.target.value })}
            aria-describedby={`${ids}-key-hint`}
          />
          <span id={`${ids}-key-hint`} className="field-hint">
            Stored on the server and never shown again. Local services such as Ollama may need none.
          </span>
        </div>

        {form.kind === "backboard" && (
          <label className="toggle">
            <input type="checkbox" checked={form.memory} onChange={(e) => edit({ memory: e.target.checked })} />
            <span>Remember my progress across boards</span>
          </label>
        )}

        {result && (
          <div className={`banner ${result.ok ? "" : "banner-error"}`} role="status">
            <div className="banner-body">
              <strong>{result.ok ? "Connected." : "That did not work."}</strong> {result.message}
              {result.models.length > 0 && (
                <div className="provider-models">
                  <span className="field-hint">Models it offers:</span>
                  {result.models.slice(0, 24).map((model) => (
                    <button key={model} type="button" className="chip mono provider-preset" onClick={() => edit({ model })}>
                      {model}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {error && (
          <p className="panel-error" role="alert">
            {error}
          </p>
        )}
        {saved && (
          <p className="provider-saved" role="status">
            Saved. New analyses run on {provider?.label ?? "your model"}.
          </p>
        )}

        <div className="panel-row">
          <button type="button" className="btn" onClick={() => void run("test")} disabled={busy !== null}>
            {busy === "test" && <span className="spinner" aria-hidden="true" />} Test connection
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy !== null}>
            {busy === "save" && <span className="spinner" aria-hidden="true" />} Save
          </button>
        </div>
      </form>
    </>
  );
}

/** A quiet line naming the model in use, for screens where an analysis is running. */
export function ProviderLine() {
  const { provider, load } = useProvider();
  useEffect(() => {
    if (provider === null) void load();
  }, [provider, load]);
  if (provider === null) return null;
  return <p className="provider-line">Using {provider.label}</p>;
}
