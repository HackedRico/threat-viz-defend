import { useTheme } from "./useTheme.ts";
import "./Mascot.css";

// =============================================================================
// Module Overview
// =============================================================================
// Dawg, the hackUMBC theme's pixel guard dog, drawn from the ASCII sprite
// below so anyone can edit it by eye. Each letter is one pixel; the eyes and
// tail sit on their own layers so they can blink and wag. Dawg appears only
// while the hackUMBC theme is on, so every caller can place it freely.

// K outline, D ear, F fur, L cream, W eye glint, E eye, N nose, T tongue, G collar, S tag; t and k are the tail.
const SPRITE = [
  "......KKKKKKKKKKKK..........",
  "....KKFFFFFFFFFFFFKK........",
  "...KDKFFFFFFFFFFFFKDK.......",
  "..KDDKFFFFFFFFFFFFKDDK......",
  ".KDDDKFFFFFFFFFFFFKDDDK.....",
  ".KDDDKFFWEFFFFEWFFKDDDK.....",
  ".KDDDKFFEEFFFFEEFFKDDDK.....",
  ".KDDDKFFFFLLLLFFFFKDDDK.....",
  ".KDDKFFFLLLNNLLLFFFKDDK.....",
  "..KDKFFLLLLNNLLLLFFKDK......",
  "..KKKFFLKLLLLLLKLFFKKK......",
  "....KFFLLKTTTTKLLFFK........",
  ".....KKLLLKTTKLLLKK.........",
  "......KKGGGGGGGGKK......kkk.",
  ".....KFFGGGSSGGGFFK.....ktk.",
  "....KFFFLLLSSLLLFFFK...kktk.",
  "...KFFFFLLLLLLLLFFFFK.kkttk.",
  "...KFFFFLLLLLLLLFFFFKkkttkk.",
  "..KFFFFFFLLLLLLFFFFFFKttkk..",
  "..KFFFFKFFLLLLFFKFFFFKtkk...",
  "..KFFFFKFFFKKFFFKFFFFKkk....",
  "..KFFFFKLLLKKLLLKFFFFK......",
  ".KKKKKKKKKKKKKKKKKKKKKK.....",
];

// A separate overlay, so the cool mood reuses the sprite instead of keeping a second copy of it.
const SHADES = [
  "",
  "",
  "",
  "",
  "",
  "......KKKKKKKKKKKK",
  ".......KgKK..KgKK",
  "........KK....KK",
];

const COLORS: Record<string, string> = {
  K: "#1a1208",
  k: "#1a1208",
  D: "#7a4a22",
  F: "#d4913f",
  t: "#d4913f",
  L: "#f6ddb0",
  W: "#ffffff",
  E: "#1a1208",
  N: "#1a1208",
  T: "#ff7a8a",
  G: "#fdb515",
  S: "#fff1b8",
  g: "#fdb515",
};

const EYES = new Set(["W", "E"]);
const TAIL = new Set(["t", "k"]);

type Run = { x: number; y: number; width: number; color: string };

/** Horizontal runs of one color, so the sprite draws with a few dozen rects instead of hundreds. */
function runs(rows: string[], keep: (cell: string) => boolean): Run[] {
  const found: Run[] = [];
  rows.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      const cell = row[x]!;
      if (cell === "." || !keep(cell)) {
        x += 1;
        continue;
      }
      let end = x + 1;
      while (end < row.length && row[end] === cell) end += 1;
      found.push({ x, y, width: end - x, color: COLORS[cell]! });
      x = end;
    }
  });
  return found;
}

const BODY = runs(SPRITE, (cell) => !EYES.has(cell) && !TAIL.has(cell));
const EYE_RUNS = runs(SPRITE, (cell) => EYES.has(cell));
const TAIL_RUNS = runs(SPRITE, (cell) => TAIL.has(cell));
const SHADE_RUNS = runs(SHADES, () => true);

function Rects({ items }: { items: Run[] }) {
  return items.map((run) => (
    <rect key={`${run.x},${run.y}`} x={run.x} y={run.y} width={run.width} height={1} fill={run.color} />
  ));
}

/** How Dawg looks: at ease, in shades, or on alert with a fast wag. */
export type MascotMood = "idle" | "cool" | "alert";

/** Dawg, shown only in the hackUMBC theme; `bubble` adds a speech bubble. */
export function Mascot({
  mood = "idle",
  bubble,
  className = "",
}: {
  mood?: MascotMood;
  bubble?: string;
  className?: string;
}) {
  const theme = useTheme((state) => state.theme);
  if (theme !== "umbc") return null;
  return (
    <div className={`mascot is-${mood} ${className}`} aria-hidden="true">
      {bubble && <span className="mascot-bubble">{bubble}</span>}
      <svg className="mascot-sprite" viewBox="0 0 28 23" shapeRendering="crispEdges">
        <g className="mascot-tail">
          <Rects items={TAIL_RUNS} />
        </g>
        <g className="mascot-body">
          <Rects items={BODY} />
          <g className="mascot-eyes">
            <Rects items={EYE_RUNS} />
          </g>
          {mood === "cool" && <Rects items={SHADE_RUNS} />}
        </g>
      </svg>
    </div>
  );
}
