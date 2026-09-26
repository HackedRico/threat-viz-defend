import type { BoardOut } from "../api/types.ts";
import { formatBytes } from "./filePolicy.ts";

// =============================================================================
// Module Overview
// =============================================================================
// A board's activity log, newest first, and the material it was drawn from.
// Changes made by coding agents appear here as they arrive.

const TIME = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/** When something happened, in the reader's locale. */
export function formatTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : TIME.format(date);
}

/** The activity log and source list for a board. */
export function ActivityLog({ board, open = false }: { board: BoardOut; open?: boolean }) {
  const events = [...board.events].reverse();
  return (
    <details className="panel-section" open={open}>
      <summary className="panel-label">
        Activity and sources ({board.events.length} events, {board.sources.length} sources)
      </summary>
      {events.length > 0 && (
        <ol className="activity-list">
          {events.map((event) => (
            <li key={event.id}>
              <time dateTime={event.created_at}>{formatTime(event.created_at)}</time>
              <span>{event.text}</span>
            </li>
          ))}
        </ol>
      )}
      {board.sources.length > 0 && (
        <ul className="source-list">
          {board.sources.map((source) => (
            <li key={source.id}>
              <span className="mono">{source.name}</span>
              <span className="muted">
                {source.kind}, {formatBytes(source.bytes)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}
