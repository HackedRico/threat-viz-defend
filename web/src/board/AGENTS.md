# Diagrams

The spoke that turns a board's map into the whiteboard people read. Owner: MD. It touches the core engine at one seam: the map in `BoardOut` going in, and the map prompt that shapes it ([docs/team.md](../../../docs/team.md)). The root [AGENTS.md](../../../AGENTS.md) holds the rules that apply everywhere.

The target is a map a reviewer checks in under five minutes, the review step of the [OWASP threat modeling cheat sheet](https://cheatsheetseries.owasp.org/cheatsheets/Threat_Modeling_Cheat_Sheet.html): trust boundaries, flows, stores, processes and outside parties stand out, and nothing else competes with them.

## How a map becomes a drawing

1. **The model drafts the map** on the server from `DRAFT_MAP_SYSTEM` in `api/app/analysis/prompts.py`. Both workflows run through it: material a person adds, and a coding agent's diff applied to the current map. Its rules set the size (6 to 14 nodes, at most 20 flows), the names (under 24 characters, flow labels a verb phrase of 1 to 3 words), what counts as a trust boundary, and stable ids across updates. `sanitize_map` in `api/app/domain/rules.py` then caps sizes (30 nodes, 60 flows, 10 boundaries) and clips labels. Most "the diagram is too busy" problems start here, not in the canvas.
2. **ELK lays it out twice** in the browser. `useMapLayout.ts` loads ELK on first use and calls `layOutMap` in `layout.ts` once top to bottom and once left to right, again only when the structure changes (`layoutKey`). `layOutMap` runs these in order:
   - `toElkGraph` sizes nodes by kind (`nodeSize`), nests them in their boundary, and hands ELK one edge per **track**: every flow between the same two nodes, pointed away from where data enters the map. Two opposite flows given to ELK as a cycle make it draw the reversed one as a loop around the whole map; that loop was most of the old clutter.
   - `splitTracks` gives each flow its own **lane** on its track, each direction keeping to its right.
   - `placeLabels` sets flow labels clear of nodes, other lines, other labels and the top right corner where pins land; a flow sharing a track labels its outer side. Then boundary names slide along their top band to a spot no line crosses.
   - `layoutProblems` judges the result: nodes nearer than `MIN_CLEARANCE` (40px) or colliding labels. A cramped layout is laid out again with every gap spread a quarter wider (`SPREAD`), and the least cramped try wins.
3. **The canvas draws it.** `MapCanvas.tsx` picks the direction that shows the map larger in its space (`pickDirection`), again whenever the canvas changes shape, until the reader pans, zooms or turns the map. A new map keeps the direction, so an agent's update never turns the board around under the reader. It renders boundaries, flows, boundary names, nodes, then threat pins (`pins.ts`), so names and pins sit over lines. `shapes.ts` produces the hand-drawn outlines with roughjs path data only, seeded by id so shapes do not shimmer between renders.
4. **Everything around it**: `Inspector.tsx` shows the selected node or flow in the side panel, never over the canvas, and with `mapEdit.ts` edits a draft map, `mapDiff.ts` marks what changed since `previous_map`, `MapLegend.tsx` explains every mark, and `store.ts` holds what is selected or lit, so the quiz, the ask bar, attack paths and the voice coach can all light the map.
5. **Exports draw the same marks.** `MapScene` in `MapCanvas.tsx` draws every mark for the canvas and for `MapPicture.tsx`, a still copy at full size. `ExportMenu.tsx` lays the map out again the way round the canvas shows it (`direction` in `store.ts`) and hands the picture to `PaperReport.tsx`, which the browser prints to PDF, or to `exportImage.ts`, which writes the PNG or SVG file. A change to a shape reaches every export with no further work.

## Levers for better diagrams

| To change | Edit | Coordinate with |
|---|---|---|
| What the map contains: granularity, boundaries, naming | `DRAFT_MAP_SYSTEM` and the field descriptions in `api/app/domain/models.py`, then `npm run gen:api` | Ricky approves: the prompt and schema are seams |
| Spacing, routing, retries | `SPACING`, `SPREAD`, `LANE_GAP` and the options in `toElkGraph` in `layout.ts` | nobody |
| Node sizes and label fitting | `NODE_BASE`, `nodeText`, `flowLabelSize` and the width limits in `layout.ts` | nobody |
| Where labels and pins go | the costs in `placeLabels`, `PIN_CORNER` in `layout.ts`, and `pins.ts` | nobody |
| Which direction opens, and when the opening view stops fitting | `pickDirection` in `layout.ts`, `READABLE_ZOOM` in `MapCanvas.tsx` | nobody |
| Look and feel | `shapes.ts`, `MapCanvas.css`, tokens in `web/src/styles/tokens.css` | nobody; tokens affect every screen |
| A new mark on the map from the rules | a field on `BoardOut` in `api/app/schemas.py`, then `npm run gen:api` | Ricky adds the field |

## Gotchas

- **ELK swaps a boundary's minimum size top to bottom.** With `INCLUDE_CHILDREN`, ELK applies a compound node's `elk.nodeSize.minimum` before it turns a `DOWN` layout upright, so `toElkGraph` passes `(0, width)` in that direction. The boundary width test fails if an ELK upgrade changes this.
- **Labels are estimated, never measured.** Widths come from per-character constants for Caveat and Plex Mono, so layout stays testable in Node. A new font or size means new constants.
- **Selection means details in the panel.** `Workspace.tsx` lays the inspector over the panel's lists whenever `selected` names a node or flow, and shows a hidden panel for it. So anything that opens a list item must not select: pins, threat cards and the inspector's own threat links call `openThreat`, which lights the threat instead. The lists stay mounted and `inert` underneath; unmounting them would end a quiz or voice session every time someone clicks a node. For the same reason `ReadyPanel` keeps Defend mounted and `hidden` once it has been opened, since a pin switches the tabs to Threats.
- **Each drawing on a page needs its own marker ids.** Flows find their arrowheads by id, and an export's picture sits in the page beside the canvas, so `MapPicture` gives `ArrowMarkers` a prefix and `MapScene` the same one. A new marker, gradient or pattern needs the prefix too.
- **Image exports copy computed styles, not the stylesheet.** `exportImage.ts` writes each element's computed style onto it, so a style that moves, such as the trifecta ring's pulse, is caught mid state unless `.map-picture` holds it still. The PDF prints the same picture inside `.theme-light`, which `tokens.css` keeps in step with every theme.
- **Pins arrive after layout.** Threats are not known when ELK runs, so `placeLabels` keeps every node's top right corner free whether or not a pin lands there.

## Known problems worth your time

- **Laptop with the panel open.** The canvas there is about 1000 by 630, and the example fits at about 50% either way. Below 45% (`READABLE_ZOOM`) the opening view centers on the worst threat instead. Grouping or collapsing a boundary would help.
- **Left to right labels.** Level runs cross the narrow gaps between layers, where upright runs also pass, so a label there can sit on another flow's line. Top to bottom has room; the test for this runs top to bottom only.
- **Narrow boundaries top to bottom.** A one node boundary cannot dodge the flow entering its middle, so its name sits over that line; a halo in the board color breaks the line around the text.
- **Overlays and the opening view.** The fit and the opening view center on the whole canvas, but the brief covers its top and the map key its bottom left, so the worst threat can open under one of them. Fitting to the canvas minus those overlays would fix it.
- **Label clipping.** Flow labels are cut at 28 characters (`FLOW_LABEL_MAX`). Node names wrap onto two lines and are then cut at a word; tech lines are cut to the node's width.

## Rules for this area

- The drawing must read without color: every severity has a shape and text as well, and the legend covers every mark.
- Only a trust boundary is dashed, so a dashed line always means trust changes there ([DFD3](https://github.com/adamshostack/DFD3)). Mark anything else with weight, opacity or a ring.
- Every element stays focusable and selects on Enter; pan and zoom work from the keyboard.
- Model text renders as SVG or React text only.
- ELK stays out of the first bundle: `layout.ts` imports only its types and takes the engine as a `LayoutEngine`, and only `useMapLayout.ts` imports ELK itself.
- Layout and placement logic lives in plain `.ts` files with tests. `layout.test.ts` checks both directions for nesting, routes, clearance, lanes, label and name placement and pin corners; keep those passing and add a test for each new rule.

## Checking your work

```bash
npm run typecheck && npm test && npm run build
```

Then look at it: `./scripts/dev.sh` from the repo root, sign in with the development account from `.env`, and open "Example: Inbox Helper". It has 12 nodes, 18 flows in four two way pairs, two boundaries, 7 threats and a lethal trifecta, so it exercises every mark. Check it in the light, dark and hackUMBC themes, with the side panel open and closed, at a laptop width and wide, turned both ways, and in review mode after a hand edit so the diff marks and inferred outlines show. Then export it each way from **Export**: the PDF is always light, and the images follow the theme and the way the map is turned.

The example is hand written and a model's board is not, so never tune a change to the example alone. Every overlay and every line of copy has to hold on a board with no AI part, no store, a taller map and a verdict three times as long. The starter questions and the brief read the board's own parts for that reason.
