/* =============================================================================
   Module Overview
   =============================================================================
   Plays the demo: a Claude Code session builds an app, the ThreatViz hook
   posts each git diff, and the board draws, analyzes and updates the threat
   model while a pointer clicks through it. Every step waits on one clock, so
   pause, speed and chapter jumps act on the whole script. A jump replays the
   script instantly up to the chapter, with transitions off, which keeps the
   frame identical to watching it. The map, threats and question come from the
   app's built-in Inbox Helper example, so the story matches the product. */
(() => {
  "use strict";

  const STAGE_W = 1600;
  const STAGE_H = 900;
  // Scales every wait at 1x, so one number tunes the whole story to about 30 seconds.
  const PACE = 0.8;
  const NS = "http://www.w3.org/2000/svg";
  const params = new URLSearchParams(location.search);
  const stage = document.getElementById("stage");
  const template = stage.innerHTML;

  // ------------------------------------------------------------------ story

  const PROMPTS = [
    "Build an assistant that syncs my Gmail, triages mail with an AI agent and drafts replies",
    "Let the agent open links in emails before it summarizes them",
    "What did that change do to our threat model?",
  ];

  const CHAPTERS = ["Prompt", "Hook", "Map", "Threats", "Change", "Update", "Defend"];

  const CAPTIONS = [
    "You vibe code in Claude Code. ThreatViz is connected over MCP and a git hook.",
    "The change touches architecture, so the hook posts the git diff to your board.",
    "ThreatViz draws the system as a threat model, and every part cites its evidence.",
    "Rules pick what to check. The top threats pin to the parts they hit.",
    "Next prompt, next diff. Nobody has to remember to update the model.",
    "The map marks what changed, and Claude Code asks the board what it risked over MCP.",
    "Then defend it by text or voice. Backboard remembers what you missed last time.",
  ];

  // The Inbox Helper map in the viewBox's coordinates, as the agent builds it over two prompts.
  const NODES = [
    { id: "senders", kind: "external", label: "Email senders", x: 30, y: 20 },
    { id: "gmail", kind: "external", label: "Gmail API", tech: "Google", x: 275, y: 20 },
    { id: "user", kind: "external", label: "User", x: 520, y: 20 },
    { id: "web", kind: "process", label: "Web app", tech: "React", x: 520, y: 120 },
    { id: "sync", kind: "process", label: "Mail sync", tech: "worker", x: 30, y: 245 },
    { id: "db", kind: "store", label: "Postgres", tech: "mail, tokens", x: 285, y: 240, sensitive: true },
    { id: "api", kind: "process", label: "API", tech: "FastAPI", x: 520, y: 245 },
    { id: "queue", kind: "store", label: "Job queue", tech: "Redis", x: 40, y: 380 },
    { id: "agent", kind: "process", label: "Triage agent", tech: "tool calling", x: 275, y: 390, ai: true },
    { id: "openai", kind: "external", label: "OpenAI API", x: 275, y: 560, ai: true },
    { id: "website", kind: "external", label: "Any website", x: 520, y: 560, later: true },
  ];

  const BOUNDS = [
    { id: "browser", label: "BROWSER", x: 505, y: 92, w: 170, h: 91 },
    { id: "backend", label: "BACKEND", x: 15, y: 215, w: 660, h: 285 },
  ];

  // `x` marks a flow that crosses a trust boundary: the app draws those double and pink.
  const FLOWS = [
    { id: "f1", label: "email", from: [170, 44], to: [275, 44] },
    { id: "f2", label: "new mail", from: [300, 68], to: [140, 245], x: true },
    { id: "f3", label: "sign in", from: [590, 68], to: [590, 120], x: true, tag: [590, 80] },
    { id: "f4", label: "API calls", from: [590, 168], to: [590, 245], x: true, tag: [590, 199] },
    { id: "f5", label: "save mail", from: [170, 270], to: [285, 270] },
    { id: "f6", label: "queue triage", from: [100, 293], to: [100, 380] },
    { id: "f7", label: "triage job", from: [160, 414], to: [275, 414] },
    { id: "f8", label: "read mail", from: [345, 304], to: [345, 390] },
    { id: "f9", label: "summaries", from: [520, 270], to: [405, 270] },
    { id: "f10", label: "prompt", from: [345, 438], to: [345, 560], x: true, tag: [345, 525] },
    { id: "f11", label: "fetch_url", from: [415, 428], to: [560, 560], x: true, tag: [516, 520] },
  ];

  const THREATS = {
    T1: { sev: "critical", title: "A malicious email takes over the triage agent", stride: "Elevation of privilege", on: "Triage agent", at: [411, 392] },
    T2: { sev: "high", title: "fetch_url carries mail out in a link", stride: "Information disclosure", on: "Triage agent to Any website", at: [480, 462] },
    T4: { sev: "high", title: "Admin pages trust the ordinary session", stride: "Elevation of privilege", on: "API", at: [656, 250] },
    T6: { sev: "medium", title: "One env key unlocks every Gmail token", stride: "Information disclosure", on: "Postgres", at: [398, 248] },
    T7: { sev: "medium", title: "Email floods run up the model bill", stride: "Denial of service", on: "Triage agent to OpenAI API", at: [372, 552] },
  };

  const SEV = { critical: "Critical", high: "High", medium: "Medium" };

  // The order the first map draws in: each part, then the flows that reach it.
  const DRAW = [
    ["node", "senders", 110], ["node", "gmail", 110], ["flow", "f1", 130],
    ["node", "sync", 110], ["flow", "f2", 140],
    ["node", "db", 110], ["flow", "f5", 120],
    ["node", "queue", 100], ["flow", "f6", 120],
    ["node", "agent", 110], ["flow", "f7", 100], ["flow", "f8", 120],
    ["node", "openai", 100], ["flow", "f10", 130],
    ["node", "user", 100], ["node", "web", 100], ["flow", "f3", 110],
    ["node", "api", 110], ["flow", "f4", 110], ["flow", "f9", 320],
  ];

  const STATUS = {
    empty: "Waiting for a change",
    mapping: "Drawing the map",
    review: "Review the map",
    analyzing: "Finding threats",
    ready: "Ready to defend",
  };

  // ------------------------------------------------------------------ clock

  class Cancelled extends Error {}

  /**
   * Paces the script on one timeline. `vt` is virtual time, advanced each frame by the playback
   * speed; `cursor` is where the script has scheduled itself. Waits come due against `vt`, so a
   * slow frame lets several short waits land at once and the story keeps its timing.
   * `token` changes on every restart, which cancels the old run's waits.
   */
  const clock = { speed: 1, paused: false, token: 0, vt: 0, cursor: 0, start: 0, total: 1, chapter: -1, fastUntil: -1, measuring: false, waiters: [], marks: [] };

  /** Resolve after `ms` of script time, or reject once a restart has replaced run `token`. */
  function sleep(ms, token) {
    if (token !== clock.token) return Promise.reject(new Cancelled());
    clock.cursor += ms * PACE;
    if (clock.measuring || clock.chapter < clock.fastUntil) return Promise.resolve();
    const due = clock.cursor;
    if (due <= clock.vt) return Promise.resolve();
    return new Promise((resolve, reject) => clock.waiters.push({ due, token, resolve, reject }));
  }

  /** Resolve `ms` of script time from now without moving the script's own schedule, for side timers. */
  function sleepAside(ms, token) {
    if (token !== clock.token) return Promise.reject(new Cancelled());
    if (clock.measuring || clock.chapter < clock.fastUntil) return Promise.resolve();
    const due = clock.vt + ms * PACE;
    return new Promise((resolve, reject) => clock.waiters.push({ due, token, resolve, reject }));
  }

  let lastFrame = performance.now();

  /** Advance virtual time and release every wait that has come due. */
  function tick(now) {
    // A capped step means a hidden tab pauses the story instead of skipping it.
    const dt = Math.min(now - lastFrame, 100);
    lastFrame = now;
    if (!clock.paused && !clock.measuring) clock.vt += dt * clock.speed;
    const due = [];
    clock.waiters = clock.waiters.filter((w) => {
      if (w.token !== clock.token) {
        w.reject(new Cancelled());
        return false;
      }
      if (w.due <= clock.vt) {
        due.push(w);
        return false;
      }
      return true;
    });
    due.sort((x, y) => x.due - y.due).forEach((w) => w.resolve());
    if (!clock.measuring) {
      const done = Math.min(clock.vt, clock.cursor) - clock.start;
      document.getElementById("bar").style.width = `${Math.max(0, Math.min(100, (done / clock.total) * 100))}%`;
    }
    requestAnimationFrame(tick);
  }

  /** True while the script jumps ahead or measures, when nothing should animate. */
  const instant = () => clock.measuring || clock.chapter < clock.fastUntil;

  // ------------------------------------------------------------------ dom helpers

  const $ = (sel) => stage.querySelector(sel);
  const $$ = (sel) => [...stage.querySelectorAll(sel)];
  const esc = (text) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  /** Create an SVG element with attributes, appended to `parent`. */
  function el(tag, attrs, parent) {
    const node = document.createElementNS(NS, tag);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
    if (parent) parent.appendChild(node);
    return node;
  }

  /** Turn an element on after the browser has seen it off, so its transition runs. */
  function show(node) {
    void node.getBoundingClientRect();
    node.classList.add("on");
  }

  /** Where `node`'s center sits in stage pixels, whatever the stage's scale. */
  function centerOf(node) {
    const s = stage.getBoundingClientRect();
    const r = node.getBoundingClientRect();
    const k = s.width / STAGE_W;
    return { x: (r.left + r.width / 2 - s.left) / k, y: (r.top + r.height / 2 - s.top) / k };
  }

  // ------------------------------------------------------------------ map

  const NODE_W = 140;
  const NODE_H = 48;
  const STORE_W = 120;
  const STORE_H = 64;
  const LID = 9;

  const sizeOf = (n) => (n.kind === "store" ? { w: STORE_W, h: STORE_H } : { w: NODE_W, h: NODE_H });

  /** A small head and shoulders glyph, the app's mark for a party outside your control. */
  function person(x, y) {
    return `M${x + 6},${y + 5} m-3.6,0 a3.6,3.6 0 1,0 7.2,0 a3.6,3.6 0 1,0 -7.2,0 M${x},${y + 17} Q${x},${y + 10} ${x + 6},${y + 10} Q${x + 12},${y + 10} ${x + 12},${y + 17}`;
  }

  /** A rounded label chip above a node. */
  function chip(parent, cls, x, y, w, text) {
    const g = el("g", { class: cls }, parent);
    el("rect", { x, y, width: w, height: 14, rx: 7 }, g);
    el("text", { x: x + w / 2, y: y + 10.5 }, g).textContent = text;
  }

  function drawNode(n, parent) {
    const { w, h } = sizeOf(n);
    const g = el("g", { class: `node ${n.kind}`, "data-id": n.id }, parent);
    if (n.kind === "store") {
      const rx = w / 2;
      const body = `M${n.x},${n.y + LID} A${rx},${LID} 0 0 1 ${n.x + w},${n.y + LID} V${n.y + h - LID} A${rx},${LID} 0 0 1 ${n.x},${n.y + h - LID} Z`;
      el("path", { class: "n-shape", d: body, filter: "url(#rough)" }, g);
      el("ellipse", { class: "n-lid", cx: n.x + rx, cy: n.y + LID, rx, ry: LID, filter: "url(#rough)" }, g);
    } else {
      el("rect", { class: "n-shape", x: n.x, y: n.y, width: w, height: h, rx: n.kind === "external" ? 6 : 14, filter: "url(#rough)" }, g);
    }
    const outside = n.kind === "external";
    if (outside) el("path", { class: "n-glyph", d: person(n.x + 10, n.y + 10) }, g);
    const cx = n.x + w / 2 + (outside ? 8 : 0);
    const mid = n.kind === "store" ? n.y + h / 2 + LID / 2 : n.y + h / 2;
    const label = el("text", { class: "n-label", x: cx, y: n.tech ? mid + 2 : mid + 7 }, g);
    label.textContent = n.label;
    // Long names beside the person glyph would run into it at full size.
    if (outside && n.label.length > 11) label.setAttribute("style", "font-size:18px");
    if (n.tech) el("text", { class: "n-tech", x: cx, y: mid + 15 }, g).textContent = n.tech;
    if (n.ai) chip(g, "chip-ai", n.x + 8, n.y - 7, 22, "AI");
    if (n.sensitive) chip(g, "chip-sens", n.x + 10, n.y - 13, 58, "sensitive");
    if (n.later) chip(g, "chip-new", n.x + w - 42, n.y - 8, 34, "NEW");
  }

  function drawFlow(f, parent) {
    const g = el("g", { class: `flow${f.x ? " x" : ""}`, "data-id": f.id }, parent);
    const [ax, ay] = f.from;
    const [bx, by] = f.to;
    const a = Math.atan2(by - ay, bx - ax);
    // The line stops under the arrowhead so the tip stays sharp.
    const d = `M${ax},${ay} L${bx - 8 * Math.cos(a)},${by - 8 * Math.sin(a)}`;
    if (f.x) {
      el("path", { class: "f-path f-outer", d, pathLength: 1, filter: "url(#rough)" }, g);
      el("path", { class: "f-path f-inner", d, pathLength: 1, filter: "url(#rough)" }, g);
    } else {
      el("path", { class: "f-path f-main", d, pathLength: 1, filter: "url(#rough)" }, g);
    }
    const L = 11;
    const S = 5.5;
    const p1 = [bx - L * Math.cos(a) + S * Math.sin(a), by - L * Math.sin(a) - S * Math.cos(a)];
    const p2 = [bx - L * Math.cos(a) - S * Math.sin(a), by - L * Math.sin(a) + S * Math.cos(a)];
    el("path", { class: "f-head", d: `M${bx},${by} L${p1[0]},${p1[1]} L${p2[0]},${p2[1]} Z` }, g);
    const [tx, ty] = f.tag || [(ax + bx) / 2, (ay + by) / 2];
    const tw = f.label.length * 6.1 + 12;
    const tag = el("g", { class: "f-tag" }, g);
    el("rect", { x: tx - tw / 2, y: ty - 9, width: tw, height: 18, rx: 4 }, tag);
    el("text", { x: tx, y: ty + 3.5 }, tag).textContent = f.label;
  }

  function drawPin(id, t, parent) {
    const [x, y] = t.at;
    const g = el("g", { class: `pin sev-${t.sev}`, "data-threat": id }, parent);
    el("circle", { class: "p-halo", cx: x, cy: y, r: 17 }, g);
    if (t.sev === "high") el("path", { class: "p-mark", d: `M${x},${y - 13} L${x + 12.5},${y + 9} L${x - 12.5},${y + 9} Z` }, g);
    else el("circle", { class: "p-mark", cx: x, cy: y, r: 11 }, g);
    el("text", { x, y: t.sev === "high" ? y + 6.5 : y + 4 }, g).textContent = "";
  }

  /** Draw every part of the map hidden; the script turns pieces on. */
  function renderMap() {
    const map = $("#map");
    map.textContent = "";
    const defs = el("defs", {}, map);
    // Displacement noise gives the whiteboard wobble with no drawing library.
    const rough = el("filter", { id: "rough", filterUnits: "userSpaceOnUse", x: 0, y: 0, width: 680, height: 640 }, defs);
    el("feTurbulence", { type: "fractalNoise", baseFrequency: 0.035, numOctaves: 2, seed: 7, result: "noise" }, rough);
    el("feDisplacementMap", { in: "SourceGraphic", in2: "noise", scale: 2.4, xChannelSelector: "R", yChannelSelector: "G" }, rough);
    const layer = () => el("g", {}, map);
    const bounds = layer();
    const flows = layer();
    const nodes = layer();
    const ring = layer();
    const pins = layer();
    for (const b of BOUNDS) {
      const g = el("g", { class: "bound", "data-id": b.id }, bounds);
      el("rect", { class: "b-rect", x: b.x, y: b.y, width: b.w, height: b.h, rx: 16, filter: "url(#rough)" }, g);
      el("text", { class: "b-label", x: b.x + 12, y: b.y + 17 }, g).textContent = b.label;
    }
    for (const f of FLOWS) drawFlow(f, flows);
    for (const n of NODES) drawNode(n, nodes);
    const r = el("g", { class: "ring" }, ring);
    el("rect", { x: 265, y: 380, width: 160, height: 68, rx: 18, filter: "url(#rough)" }, r);
    el("text", { x: 258, y: 468 }, r).textContent = "lethal trifecta";
    for (const [id, t] of Object.entries(THREATS)) drawPin(id, t, pins);
  }

  const nodeEl = (id) => $(`.node[data-id="${id}"]`);
  const flowEl = (id) => $(`.flow[data-id="${id}"]`);
  const pinEl = (id) => $(`.pin[data-threat="${id}"]`);

  // ------------------------------------------------------------------ terminal

  function log(kind, html) {
    const line = document.createElement("div");
    line.className = `ln ${kind}`;
    line.innerHTML = html;
    $("#log").appendChild(line);
    show(line);
    const body = $("#termBody");
    body.scrollTop = body.scrollHeight;
    return line;
  }

  /** One builder per kind of transcript line Claude Code prints. */
  const term = {
    sys: (t) => log("sys", `<span class="gl">⎿</span> ${esc(t)}`),
    user: (t) => log("user", `<span class="gt">&gt;</span> ${esc(t)}`),
    say: (t) => log("say", `<span class="dw">●</span> ${esc(t)}`),
    tool: (name, arg) => log("tool", `<span class="dg">●</span> <b>${esc(name)}</b>(${esc(arg)})`),
    result: (t) => log("out", `<span class="gl">⎿</span> ${esc(t)}`),
    done: (t) => log("done", `✓ ${esc(t)}`),
    hook: (t) => log("hook", `<span class="gl">⎿</span> <span class="hk">ThreatViz hook</span> ${esc(t)}`),
    mcp: (tool, args) => log("mcp", `<span class="dt">●</span> <b>threatviz · ${esc(tool)}</b>(${esc(args)})`),
    spin: (t) => log("spin", `<span class="star">✻</span> ${esc(t)}… <span class="gl">(esc to interrupt)</span>`),
  };

  // ------------------------------------------------------------------ app

  function setStatus(name) {
    const s = $("#status");
    s.className = `status s-${name}`;
    s.textContent = STATUS[name];
  }

  function showView(name) {
    for (const v of $$(".view")) v.classList.toggle("on", v.classList.contains(`v-${name}`));
    $("#tabThreats").classList.toggle("on", name !== "defend");
    $("#tabDefend").classList.toggle("on", name === "defend");
  }

  function setReview(title, body, items) {
    $("#rvTitle").textContent = title;
    $("#rvBody").textContent = body;
    $("#rvChanges").innerHTML = items.map(([cls, head, text]) => `<li class="${cls}"><span>${esc(head)}</span>${esc(text)}</li>`).join("");
  }

  function threatCard(id) {
    const t = THREATS[id];
    const card = document.createElement("div");
    card.className = `tcard sev-${t.sev}`;
    card.dataset.id = id;
    card.innerHTML =
      `<div class="tc-top"><span class="pinmark"></span><span class="tc-title">${esc(t.title)}</span></div>` +
      `<div class="tc-meta"><span class="chip sev">${SEV[t.sev]}</span><span class="chip">${esc(t.stride)}</span></div>` +
      `<div class="tc-on">on ${esc(t.on)}</div>`;
    return card;
  }

  /** Put the list in `order` and number every card and pin by rank, as the app does. */
  function rankThreats(order) {
    const list = $("#tlist");
    const have = new Map($$(".tcard").map((c) => [c.dataset.id, c]));
    order.forEach((id, i) => {
      const card = have.get(id) || threatCard(id);
      card.querySelector(".pinmark").textContent = String(i + 1);
      list.appendChild(card);
      pinEl(id).querySelector("text").textContent = String(i + 1);
    });
    $("#tcount").textContent = String(order.length);
  }

  // ------------------------------------------------------------------ the script

  /** Build one run of the script, bound to restart `token`. */
  function script(token) {
    const wait = (ms) => sleep(ms, token);
    let toastSeq = 0;

    /** Guard a timer so a restart never lets an old run touch the new frame. */
    const later = (ms, fn) => setTimeout(() => { if (token === clock.token) fn(); }, instant() ? 0 : ms / clock.speed);

    function chapter(i) {
      if (token !== clock.token) throw new Cancelled();
      clock.chapter = i;
      if (clock.measuring) clock.marks[i] = clock.cursor;
      if (clock.fastUntil >= 0 && i >= clock.fastUntil) {
        clock.fastUntil = -1;
        clock.vt = clock.cursor;
        // Settle every jumped-to state before transitions come back on.
        void stage.offsetWidth;
        stage.classList.remove("instant");
      }
      markChapter(i);
      if (!CAPTIONS[i]) return;
      const cap = $("#caption");
      const set = () => {
        $("#capNum").textContent = String(i + 1);
        $("#capText").textContent = CAPTIONS[i];
        cap.classList.remove("swap");
      };
      if (instant()) set();
      else {
        cap.classList.add("swap");
        later(170, set);
      }
    }

    async function type(text) {
      const box = $("#promptText");
      box.textContent = "";
      for (const ch of text) {
        box.textContent += ch;
        await wait(ch === " " ? 20 : 14);
      }
    }

    async function submit() {
      await wait(280);
      const box = $("#promptText");
      const text = box.textContent;
      box.textContent = "";
      term.user(text);
      await wait(260);
    }

    async function spinner(label, ms) {
      const line = term.spin(label);
      await wait(ms);
      line.remove();
    }

    async function click(target) {
      const cursor = $("#cursor");
      const { x, y } = centerOf(target);
      cursor.style.transform = `translate(${x - 6}px, ${y - 3}px)`;
      cursor.classList.add("on");
      await wait(540);
      cursor.classList.remove("click");
      void cursor.offsetWidth;
      cursor.classList.add("click");
      target.classList.add("pressed");
      later(170, () => target.classList.remove("pressed"));
      await wait(200);
    }

    function toast(html) {
      const t = $("#toast");
      t.innerHTML = html;
      show(t);
      const mine = ++toastSeq;
      sleepAside(2600, token).then(() => { if (mine === toastSeq) t.classList.remove("on"); }, () => {});
    }

    /** Fly a git diff chip from the hook's line in the terminal to the board's status. */
    async function fly(fromLine, label) {
      const packet = $("#packet");
      const a = centerOf(fromLine.querySelector(".hk"));
      const b = centerOf($("#status"));
      packet.textContent = label;
      packet.style.transition = "none";
      packet.style.transform = `translate(${a.x}px, ${a.y}px) translate(-50%, -50%) scale(0.7)`;
      void packet.offsetWidth;
      packet.style.transition = "";
      packet.classList.add("on");
      packet.style.transform = `translate(${a.x}px, ${a.y}px) translate(-50%, -50%) scale(1)`;
      await wait(240);
      packet.style.transform = `translate(${b.x}px, ${b.y}px) translate(-50%, -50%) scale(0.85)`;
      await wait(820);
      packet.classList.remove("on");
      const status = $("#status");
      status.classList.add("bump");
      later(260, () => status.classList.remove("bump"));
    }

    async function revealThreats(ids, fresh) {
      for (const id of ids) {
        show(pinEl(id));
        const card = $(`.tcard[data-id="${id}"]`);
        if (fresh) {
          card.classList.add("fresh");
          pinEl(id).classList.add("hot");
        }
        show(card);
        await wait(170);
      }
    }

    return async function run() {
      // 1. The prompt
      chapter(0);
      await wait(300);
      term.sys("MCP   threatviz · connected · 7 tools");
      await wait(200);
      term.sys("Hook  ThreatViz runs when a turn ends");
      await wait(450);
      await type(PROMPTS[0]);
      await submit();
      term.say("I'll set up an API, a mail sync worker, a Redis job queue and a triage agent on OpenAI tool calling.");
      await wait(380);
      await spinner("Building", 650);
      for (const [file, result] of [
        ["api/main.py", "Wrote 142 lines"],
        ["worker/sync.py", "Wrote 96 lines"],
        ["agent/triage.py", "Wrote 118 lines"],
        ["docker-compose.yml", "Wrote 34 lines"],
      ]) {
        term.tool("Write", file);
        await wait(120);
        term.result(result);
        await wait(120);
      }
      term.done("Done. 14 files changed, tests pass.");
      await wait(420);

      // 2. The hook
      chapter(1);
      const hook = term.hook('posted git diff · 14 files → board "Inbox Helper"');
      await wait(300);
      await fly(hook, "git diff · 14 files");
      setStatus("mapping");
      toast("Claude Code sent a change · <b>14 files</b>");
      await wait(350);

      // 3. The map
      chapter(2);
      $("#empty").classList.add("gone");
      for (const b of $$(".bound")) show(b);
      await wait(250);
      for (const [kind, id, ms] of DRAW) {
        show(kind === "node" ? nodeEl(id) : flowEl(id));
        await wait(ms);
      }
      setStatus("review");
      showView("review");
      await wait(700);
      await click($("#confirm"));

      // 4. The threats
      chapter(3);
      setStatus("analyzing");
      showView("threats");
      await wait(850);
      rankThreats(["T1", "T4", "T6", "T7"]);
      await revealThreats(["T1", "T4", "T6", "T7"], false);
      setStatus("ready");
      await wait(450);
      await click(pinEl("T1"));
      nodeEl("agent").classList.add("focus");
      showView("detail");
      await wait(1900);
      nodeEl("agent").classList.remove("focus");
      showView("threats");
      await wait(300);

      // 5. The next change
      chapter(4);
      await type(PROMPTS[1]);
      await submit();
      term.say("I'll give the triage agent a fetch_url tool.");
      await wait(300);
      await spinner("Editing", 500);
      term.tool("Update", "agent/tools.py");
      await wait(150);
      term.result("Added fetch_url(url)");
      await wait(180);
      term.tool("Update", "agent/triage.py");
      await wait(150);
      term.result("Registered the tool with the agent");
      await wait(200);
      term.done("Done. 2 files changed.");
      await wait(300);
      const hook2 = term.hook('posted git diff · 2 files → board "Inbox Helper"');
      await wait(250);
      await fly(hook2, "git diff · 2 files");
      setStatus("mapping");
      toast("Claude Code sent a change · <b>2 files</b>");
      await wait(350);

      // 6. The map updates
      chapter(5);
      const site = nodeEl("website");
      site.classList.add("added");
      show(site);
      await wait(260);
      const fetch = flowEl("f11");
      fetch.classList.add("added");
      show(fetch);
      await wait(700);
      setReview("Claude Code changed the map", "Marked in green on the map. Confirm it to see what the change risks.", [
        ["add", "Part added", "Any website"],
        ["add", "Flow added", "Triage agent to Any website: fetch_url"],
        ["ev", "Evidence", "agent/tools.py: def fetch_url(url)"],
      ]);
      setStatus("review");
      showView("review");
      await wait(800);
      await click($("#confirm"));
      site.classList.remove("added");
      fetch.classList.remove("added");
      setStatus("analyzing");
      showView("threats");
      await wait(650);
      show($(".ring"));
      rankThreats(["T1", "T2", "T4", "T6", "T7"]);
      await revealThreats(["T2"], true);
      setStatus("ready");
      toast("New threat · <b>fetch_url carries mail out in a link</b>");
      await wait(600);
      await type(PROMPTS[2]);
      await submit();
      term.mcp("ask_board", '"Inbox Helper", "What did the last change risk?"');
      await wait(550);
      term.result("fetch_url completes a lethal trifecta on the triage agent: private mail, untrusted email and a way out.");
      await wait(350);
      term.result("New high threat: fetch_url carries mail out in a link.");
      await wait(380);
      term.say("Fix first: allowlist the domains fetch_url can reach. Want me to add that?");
      await wait(800);

      // 7. Defend it
      chapter(6);
      pinEl("T2").classList.remove("hot");
      await click($("#tabDefend"));
      showView("defend");
      await wait(450);
      for (const k of ["A", "C"]) {
        const opt = $(`.opt[data-k="${k}"]`);
        await click(opt);
        opt.classList.add("picked");
      }
      await click($("#submit"));
      for (const opt of $$(".opt")) opt.classList.add(["A", "C"].includes(opt.dataset.k) ? "right" : "dim");
      show($("#result"));
      $("#mastery").textContent = "100%";
      $("#masteryText").textContent = "1 of 7 answered, 1 correct";
      $("#mbar").style.width = "14%";
      await wait(800);
      $("#qblock").classList.add("done");
      await click($("#modeVoice"));
      $("#modeType").classList.remove("on");
      $("#modeVoice").classList.add("on");
      show($("#voice"));
      $("#wave").classList.add("on");
      await wait(350);
      show($("#coachQ"));
      await wait(850);
      show($("#youLine"));
      const you = $("#youText");
      for (const ch of "Allowlist the domains fetch_url can reach, so the agent has no way to send mail out.") {
        you.textContent += ch;
        await wait(10);
      }
      await wait(350);
      show($("#graded"));
      await wait(450);
      show($("#coachA"));
      await wait(1700);
      $("#wave").classList.remove("on");

      // The end card
      chapter(7);
      $("#cursor").classList.remove("on");
      show($("#outro"));
    };
  }

  // ------------------------------------------------------------------ playback

  const ui = {
    play: document.getElementById("btnPlay"),
    restart: document.getElementById("btnRestart"),
    bar: document.getElementById("bar"),
    chapters: document.getElementById("chapters"),
    speed: document.getElementById("btnSpeed"),
    hide: document.getElementById("btnHide"),
  };

  const SPEEDS = [0.75, 1, 1.25, 1.5, 2];
  let state = "idle";
  let ready = false;
  let queued = null;

  function markChapter(i) {
    [...ui.chapters.children].forEach((b, j) => b.classList.toggle("on", j === i));
  }

  function syncButtons() {
    ui.play.textContent = { idle: "▶ Play", playing: "❚❚ Pause", paused: "▶ Resume", done: "↺ Replay" }[state];
  }

  function resetStage() {
    stage.innerHTML = template;
    renderMap();
    $("#cursor").style.transform = "translate(1180px, 620px)";
  }

  /** Play from chapter `from`, replaying the chapters before it instantly. */
  function start(from = 0) {
    // Measuring owns the stage until it finishes; a click that early plays right after.
    if (!ready) {
      queued = from;
      return;
    }
    clock.token += 1;
    const token = clock.token;
    clock.paused = false;
    stage.classList.remove("paused");
    // The old run's queued steps settle in this gap, before the frame resets.
    setTimeout(() => {
      if (token !== clock.token) return;
      resetStage();
      clock.start = clock.vt;
      clock.cursor = clock.vt;
      clock.chapter = -1;
      clock.fastUntil = from > 0 ? from : -1;
      stage.classList.toggle("instant", from > 0);
      $("#intro").classList.remove("on");
      state = "playing";
      syncButtons();
      script(token)().then(
        () => {
          if (token !== clock.token) return;
          state = "done";
          syncButtons();
        },
        (err) => {
          if (!(err instanceof Cancelled)) console.error(err);
        },
      );
    }, 0);
  }

  function togglePlay() {
    if (state === "idle" || state === "done") {
      start(0);
      return;
    }
    clock.paused = !clock.paused;
    stage.classList.toggle("paused", clock.paused);
    state = clock.paused ? "paused" : "playing";
    syncButtons();
  }

  function setSpeed(value) {
    clock.speed = value;
    document.documentElement.style.setProperty("--spd", String(value));
    ui.speed.textContent = `${value}x`;
  }

  function fit() {
    const reserve = document.body.classList.contains("clean") ? 0 : 60;
    const k = Math.min(innerWidth / STAGE_W, (innerHeight - reserve) / STAGE_H);
    stage.style.transform = `scale(${k})`;
    stage.style.left = `${(innerWidth - STAGE_W * k) / 2}px`;
    stage.style.top = `${Math.max(0, (innerHeight - reserve - STAGE_H * k) / 2)}px`;
  }

  function toggleClean() {
    document.body.classList.toggle("clean");
    fit();
  }

  /** Run the whole script instantly once, to size the progress bar. */
  async function measure() {
    clock.token += 1;
    const token = clock.token;
    clock.measuring = true;
    clock.cursor = 0;
    clock.chapter = -1;
    resetStage();
    stage.classList.add("instant");
    try {
      await script(token)();
    } catch (err) {
      if (!(err instanceof Cancelled)) console.error(err);
    }
    clock.total = Math.max(clock.cursor, 1);
    [...ui.chapters.children].forEach((b, i) => {
      b.title = `Starts at ${Math.round((clock.marks[i] || 0) / 1000)}s at 1x`;
    });
    clock.measuring = false;
    stage.classList.remove("instant");
    resetStage();
    clock.start = clock.vt;
    clock.cursor = clock.vt;
    clock.chapter = -1;
    markChapter(-1);
  }

  CHAPTERS.forEach((name, i) => {
    const b = document.createElement("button");
    b.textContent = `${i + 1} ${name}`;
    b.addEventListener("click", () => start(i));
    ui.chapters.appendChild(b);
  });

  ui.play.addEventListener("click", togglePlay);
  ui.restart.addEventListener("click", () => start(0));
  ui.speed.addEventListener("click", () => setSpeed(SPEEDS[(SPEEDS.indexOf(clock.speed) + 1) % SPEEDS.length]));
  ui.hide.addEventListener("click", toggleClean);
  stage.addEventListener("click", (e) => {
    if (e.target.closest("[data-action=play]")) start(0);
  });

  addEventListener("resize", fit);
  addEventListener("keydown", (e) => {
    if (e.key === " ") {
      e.preventDefault();
      togglePlay();
    } else if (e.key === "r" || e.key === "R") start(0);
    else if (e.key === "ArrowRight") start(Math.min(clock.chapter + 1, CHAPTERS.length - 1));
    else if (e.key === "ArrowLeft") start(Math.max(clock.chapter - 1, 0));
    else if (e.key === "h" || e.key === "H") toggleClean();
    else if (e.key === "f" || e.key === "F") {
      if (document.fullscreenElement) document.exitFullscreen();
      else document.documentElement.requestFullscreen();
    } else if (/^[1-7]$/.test(e.key)) start(Number(e.key) - 1);
  });

  if (params.has("clean")) document.body.classList.add("clean");
  const speed = Number(params.get("speed"));
  setSpeed(SPEEDS.includes(speed) ? speed : 1);
  fit();
  requestAnimationFrame(tick);
  document.fonts.ready.then(measure).then(() => {
    ready = true;
    state = "idle";
    syncButtons();
    if (queued !== null) start(queued);
    else if (params.has("autoplay")) start(0);
  });
})();
