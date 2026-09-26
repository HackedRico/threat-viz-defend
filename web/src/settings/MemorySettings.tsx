import { useEffect, useId, useState, type FormEvent } from "react";

import { api, errorMessage } from "../api/client.ts";
import type { MemoryOut, MemoryTestOut } from "../api/types.ts";
import { formatTime } from "../board/ActivityLog.tsx";
import { useProvider } from "./provider.ts";

// =============================================================================
// Module Overview
// =============================================================================
// Backboard memory, apart from the model provider: a Backboard key lets any
// model remember what the user asked and how their quiz answers went, across
// boards. Only questions and verdicts are kept, never uploads or answer text.
// The status reloads when the provider changes, since memory needs the user's
// own model.

/** The memory settings section. */
export function MemorySettings() {
  const provider = useProvider((state) => state.provider);
  const [memory, setMemory] = useState<MemoryOut | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState<"test" | "save" | "reset" | null>(null);
  const [result, setResult] = useState<MemoryTestOut | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ids = useId();

  useEffect(() => {
    let live = true;
    api
      .memory()
      .then((next) => live && setMemory(next))
      .catch((caught: unknown) => live && setError(errorMessage(caught)));
    return () => {
      live = false;
    };
  }, [provider]);

  const body = () => ({ api_key: apiKey.trim() === "" ? null : apiKey.trim() });

  const act = async (kind: "test" | "save" | "reset") => {
    if (kind !== "reset" && !memory?.saved && apiKey.trim() === "") {
      setError("Paste your Backboard API key.");
      return;
    }
    setBusy(kind);
    setError(null);
    try {
      if (kind === "test") {
        setResult(await api.testMemory(body()));
      } else if (kind === "save") {
        setMemory(await api.saveMemory(body()));
        setApiKey("");
        setResult(null);
      } else {
        await api.resetMemory();
        setMemory(await api.memory());
        setResult(null);
      }
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(null);
    }
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    void act("save");
  };

  return (
    <form className="connect-step provider-form" onSubmit={onSubmit} aria-labelledby={`${ids}-title`} noValidate>
      <h3 id={`${ids}-title`} className="connect-step-title">
        Memory
      </h3>
      <p className="muted">
        Add a Backboard key and your own model remembers the questions you asked and how your quiz answers were graded,
        across boards. Your uploads, maps and answer text are never sent to Backboard.
      </p>
      {memory && (
        <p className={memory.active ? "provider-saved" : "muted"} role="status">
          {memory.message}
          {memory.key_preview && ` Key ending ${memory.key_preview.replace(/^\.+/, "")}`}
          {memory.updated_at && `, saved ${formatTime(memory.updated_at)}.`}
        </p>
      )}

      <div className="field">
        <label className="field-label" htmlFor={`${ids}-key`}>
          Backboard API key
        </label>
        <input
          id={`${ids}-key`}
          className="input mono"
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder={memory?.saved ? "Leave empty to keep the saved key" : "Paste your Backboard key"}
          value={apiKey}
          maxLength={500}
          onChange={(e) => setApiKey(e.target.value)}
        />
        <span className="field-hint">Stored on the server and never shown again. Memory calls spend your Backboard credits.</span>
      </div>

      {result && (
        <div className={`banner ${result.ok ? "" : "banner-error"}`} role="status">
          <div className="banner-body">
            <strong>{result.ok ? "Connected." : "That did not work."}</strong> {result.message}
          </div>
        </div>
      )}
      {error && (
        <p className="panel-error" role="alert">
          {error}
        </p>
      )}

      <div className="panel-row">
        <button type="button" className="btn" onClick={() => void act("test")} disabled={busy !== null}>
          {busy === "test" && <span className="spinner" aria-hidden="true" />} Test key
        </button>
        <button type="submit" className="btn btn-primary" disabled={busy !== null}>
          {busy === "save" && <span className="spinner" aria-hidden="true" />} Save
        </button>
        {memory?.saved && (
          <button type="button" className="btn btn-danger" onClick={() => void act("reset")} disabled={busy !== null}>
            {busy === "reset" && <span className="spinner" aria-hidden="true" />} Turn off memory
          </button>
        )}
      </div>
    </form>
  );
}
