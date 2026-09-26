import { useEffect, useRef } from "react";

// =============================================================================
// Module Overview
// =============================================================================
// Runs a task on a timer while the tab is visible, and once more as soon as
// the tab comes back into view. A slow task never overlaps itself.

/** Call `task` every `intervalMs` while the page is visible; `null` pauses polling. */
export function usePolling(task: () => Promise<unknown>, intervalMs: number | null): void {
  const latest = useRef(task);
  useEffect(() => {
    latest.current = task;
  });

  useEffect(() => {
    if (intervalMs === null) return undefined;
    let timer: number | undefined;
    let running = false;
    let stopped = false;

    const tick = async () => {
      if (stopped || running || document.visibilityState !== "visible") return;
      running = true;
      try {
        await latest.current();
      } catch {
        // Polling is best effort; the next tick retries and screens show errors from their own calls.
      } finally {
        running = false;
      }
    };

    const schedule = () => {
      timer = window.setTimeout(async () => {
        await tick();
        if (!stopped) schedule();
      }, intervalMs);
    };

    const onVisible = () => {
      if (document.visibilityState === "visible") void tick();
    };

    schedule();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [intervalMs]);
}
