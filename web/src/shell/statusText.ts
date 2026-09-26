import type { BoardStatus } from "../api/types.ts";

// =============================================================================
// Module Overview
// =============================================================================
// The words the app uses for each board status, so the sidebar, the board
// header and screen readers all say the same thing.

/** A short label for a board status. */
export const STATUS_LABEL: Record<BoardStatus, string> = {
  empty: "No material yet",
  mapping: "Drawing the map",
  review: "Check the map",
  analyzing: "Finding threats",
  ready: "Ready to defend",
};

/** True while the server is working on a board in the background. */
export function isBusy(status: BoardStatus): boolean {
  return status === "mapping" || status === "analyzing";
}
