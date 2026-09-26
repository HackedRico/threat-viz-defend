# Diagrams

The spoke that turns a board's map into the whiteboard people read. Owner: MD. It touches the core engine at one seam: the map in `BoardOut` going in, and the map prompt that shapes it ([docs/team.md](../../../docs/team.md)). The root [AGENTS.md](../../../AGENTS.md) holds the rules that apply everywhere.

## How a map becomes a drawing

1. **The model drafts the map** on the server from `DRAFT_MAP_SYSTEM` in `api/app/analysis/prompts.py`. Its rules decide how many nodes there are (6 to 14), what counts as a trust boundary, and when small parts merge. `sanitize_map` in `api/app/domain/rules.py` then caps sizes (30 nodes, 60 flows, 10 boundaries) and clips labels. Most "the diagram is too busy" problems start here, not in the canvas.
2. **ELK lays it out** in the browser. `toElkGraph` in `layout.ts` sizes each node from its text (`nodeSize`), nests nodes inside their boundary, and asks for a layered, left to right, orthogonal layout; `readLayout` flattens ELK's nested coordinates into absolute boxes and routes. `useMapLayout.ts` loads ELK only on first use and reruns it only when the map's structure changes (`layoutKey`), not when a flag or evidence text changes.
3. **The canvas draws it.** `MapCanvas.tsx` renders boundaries, nodes and flows as SVG from the layout, then layers on threat pins (`pins.ts`), lethal trifecta rings, crossing flows and highlights. `shapes.ts` produces the hand-drawn outlines with roughjs path data only, seeded by id so shapes do not shimmer between renders. Flow labels are placed by `placeLabels` in `layout.ts`, not by ELK, which doubled the map's width when it placed them.
4. **Everything around it**: `Inspector.tsx` and `mapEdit.ts` edit a draft map, `mapDiff.ts` marks what changed since `previous_map`, `MapLegend.tsx` explains every mark, and `store.ts` holds what is selected or lit, so the quiz, the ask bar, attack paths and the voice coach can all light the map.

## Levers for better diagrams

| To change | Edit | Coordinate with |
|---|---|---|
| What the map contains: granularity, boundaries, naming | `DRAFT_MAP_SYSTEM` and the field descriptions in `api/app/domain/models.py` | Ricky approves: the prompt and schema are seams |
| Spacing, direction, routing | `SPACING` and the options in `toElkGraph` in `layout.ts` | nobody |
| Node sizes and label fitting | `nodeSize`, `flowLabelSize`, the width limits in `layout.ts` | nobody |
| Look and feel | `shapes.ts`, `MapCanvas.css`, tokens in `web/src/styles/tokens.css` | nobody; tokens affect every screen |
| A new mark on the map from the rules | a field on `BoardOut` in `api/app/schemas.py`, then `npm run gen:api` | Ricky adds the field |

## Known problems worth your time

- **Wide maps at laptop width.** The example lays out about 1800 by 400 pixels. The opening view fits the whole map only when that stays at 55% zoom or more; otherwise it opens at 55% on the worst threat. A taller layout, grouping, or collapsing a boundary would help.
- **Busy boundaries.** The backend boundary holds most nodes, so its flows bunch together. Ordering, port placement or a better prompt for splitting zones are all fair game.
- **Overlays and the opening view.** The fit and the opening view center on the whole canvas, but the brief and the map key cover its left edge, so the worst threat can open under the brief. Fitting to the canvas minus the notes column would fix it.
- **Label clipping.** Long flow labels are cut at 28 characters (`FLOW_LABEL_MAX`), and tech lines at 30.

## Rules for this area

- The drawing must read without color: every severity has a shape and text as well, and the legend covers every mark.
- Every element stays focusable and selects on Enter; pan and zoom work from the keyboard.
- Model text renders as SVG or React text only.
- ELK stays out of the first bundle: import it only through `useMapLayout.ts`.
- Layout and placement logic lives in plain `.ts` files with tests. `layout.test.ts` already checks that labels never cover nodes or each other and that the map stays wide rather than tall; keep those passing and add a test for each new rule.

## Checking your work

```bash
npm run typecheck && npm test && npm run build
```

Then look at it: `./scripts/dev.sh` from the repo root, sign in with the development account from `.env`, and open "Example: Inbox Helper". It has 12 nodes, 18 flows, two boundaries, 7 threats and a lethal trifecta, so it exercises every mark. Check it in light and dark, at a laptop width and wide, and in review mode after a hand edit so the diff marks show.

The example is hand written and a model's board is not, so never tune a change to the example alone. Every overlay and every line of copy has to hold on a board with no AI part, no store, a taller map and a verdict three times as long. The starter questions and the brief read the board's own parts for that reason.
