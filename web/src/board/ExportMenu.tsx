import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";

import { api, errorMessage } from "../api/client.ts";
import type { BoardOut, SystemMap, ThreatAnalysis } from "../api/types.ts";
import { DownloadIcon } from "../shell/icons.tsx";
import { useSession } from "../shell/session.tsx";
import { saveFile, standaloneSvg, svgToPng } from "./exportImage.ts";
import { fileBase } from "./exportPlan.ts";
import { pickDirection, type MapLayout } from "./layout.ts";
import { MapPicture } from "./MapPicture.tsx";
import { PaperReport } from "./PaperReport.tsx";
import { SnowflakeDialog } from "./SnowflakeDialog.tsx";
import { useBoardUi } from "./store.ts";
import { layOutBoth } from "./useMapLayout.ts";
import "./ExportMenu.css";

// =============================================================================
// Module Overview
// =============================================================================
// The Export menu on a ready board. "PDF report" mounts `PaperReport` and opens
// the print dialog, where Save as PDF writes the file. "PNG image" and "SVG
// image" save the drawn map in the page's theme. "Markdown" downloads the text
// report from the server. "Snowflake" opens a dialog that sends the threats to
// the user's own Snowflake account. A drawing is laid out afresh the way round the canvas
// shows it, so every file shows the map as it is on the board.

type Format = "pdf" | "png" | "svg" | "markdown" | "snowflake";

const CHOICES: readonly { format: Format; title: string; hint: string }[] = [
  { format: "pdf", title: "PDF report", hint: "The map, every threat and its fixes. Choose Save as PDF in the print dialog." },
  { format: "png", title: "PNG image", hint: "The map as a picture, for slides and docs." },
  { format: "svg", title: "SVG image", hint: "The map as a drawing that stays sharp at any size." },
  { format: "markdown", title: "Markdown", hint: "The report as text, for a repo or a ticket." },
  { format: "snowflake", title: "Snowflake", hint: "One row per threat in your own account, ready for SQL and charts." },
];

// A canvas the size of a laptop's, for the rare export before the canvas has picked a direction.
const FALLBACK_VIEW = { width: 1000, height: 630 };
// The menu's width in ExportMenu.css; it opens toward whichever side of the button has room for it.
const MENU_WIDTH = 310;

/** A drawing waiting to become a file: the report to print, or the map to save as an image. */
type Job = { format: "pdf" | "png" | "svg"; layout: MapLayout; exportedAt: Date };

/** The Export button and its menu; `onError` shows a failure in the board header, and `null` clears it. */
export function ExportMenu({ board, onError }: { board: BoardOut; onError: (message: string | null) => void }) {
  const { config } = useSession();
  const [open, setOpen] = useState(false);
  const [alignEnd, setAlignEnd] = useState(false);
  const [busy, setBusy] = useState(false);
  const [job, setJob] = useState<Job | null>(null);
  const [snowflake, setSnowflake] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return undefined;
    root.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    const onPointer = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    return () => document.removeEventListener("pointerdown", onPointer);
  }, [open]);

  const finish = useCallback(
    (error?: unknown) => {
      setJob(null);
      setBusy(false);
      if (error !== undefined) onError(errorMessage(error));
    },
    [onError],
  );

  const start = async (format: Format) => {
    setOpen(false);
    trigger.current?.focus();
    onError(null);
    if (format === "snowflake") {
      setSnowflake(true);
      return;
    }
    setBusy(true);
    try {
      if (format === "markdown") {
        saveFile(await api.report(board.id), `${fileBase(board.title)} threat model.md`);
        setBusy(false);
        return;
      }
      if (board.map === null) throw new Error("This board has no map yet, so there is nothing to export.");
      // A ready board whose stored analysis no longer loads comes without one, and a job below draws only with it.
      if (board.analysis === null) throw new Error("This board has no threat model yet, so there is nothing to export.");
      const layouts = await layOutBoth(board.map);
      const direction = useBoardUi.getState().direction ?? pickDirection(layouts, FALLBACK_VIEW.width, FALLBACK_VIEW.height);
      setJob({ format, layout: layouts[direction], exportedAt: new Date() });
    } catch (caught) {
      finish(caught);
    }
  };

  const show = () => {
    const left = trigger.current?.getBoundingClientRect().left ?? 0;
    setAlignEnd(left + MENU_WIDTH > document.documentElement.clientWidth - 16);
    setOpen(true);
  };

  const onMenuKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const items = [...(root.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])];
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    const focus = (index: number) => {
      event.preventDefault();
      items[(index + items.length) % items.length]?.focus();
    };
    if (event.key === "ArrowDown") focus(at + 1);
    else if (event.key === "ArrowUp") focus(at - 1);
    else if (event.key === "Home") focus(0);
    else if (event.key === "End") focus(items.length - 1);
    else if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
      trigger.current?.focus();
    } else if (event.key === "Tab") setOpen(false);
  };

  const map = board.map;
  const analysis = board.analysis;
  return (
    <div className="export-menu" ref={root}>
      <button
        ref={trigger}
        type="button"
        className="btn btn-sm"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        // Not `disabled`: that would drop keyboard focus while the file is being made.
        aria-disabled={busy}
        onClick={() => {
          if (open) setOpen(false);
          else if (!busy) show();
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" && !open && !busy) {
            event.preventDefault();
            show();
          }
        }}
      >
        {busy ? <span className="spinner" aria-hidden="true" /> : <DownloadIcon />} Export
      </button>
      {open && (
        <div
          id={menuId}
          role="menu"
          aria-label="Export this board"
          className={`export-pop ${alignEnd ? "is-end" : ""}`}
          onKeyDown={onMenuKey}
        >
          {CHOICES.map((choice) => (
            <button
              key={choice.format}
              type="button"
              role="menuitem"
              tabIndex={-1}
              className="export-item"
              onClick={() => void start(choice.format)}
            >
              <span className="export-item-title">{choice.title}</span>
              <span className="export-item-hint">{choice.hint}</span>
            </button>
          ))}
        </div>
      )}
      {snowflake && (
        <SnowflakeDialog
          boardId={board.id}
          onClose={() => {
            setSnowflake(false);
            trigger.current?.focus();
          }}
        />
      )}
      {job &&
        map &&
        analysis &&
        createPortal(
          job.format === "pdf" ? (
            <PrintJob
              board={board}
              map={map}
              analysis={analysis}
              job={job}
              appName={config.app_name}
              onPrinting={() => setBusy(false)}
              onDone={finish}
            />
          ) : (
            <ImageJob board={board} map={map} analysis={analysis} job={job} onDone={finish} />
          ),
          document.body,
        )}
    </div>
  );
}

interface JobProps {
  board: BoardOut;
  map: SystemMap;
  analysis: ThreatAnalysis;
  job: Job;
  onDone: (error?: unknown) => void;
}

// How long a browser may take to start printing before the report says it never did.
const PRINT_START_MS = 1500;

// The report is mounted beside the app and printed alone. Browsers that open the dialog
// without blocking print what is on the page when it opens, so the report stays mounted
// until `afterprint` says the dialog has closed.
function PrintJob({ board, map, analysis, job, appName, onPrinting, onDone }: JobProps & { appName: string; onPrinting: () => void }) {
  useEffect(() => {
    let cancelled = false;
    let started = false;
    let timer = 0;
    const title = document.title;
    const began = () => {
      started = true;
    };
    const closed = () => {
      document.title = title;
      onDone();
    };
    const run = async () => {
      await document.fonts.ready;
      await new Promise((resolve) => requestAnimationFrame(resolve));
      if (cancelled) return;
      // The dialog offers the page title as the file name.
      document.title = `${fileBase(board.title)} threat model`;
      window.addEventListener("beforeprint", began, { once: true });
      window.addEventListener("afterprint", closed, { once: true });
      window.print();
      onPrinting();
      // Some embedded browsers have no print dialog, and clicking would otherwise seem to do nothing.
      timer = window.setTimeout(() => {
        if (!started && !cancelled) {
          onDone(new Error("No print dialog opened. Open this board in Chrome, Edge, Firefox or Safari to save the PDF."));
        }
      }, PRINT_START_MS);
    };
    run().catch((error: unknown) => {
      if (!cancelled) onDone(error);
    });
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      window.removeEventListener("beforeprint", began);
      window.removeEventListener("afterprint", closed);
      document.title = title;
    };
    // One print per job: the job object is new for every export.
  }, [job]);

  return <PaperReport board={board} map={map} analysis={analysis} layout={job.layout} appName={appName} exportedAt={job.exportedAt} />;
}

// The map is drawn off screen in the page's own theme, then copied into a file with its styles
// and fonts inlined, so the file matches the board whatever opens it.
function ImageJob({ board, map, analysis, job, onDone }: JobProps) {
  const stage = useRef<HTMLDivElement>(null);
  const label = `${board.title}: data flow diagram with threats pinned`;

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      await document.fonts.ready;
      const svg = stage.current?.querySelector("svg");
      if (cancelled || !stage.current || !svg) return;
      const background = getComputedStyle(stage.current).getPropertyValue("--board").trim() || "white";
      const text = await standaloneSvg(svg, label, background);
      const name = `${fileBase(board.title)} map`;
      const box = svg.viewBox.baseVal;
      const file = job.format === "svg" ? new Blob([text], { type: "image/svg+xml" }) : await svgToPng(text, box.width, box.height);
      if (cancelled) return;
      saveFile(file, `${name}.${job.format}`);
      onDone();
    };
    run().catch((error: unknown) => {
      if (!cancelled) onDone(error);
    });
    return () => {
      cancelled = true;
    };
    // One file per job: the job object is new for every export.
  }, [job]);

  return (
    <div ref={stage} className="export-stage" aria-hidden="true">
      <MapPicture
        map={map}
        layout={job.layout}
        threats={analysis.threats}
        exposure={board.exposure}
        crossings={board.crossings}
        label={label}
      />
    </div>
  );
}
