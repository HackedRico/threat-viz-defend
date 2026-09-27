import { useEffect, useId, useRef, useState, type FormEvent } from "react";

import { api, errorMessage } from "../api/client.ts";
import type { SnowflakeExportIn, SnowflakeExportOut } from "../api/types.ts";
import { CloseIcon } from "../shell/icons.tsx";
import "./SnowflakeDialog.css";

// =============================================================================
// Module Overview
// =============================================================================
// The Snowflake dialog the Export menu opens: the user's own account, warehouse,
// database, schema and access token. The server sends this board's threats to a
// `threat_findings` table there. The token is never stored, here or on the
// server; the other four fields are remembered in this browser to save typing.

const REMEMBER_KEY = "threatviz.snowflake";

type Place = Omit<SnowflakeExportIn, "token">;

const EMPTY: Place = { account: "", warehouse: "COMPUTE_WH", database: "", schema_name: "PUBLIC" };

function recall(): Place {
  try {
    const saved = JSON.parse(localStorage.getItem(REMEMBER_KEY) ?? "null") as Partial<Place> | null;
    return { ...EMPTY, ...saved };
  } catch {
    return EMPTY;
  }
}

function remember(place: Place) {
  try {
    localStorage.setItem(REMEMBER_KEY, JSON.stringify(place));
  } catch {
    // Private windows can refuse storage; the export still works, the fields just start empty next time.
  }
}

const FIELDS: readonly { key: keyof Place; label: string; placeholder: string }[] = [
  { key: "account", label: "Account identifier", placeholder: "myorg-myaccount" },
  { key: "warehouse", label: "Warehouse", placeholder: "COMPUTE_WH" },
  { key: "database", label: "Database", placeholder: "THREATVIZ" },
  { key: "schema_name", label: "Schema", placeholder: "PUBLIC" },
];

/** The Snowflake export dialog for one board; it opens on mount and calls `onClose` when dismissed. */
export function SnowflakeDialog({ boardId, onClose }: { boardId: string; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const ids = useId();
  const [place, setPlace] = useState<Place>(recall);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<SnowflakeExportOut | null>(null);

  useEffect(() => {
    dialog.current?.showModal();
  }, []);

  const ready = FIELDS.every((field) => place[field.key].trim() !== "") && token.trim().length >= 8;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    setSent(null);
    const trimmed: Place = {
      account: place.account.trim(),
      warehouse: place.warehouse.trim(),
      database: place.database.trim(),
      schema_name: place.schema_name.trim(),
    };
    try {
      setSent(await api.snowflake(boardId, { ...trimmed, token: token.trim() }));
      remember(trimmed);
      setToken("");
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <dialog ref={dialog} className="snowflake-dialog" aria-labelledby={`${ids}-title`} onClose={onClose}>
      <form onSubmit={(event) => void submit(event)}>
        <header className="sf-head">
          <h2 id={`${ids}-title`} className="sf-title">
            Send to Snowflake
          </h2>
          <button type="button" className="btn btn-ghost btn-icon" aria-label="Close" title="Close" onClick={() => dialog.current?.close()}>
            <CloseIcon />
          </button>
        </header>
        <p className="field-hint sf-lead">
          Writes one row per threat to a <code>threat_findings</code> table in your own account, replacing this board's rows from any
          earlier send. Chart it in Snowsight or query it with SQL.
        </p>

        <div className="sf-grid">
          {FIELDS.map((field) => (
            <div className="field" key={field.key}>
              <label className="field-label" htmlFor={`${ids}-${field.key}`}>
                {field.label}
              </label>
              <input
                id={`${ids}-${field.key}`}
                className="input mono"
                placeholder={field.placeholder}
                value={place[field.key]}
                maxLength={field.key === "account" ? 120 : 255}
                autoCapitalize="none"
                spellCheck={false}
                onChange={(e) => setPlace({ ...place, [field.key]: e.target.value })}
              />
            </div>
          ))}
        </div>

        <div className="field">
          <label className="field-label" htmlFor={`${ids}-token`}>
            Programmatic access token
          </label>
          <input
            id={`${ids}-token`}
            className="input mono"
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={token}
            maxLength={4000}
            onChange={(e) => setToken(e.target.value)}
          />
          <p className="field-hint">Used for this send only and never saved. Create one under Settings, Authentication in Snowsight.</p>
        </div>

        {error && (
          <p className="sf-note is-error" role="alert">
            {error}
          </p>
        )}
        {sent && (
          <p className="sf-note is-ok" role="status">
            Sent {sent.rows} {sent.rows === 1 ? "threat" : "threats"} to <code>{sent.table}</code>.
          </p>
        )}

        <footer className="sf-foot">
          <button type="button" className="btn btn-ghost" onClick={() => dialog.current?.close()}>
            {sent ? "Done" : "Cancel"}
          </button>
          <button type="submit" className="btn btn-primary" disabled={!ready || busy}>
            {busy && <span className="spinner" aria-hidden="true" />} Send threats
          </button>
        </footer>
      </form>
    </dialog>
  );
}
