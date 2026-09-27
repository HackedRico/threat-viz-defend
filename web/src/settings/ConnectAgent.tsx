import { useEffect, useId, useState, type FormEvent } from "react";

import { api, errorMessage } from "../api/client.ts";
import type { TokenOut } from "../api/types.ts";
import { formatTime } from "../board/ActivityLog.tsx";
import { useBoardList } from "../shell/boards.tsx";
import { CheckIcon, CopyIcon, TrashIcon } from "../shell/icons.tsx";
import { navigate } from "../shell/useRoute.ts";
import { apiOrigin } from "../api/base.ts";
import { claudeCommand, cursorConfig, envLine, mcpUrl, TOKEN_PLACEHOLDER } from "./snippets.ts";
import "./ConnectAgent.css";

// =============================================================================
// Module Overview
// =============================================================================
// Connects a coding agent to this deployment over MCP. The user makes a
// personal token, sees it once, and copies ready-made setup for Claude Code or
// Cursor. Agent tools take a board id, so the chosen board's id is shown too.

/** Copy `value` to the clipboard, with a check mark for a moment afterwards. */
function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setFailed(false);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard access can be refused; the text stays selectable in its box.
      setFailed(true);
    }
  };
  return (
    <button type="button" className="btn btn-sm copy-button" onClick={() => void copy()} aria-label={`Copy ${label}`}>
      {copied ? <CheckIcon width={15} height={15} /> : <CopyIcon width={15} height={15} />}
      {copied ? "Copied" : failed ? "Select and copy" : "Copy"}
    </button>
  );
}

function Snippet({ title, value, label }: { title: string; value: string; label: string }) {
  return (
    <div className="snippet">
      <div className="snippet-head">
        <span className="snippet-title">{title}</span>
        <CopyButton value={value} label={label} />
      </div>
      <pre className="snippet-body" tabIndex={0}>
        <code>{value}</code>
      </pre>
    </div>
  );
}

/** The connect-a-coding-agent screen. */
export function ConnectAgent({ boardId }: { boardId: string | null }) {
  const { boards } = useBoardList();
  const [tokens, setTokens] = useState<TokenOut[] | null>(null);
  const [name, setName] = useState("");
  const [fresh, setFresh] = useState<{ token: string; name: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ids = useId();
  // Agents talk to the API, which may live on another origin than this page.
  const origin = apiOrigin();
  const board = boards.find((b) => b.id === boardId) ?? boards[0] ?? null;
  const token = fresh?.token ?? TOKEN_PLACEHOLDER;

  useEffect(() => {
    api.tokens().then(setTokens, (caught: unknown) => setError(errorMessage(caught)));
  }, []);

  const create = async (event: FormEvent) => {
    event.preventDefault();
    const label = name.trim() || "Coding agent";
    setBusy(true);
    setError(null);
    try {
      const created = await api.createToken(label);
      setFresh({ token: created.token, name: created.info.name });
      setTokens((before) => [created.info, ...(before ?? [])]);
      setName("");
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (id: string) => {
    setError(null);
    try {
      await api.deleteToken(id);
      setTokens((before) => (before ?? []).filter((t) => t.id !== id));
    } catch (caught) {
      setError(errorMessage(caught));
    }
  };

  return (
    <>
        <header>
          <h2 className="hand connect-title">Connect a coding agent</h2>
          <p className="connect-lede">
            Let Claude Code or Cursor read and update your boards while you build. When an agent changes the code, it can
            send the change here, and the board shows what moved on the map.
          </p>
        </header>

        <section className="connect-step" aria-labelledby={`${ids}-s1`}>
          <h3 id={`${ids}-s1`} className="connect-step-title">
            <span className="step-num">1</span> Make a personal token
          </h3>
          <form className="connect-form" onSubmit={create}>
            <label htmlFor={`${ids}-name`} className="field-label">
              Token name
            </label>
            <div className="connect-row">
              <input
                id={`${ids}-name`}
                className="input"
                placeholder="Laptop Claude Code"
                value={name}
                maxLength={60}
                onChange={(e) => setName(e.target.value)}
              />
              <button type="submit" className="btn btn-primary" disabled={busy}>
                {busy && <span className="spinner" aria-hidden="true" />} Create token
              </button>
            </div>
          </form>
          {fresh && (
            <div className="token-once" role="status">
              <p>
                <strong>Copy this token now.</strong> It is shown once and never again.
              </p>
              <div className="token-value">
                <code className="mono">{fresh.token}</code>
                <CopyButton value={fresh.token} label="the token" />
              </div>
            </div>
          )}
          {error && (
            <p className="panel-error" role="alert">
              {error}
            </p>
          )}
          {tokens && tokens.length > 0 && (
            <table className="token-table">
              <caption className="visually-hidden">Your tokens</caption>
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Starts with</th>
                  <th scope="col">Created</th>
                  <th scope="col">Last used</th>
                  <th scope="col">
                    <span className="visually-hidden">Revoke</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {tokens.map((t) => (
                  <tr key={t.id}>
                    <td>{t.name}</td>
                    <td className="mono">{t.prefix}</td>
                    <td>{formatTime(t.created_at)}</td>
                    <td>{t.last_used_at ? formatTime(t.last_used_at) : "never"}</td>
                    <td>
                      <button type="button" className="btn btn-ghost btn-sm btn-danger" onClick={() => void revoke(t.id)} aria-label={`Revoke ${t.name}`}>
                        <TrashIcon width={15} height={15} /> Revoke
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <section className="connect-step" aria-labelledby={`${ids}-s2`}>
          <h3 id={`${ids}-s2`} className="connect-step-title">
            <span className="step-num">2</span> Add the server to your agent
          </h3>
          {!fresh && <p className="field-hint">Create a token above and it fills in below.</p>}
          <Snippet
            title="First, in the shell that starts your agent"
            value={envLine(token)}
            label="the environment line"
          />
          <Snippet title="Claude Code" value={claudeCommand(origin)} label="the Claude Code command" />
          <p className="field-hint">
            Run it in the same shell, from the project folder you start Claude Code in: it adds the server for that folder.
            To switch tokens, run <code>claude mcp remove threatviz</code> first.
          </p>
          <Snippet title="Cursor: .cursor/mcp.json" value={cursorConfig(origin)} label="the Cursor config" />
          <p className="field-hint">
            The MCP endpoint is <code>{mcpUrl(origin)}</code>. A Claude Code hook that sends each change to your board
            is in the <code>integrations/</code> folder of this repository.
          </p>
        </section>

        <section className="connect-step" aria-labelledby={`${ids}-s3`}>
          <h3 id={`${ids}-s3`} className="connect-step-title">
            <span className="step-num">3</span> Tell the agent which board
          </h3>
          {boards.length === 0 ? (
            <p className="muted">Make a board first; agent tools take its id.</p>
          ) : (
            <>
              <label htmlFor={`${ids}-board`} className="field-label">
                Board
              </label>
              <select
                id={`${ids}-board`}
                className="select connect-board"
                value={board?.id ?? ""}
                onChange={(e) => navigate({ name: "settings", section: "agents", boardId: e.target.value }, true)}
              >
                {boards.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.title}
                  </option>
                ))}
              </select>
              {board && <Snippet title="Board id" value={board.id} label="the board id" />}
            </>
          )}
        </section>
    </>
  );
}
