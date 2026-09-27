import { useCallback, useEffect, useId, useState, type FormEvent } from "react";

import { api, errorMessage } from "../api/client.ts";
import type { MemoryNotesOut, MemoryTestOut } from "../api/types.ts";
import { formatTime } from "../board/ActivityLog.tsx";
import { MemoryIcon } from "../shell/icons.tsx";
import { useMemory } from "./memory.ts";
import "./Memory.css";
import "./ProviderSettings.css";

// =============================================================================
// Module Overview
// =============================================================================
// The memory page. Backboard is the memory layer around the model: before an
// answer or a grade it recalls the developer's earlier notes into the prompt,
// and afterwards it keeps a new one, so every board builds on the last. The
// page says how that works, turns it on or off, lists every note Backboard
// holds with a way to forget them all, and takes an optional Backboard key of
// the user's own in place of the server's. Only questions, quiz topics and
// results are kept, never uploads, maps or answer text.

/** The memory settings page. */
export function MemorySettings() {
  const { memory, load, set, error: loadError } = useMemory();
  const [busy, setBusy] = useState<"switch" | "forget" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ids = useId();

  useEffect(() => {
    void load();
  }, [load]);

  const flip = async (enabled: boolean) => {
    setBusy("switch");
    setError(null);
    try {
      set(await api.switchMemory(enabled));
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <header>
        <h2 className="hand connect-title">Memory</h2>
        <p className="connect-lede">
          Backboard is the memory layer around the model. The model draws maps, finds threats and answers. Backboard
          remembers what you asked and how your quiz answers went, on every board, and feeds it back in, so each
          session builds on the last.
        </p>
      </header>

      <section className="connect-step" aria-labelledby={`${ids}-how`}>
        <h3 id={`${ids}-how`} className="connect-step-title">
          How it works
        </h3>
        <ol className="memory-steps">
          <li className="memory-step">
            <strong>Recall</strong>
            Before the model answers a question or grades an open answer, Backboard finds your notes that relate to it.
          </li>
          <li className="memory-step">
            <strong>Feed</strong>
            The notes go into the model's prompt as context, so it can point back to what you found hard.
          </li>
          <li className="memory-step">
            <strong>Keep</strong>
            After you ask or answer, Backboard keeps a new note, and your next quiz starts with the topics you missed.
          </li>
        </ol>
        <p className="field-hint">
          Notes hold the board's name, your question, the quiz topic and how it went. Your uploads, maps and the words
          of your answers never go to Backboard.
        </p>
      </section>

      <section className="connect-step" aria-labelledby={`${ids}-now`}>
        <h3 id={`${ids}-now`} className="connect-step-title">
          <MemoryIcon className="memory-mark" /> Remember my progress
        </h3>
        {memory ? (
          <>
            <label className="memory-switch">
              <input
                type="checkbox"
                checked={memory.enabled}
                disabled={busy !== null || memory.source === "none"}
                onChange={(e) => void flip(e.target.checked)}
              />
              <span>{memory.enabled ? "On" : "Off"}</span>
              {busy === "switch" && <span className="spinner" aria-hidden="true" />}
            </label>
            <p className={`memory-status ${memory.active ? "is-on" : ""}`} role="status">
              {memory.message}
            </p>
            <p className="field-hint">
              {memory.source === "own"
                ? `Held in your own Backboard account, key ending ${memory.key_preview?.replace(/^\.+/, "") ?? ""}.`
                : memory.source === "server"
                  ? "Held in this server's Backboard account, in an assistant of your own."
                  : "Nothing holds your memory yet."}
            </p>
          </>
        ) : loadError ? (
          <p className="panel-error" role="alert">
            {loadError}
          </p>
        ) : (
          <p className="muted">Loading...</p>
        )}
        {error && (
          <p className="panel-error" role="alert">
            {error}
          </p>
        )}
      </section>

      {memory && memory.source !== "none" && <RememberedNotes busy={busy} setBusy={setBusy} />}

      <OwnKey />
    </>
  );
}

/** Every note Backboard holds for the user, newest first, and a way to forget them all. */
function RememberedNotes({
  busy,
  setBusy,
}: {
  busy: "switch" | "forget" | null;
  setBusy: (busy: "switch" | "forget" | null) => void;
}) {
  const [notes, setNotes] = useState<MemoryNotesOut | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const ids = useId();

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setNotes(await api.memoryNotes());
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const forget = async () => {
    setBusy("forget");
    setError(null);
    try {
      await api.forgetMemory();
      setConfirming(false);
      await refresh();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(null);
    }
  };

  const count = notes?.notes.length ?? 0;
  return (
    <section className="connect-step" aria-labelledby={`${ids}-notes`}>
      <h3 id={`${ids}-notes`} className="connect-step-title">
        What Backboard remembers about you
      </h3>
      {notes === null && loading && <p className="muted">Loading from Backboard...</p>}
      {notes !== null && count === 0 && (
        <p className="muted">
          Nothing yet. Ask a question on any board or answer a quiz question, and the note shows up here.
        </p>
      )}
      {count > 0 && (
        <ul className="memory-notes">
          {notes?.notes.map((note) => (
            <li key={note.id || note.content} className="memory-note">
              <span>{note.content}</span>
              {note.created_at && <time dateTime={note.created_at}>{formatTime(note.created_at)}</time>}
            </li>
          ))}
        </ul>
      )}
      {error && (
        <p className="panel-error" role="alert">
          {error}
        </p>
      )}
      <div className="panel-row">
        <button type="button" className="btn" onClick={() => void refresh()} disabled={loading}>
          {loading && <span className="spinner" aria-hidden="true" />} Refresh
        </button>
        {count > 0 &&
          (confirming ? (
            <>
              <button type="button" className="btn btn-danger" onClick={() => void forget()} disabled={busy !== null}>
                {busy === "forget" && <span className="spinner" aria-hidden="true" />} Forget all {count} notes
              </button>
              <button type="button" className="btn btn-ghost" onClick={() => setConfirming(false)}>
                Keep them
              </button>
            </>
          ) : (
            <button type="button" className="btn btn-ghost" onClick={() => setConfirming(true)}>
              Forget everything
            </button>
          ))}
      </div>
    </section>
  );
}

/** An optional Backboard key of the user's own, so their notes live in their own account. */
function OwnKey() {
  const { memory, set } = useMemory();
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState<"test" | "save" | "reset" | null>(null);
  const [result, setResult] = useState<MemoryTestOut | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ids = useId();

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
        set(await api.saveMemory(body()));
        setApiKey("");
        setResult(null);
      } else {
        await api.resetMemory();
        set(await api.memory());
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
        Use your own Backboard key
      </h3>
      <p className="muted">
        Optional. With your own key, your notes live in your Backboard account instead of this server's.
        {memory?.saved && memory.updated_at && ` Saved ${formatTime(memory.updated_at)}.`}
      </p>

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
            {busy === "reset" && <span className="spinner" aria-hidden="true" />} Remove my key
          </button>
        )}
      </div>
    </form>
  );
}
