# Demo

A 30 second, click to play walkthrough of ThreatViz Defend for the pitch. A Claude Code session on the left builds an app, the ThreatViz hook posts each git diff, and the board on the right draws the threat model, pins the threats, updates when the code changes, and asks you to defend it by text or voice.

It is a scripted animation, separate from the app: it calls no API, and nothing in `Dockerfile` or `.do/app.yaml` ships it. The map, threats and question come from the app's built-in Inbox Helper example.

## Run it

Open `demo/index.html` in a browser. There is no build step and no server to start. To serve it instead:

```sh
python3 -m http.server 4317 --directory demo
```

## Controls

| Key | Action |
|---|---|
| Space | Play or pause |
| ← → | Previous or next chapter |
| 1 to 7 | Jump to a chapter |
| R | Restart |
| H | Hide the controls |
| F | Full screen |

The speed button cycles from 0.75x to 2x. At 1x the story runs about 30 seconds, at 1.5x about 20, at 2x about 15.

## Record it

Open `index.html?autoplay&clean` full screen, or in a 1600 by 900 window, and screen record. Add `&speed=1.5` for the short cut.

## Change it

The story lives in `demo.js`: `PROMPTS`, `CAPTIONS`, the map in `NODES`, `BOUNDS` and `FLOWS`, `THREATS`, and `run`, which plays the chapters in order. `PACE` scales every wait at once.

The fonts in `fonts/` are Caveat, Instrument Sans and IBM Plex Mono, under the SIL Open Font License, with their licenses beside them.
