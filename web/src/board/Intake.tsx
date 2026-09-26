import { useId, useRef, useState, type DragEvent, type FormEvent } from "react";

import { api, errorMessage } from "../api/client.ts";
import type { BoardOut, SourceIn } from "../api/types.ts";
import { CloseIcon } from "../shell/icons.tsx";
import { useSession } from "../shell/session.tsx";
import { formatBytes, type Skipped } from "./filePolicy.ts";
import { collect, fromDrop, fromFileList, readAccepted, type Picked } from "./readFiles.ts";
import "./Intake.css";

// =============================================================================
// Module Overview
// =============================================================================
// Where material goes onto a board: pasted notes, files, a whole code folder by
// picker or drag and drop, or a public GitHub repository. The file policy runs
// on names and sizes before anything is read, and every skipped file is listed
// with its reason, so the user knows exactly what the analyst will see.

type Staged = SourceIn & { bytes: number };

const MAX_TEXT_CHARS = 200_000;

/** The intake screen; `onCancel` is null when the board has nothing else to show. */
export function Intake({
  board,
  onSubmitted,
  onCancel,
}: {
  board: BoardOut;
  onSubmitted: (next: BoardOut) => void;
  onCancel: (() => void) | null;
}) {
  const { config } = useSession();
  const policy = config.file_policy;
  const ids = useId();
  const [noteName, setNoteName] = useState("");
  const [note, setNote] = useState("");
  const [staged, setStaged] = useState<Staged[]>([]);
  const [skipped, setSkipped] = useState<Skipped[]>([]);
  const [github, setGithub] = useState("");
  const [busy, setBusy] = useState<"reading" | "sending" | "github" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);

  const stagedBytes = staged.reduce((sum, source) => sum + source.bytes, 0);
  const noteBytes = new TextEncoder().encode(note).length;
  const updating = board.status !== "empty";

  const take = async (picked: Picked[], preSkipped: Skipped[] = []) => {
    setBusy("reading");
    setError(null);
    try {
      const known = new Set(staged.map((source) => source.name));
      const fresh = picked.filter((file) => !known.has(file.path));
      const plan = collect(fresh, policy, stagedBytes + noteBytes, staged.length);
      const read = await readAccepted(plan.accepted);
      setStaged((before) => [...before, ...read.sources]);
      setSkipped((before) => [...before, ...preSkipped, ...plan.skipped, ...read.skipped]);
      if (plan.accepted.length === 0 && picked.length > 0 && read.sources.length === 0) {
        setError("None of those files can be sent. See the skipped list for why.");
      }
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(null);
    }
  };

  const onDrop = async (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    setBusy("reading");
    try {
      const { files, skipped: dirs } = await fromDrop(event.dataTransfer, policy);
      await take(files, dirs);
    } catch (caught) {
      setError(errorMessage(caught));
      setBusy(null);
    }
  };

  const submit = async () => {
    const sources: SourceIn[] = staged.map(({ name, kind, text }) => ({ name, kind, text }));
    if (note.trim()) sources.unshift({ name: noteName.trim() || "Pasted notes", kind: "text", text: note });
    if (sources.length === 0) {
      setError("Paste some notes or add files first.");
      return;
    }
    if (note.length > MAX_TEXT_CHARS) {
      setError(`Pasted text is limited to ${MAX_TEXT_CHARS.toLocaleString()} characters. Split it into files.`);
      return;
    }
    if (stagedBytes + noteBytes > policy.maxUploadBytes) {
      setError(`Everything together must stay under ${formatBytes(policy.maxUploadBytes)}. Remove some files.`);
      return;
    }
    setBusy("sending");
    setError(null);
    try {
      onSubmitted(await api.addSources(board.id, sources));
    } catch (caught) {
      setError(errorMessage(caught));
      setBusy(null);
    }
  };

  const readRepo = async (event: FormEvent) => {
    event.preventDefault();
    const url = github.trim();
    if (!/^https:\/\/github\.com\/[^/\s]+\/[^/\s]+/.test(url)) {
      setError("Enter a public repository URL such as https://github.com/owner/repo.");
      return;
    }
    setBusy("github");
    setError(null);
    try {
      onSubmitted(await api.addGithub(board.id, url));
    } catch (caught) {
      setError(errorMessage(caught));
      setBusy(null);
    }
  };

  const sendable = staged.length > 0 || note.trim() !== "";

  return (
    <div className="intake">
      <div className="intake-card">
        <header className="intake-head">
          <div>
            <h2 className="hand intake-title">{updating ? "What changed?" : "What are we drawing?"}</h2>
            <p className="intake-sub">
              {updating
                ? "Add notes, a design doc or code. The map is redrawn, and you check what changed before threats are found again."
                : "Paste a design doc or notes, or drop in code. The map comes first; you check it before any threats are found."}
            </p>
          </div>
          {onCancel && (
            <button type="button" className="btn btn-ghost btn-icon" aria-label="Close without adding" onClick={onCancel}>
              <CloseIcon />
            </button>
          )}
        </header>

        <div className="intake-grid">
          <section className="intake-col" aria-labelledby={`${ids}-paste`}>
            <h3 id={`${ids}-paste`} className="intake-label">
              Paste text
            </h3>
            <div className="field">
              <label className="field-label" htmlFor={`${ids}-note-name`}>
                Name
              </label>
              <input
                id={`${ids}-note-name`}
                className="input"
                placeholder="Pasted notes"
                value={noteName}
                maxLength={300}
                onChange={(e) => setNoteName(e.target.value)}
              />
            </div>
            <div className="field intake-note">
              <label className="field-label" htmlFor={`${ids}-note`}>
                Design doc, README or notes
              </label>
              <textarea
                id={`${ids}-note`}
                className="textarea"
                rows={12}
                placeholder="Who uses it, what it stores, which services it calls, where the AI parts are..."
                value={note}
                onChange={(e) => setNote(e.target.value)}
                aria-describedby={`${ids}-note-count`}
              />
              <span id={`${ids}-note-count`} className="field-hint">
                {note.length.toLocaleString()} of {MAX_TEXT_CHARS.toLocaleString()} characters
              </span>
            </div>
          </section>

          <section className="intake-col" aria-labelledby={`${ids}-files`}>
            <h3 id={`${ids}-files`} className="intake-label">
              Files and code
            </h3>
            <div
              className={`dropzone ${dragging ? "is-over" : ""}`}
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => void onDrop(e)}
            >
              <p className="hand dropzone-title">Drop files or a folder here</p>
              <p className="dropzone-hint">
                Up to {policy.maxFiles} files, {formatBytes(policy.maxFileBytes)} each, {formatBytes(policy.maxUploadBytes)} in
                all. Secrets, lockfiles, binaries and vendored folders are skipped before reading.
              </p>
              <div className="dropzone-actions">
                <button type="button" className="btn btn-sm" onClick={() => fileInput.current?.click()} disabled={busy !== null}>
                  Choose files
                </button>
                <button type="button" className="btn btn-sm" onClick={() => folderInput.current?.click()} disabled={busy !== null}>
                  Choose a code folder
                </button>
              </div>
              <input
                ref={fileInput}
                type="file"
                multiple
                hidden
                aria-label="Choose files"
                onChange={(e) => {
                  if (e.target.files) void take(fromFileList(e.target.files));
                  e.target.value = "";
                }}
              />
              <input
                ref={folderInput}
                type="file"
                multiple
                hidden
                aria-label="Choose a code folder"
                {...{ webkitdirectory: "" }}
                onChange={(e) => {
                  if (e.target.files) void take(fromFileList(e.target.files));
                  e.target.value = "";
                }}
              />
            </div>

            {busy === "reading" && (
              <p className="intake-progress" role="status">
                <span className="spinner" aria-hidden="true" /> Reading files...
              </p>
            )}

            {staged.length > 0 && (
              <div className="staged">
                <div className="staged-head">
                  <span>
                    {staged.length} file{staged.length === 1 ? "" : "s"}, {formatBytes(stagedBytes)}
                  </span>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => setStaged([])}>
                    Clear
                  </button>
                </div>
                <ul className="staged-list">
                  {staged.map((source) => (
                    <li key={source.name}>
                      <span className={`staged-kind kind-${source.kind}`}>{source.kind}</span>
                      <span className="staged-name mono">{source.name}</span>
                      <span className="staged-size">{formatBytes(source.bytes)}</span>
                      <button
                        type="button"
                        className="btn btn-ghost btn-icon btn-sm"
                        aria-label={`Remove ${source.name}`}
                        onClick={() => setStaged((before) => before.filter((s) => s.name !== source.name))}
                      >
                        <CloseIcon width={14} height={14} />
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {skipped.length > 0 && (
              <details className="skipped">
                <summary>
                  {skipped.length} skipped, never read or sent
                </summary>
                <ul>
                  {skipped.map((item, i) => (
                    <li key={`${item.path}:${i}`}>
                      <span className="mono">{item.path}</span>
                      <span className="skipped-reason">{item.reason}</span>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </section>
        </div>

        {error && (
          <p className="intake-error" role="alert">
            {error}
          </p>
        )}

        <footer className="intake-foot">
          <form className="intake-github" onSubmit={readRepo}>
            <label className="field-label" htmlFor={`${ids}-gh`}>
              Or read a public GitHub repository
            </label>
            <div className="intake-github-row">
              <input
                id={`${ids}-gh`}
                className="input mono"
                type="url"
                inputMode="url"
                placeholder="https://github.com/owner/repo"
                value={github}
                maxLength={300}
                onChange={(e) => setGithub(e.target.value)}
              />
              <button type="submit" className="btn" disabled={busy !== null || github.trim() === ""}>
                {busy === "github" && <span className="spinner" aria-hidden="true" />} Read repository
              </button>
            </div>
          </form>
          <button type="button" className="btn btn-primary intake-submit" onClick={() => void submit()} disabled={busy !== null || !sendable}>
            {busy === "sending" && <span className="spinner" aria-hidden="true" />}
            {updating ? "Redraw the map" : "Draw the map"}
          </button>
        </footer>

        {board.sources.length > 0 && (
          <details className="intake-existing">
            <summary>Already on this board: {board.sources.length} source{board.sources.length === 1 ? "" : "s"}</summary>
            <ul>
              {board.sources.map((source) => (
                <li key={source.id}>
                  <span className={`staged-kind kind-${source.kind}`}>{source.kind}</span>
                  <span className="mono">{source.name}</span>
                  <span className="staged-size">{formatBytes(source.bytes)}</span>
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </div>
  );
}
