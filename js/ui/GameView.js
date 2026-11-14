// The build played back in the game's look (Over Engineered's drawing code): the site, the river,
// the cartoon builders carrying pieces at full size, bolts going in and nuts being fastened, with the
// game's sparks and dust. On top of what the game shows, it draws what only the plan has: tool
// racks and nuts & bolts bins, the tools each builder has picked up, and a bubble for jobs like
// grabbing a tool, assembling one, or an "other" task.
//
// A game world (createGame) is set up once per plan and then, each frame, posed to match the
// simulation at the moment shown (stateAt); nothing in the game's rules runs.
import { html, useEffect, useMemo, useRef, useState } from '../lib/preact.js';
import { createGame, defaultSettings, itemBox } from '../../game/js/world.js';
import { addFx, draw, makeView } from '../../game/js/render.js';
import { stateAt } from '../sim/playback.js';
import { sideOf } from '../model/plan.js';
import { fmt } from '../sim/simulate.js';

const SPEEDS = [1, 2, 4, 8, 16];
const WORK = { align: 'fasten', insert: 'fasten', fasten: 'fasten' };
// Jobs the game has no picture for: shown in a bubble over the builder.
const BUBBLE = { gear: 1, other: 1, wait: 1, support: 1 };

// Everything about the plan that doesn't change from frame to frame.
function prepare(project, sim, order) {
  const players = project.builders.map((b) => ({ id: b.id, name: b.name, color: b.color, side: sideOf(project.site, b.start) || 'west' }));
  const settings = { ...defaultSettings(project, 2), freeStaging: true };
  const S = createGame({ project, order: order.map((it) => ({ ...it, time: null })), settings, players });
  // The pieces of an assembly that isn't made yet are shown one by one.
  S.lookItems = new Map();
  const pieceItems = new Map();
  for (const it of S.items) {
    if (!it.multi) continue;
    pieceItems.set(it.id, it.memberIds.map((id) => {
      const p = { id: 'pc:' + id, memberIds: [id], idx: it.idx, multi: false, buddy: false, status: 'shelf', progress: 0, time: 0 };
      S.lookItems.set(p.id, p);
      return p;
    }));
  }
  const keyOf = (it) => (it.multi ? 'a:' + it.id : 'm:' + it.memberIds[0]);
  const itemByKey = new Map(S.items.map((it) => [keyOf(it), it]));
  // When each assembly is being made, and when it's done: from the work on the bolts inside it.
  const making = new Map();
  for (const it of S.items) {
    if (!it.multi) continue;
    const inner = new Set(S.bolts.filter((b) => b.state === 'internal' && b.memberIds.every((m) => it.memberIds.includes(m))).map((b) => b.id));
    const evs = (sim.boltEvents || []).filter((e) => inner.has(e.boltId));
    const fastened = new Set(evs.filter((e) => e.kind !== 'insert').map((e) => e.boltId));
    if (!evs.length || fastened.size < inner.size) continue;
    making.set(it.id, { start: Math.min(...evs.map((e) => e.t0)), end: Math.max(...evs.map((e) => e.t1)) });
  }
  // Bolt work in time, to show a nut's progress.
  const boltWork = new Map();
  for (const e of sim.boltEvents || []) { if (!boltWork.has(e.boltId)) boltWork.set(e.boltId, []); boltWork.get(e.boltId).push(e); }
  // Who has which tool, over time (picked up, passed on), and the nuts & bolts.
  const toolMoves = [], hwAt = new Map();
  for (const s of sim.segments || []) {
    if (s.kind === 'gear' && s.toolKey && !s.assembling) toolMoves.push({ t: s.t1, key: s.toolKey, to: s.builderId });
    if (s.kind === 'pickup' && s.toolKey && s.to) toolMoves.push({ t: s.t1, key: s.toolKey, to: s.to });
    if (s.kind === 'gear' && s.hardware) hwAt.set(s.builderId, Math.min(hwAt.get(s.builderId) ?? Infinity, s.t1));
  }
  toolMoves.sort((a, b) => a.t - b.t);
  const tools = [];
  for (const tool of project.tools) for (let i = 0; i < Math.max(0, tool.count | 0); i++) tools.push({ key: tool.id + '#' + i, tool, pos: tool.start });
  const internal = new Set(); // bolts inside one item: done in the staging yard
  for (const b of S.bolts) if (b.state === 'internal') internal.add(b.id);
  return { S, pieceItems, keyOf, itemByKey, making, boltWork, toolMoves, hwAt, tools, internal };
}

// Pose the world at time t. Returns what changed since `prev` (for effects).
function pose(P, sim, t, settings) {
  const { S, pieceItems, keyOf, making, boltWork, internal } = P;
  const st = stateAt(sim, t);
  S.t = t;
  const builders = new Map(st.builders.map((b) => [b.id, b]));
  const staged = new Map();
  const carrying = new Map();
  S.installed = new Set();
  for (const it of S.items) {
    const ms = it.memberIds.map((id) => st.members.get(id)).filter(Boolean);
    it.loose = null;
    if (ms.length && ms.every((m) => m.loc === 'bridge')) {
      it.status = 'placed';
      it.memberIds.forEach((id) => S.installed.add(id));
      if (ms.some((m) => m.status === 'unstable')) it.loose = { t: 0 };
      continue;
    }
    const held = ms.find((m) => m.loc === 'carried');
    if (held) { it.status = 'carried'; carrying.set(held.builderId, it.id); continue; }
    const mk = it.multi ? making.get(it.id) : null;
    const made = !it.multi || (mk && t >= mk.end);
    if (made) {
      it.status = 'shelf';
      staged.set(it, { x: ms.reduce((s, m) => s + m.x, 0) / ms.length, y: ms.reduce((s, m) => s + m.y, 0) / ms.length });
    } else {
      it.status = mk && t >= mk.start ? 'building' : 'waiting';
      it.time = mk ? Math.max(0.1, mk.end - mk.start) : 1;
      it.progress = mk ? Math.max(0, Math.min(it.time, t - mk.start)) : 0;
      for (const p of pieceItems.get(it.id) || []) { const m = st.members.get(p.memberIds[0]); if (m) staged.set(p, { x: m.x, y: m.y }); }
    }
  }
  P.staged = staged;
  for (const a of S.actors) {
    const b = builders.get(a.id);
    if (!b) continue;
    const kind = b.seg?.kind || 'idle';
    a.moving = kind === 'walk' || kind === 'carry';
    if (a.moving) a.face = [Math.cos(b.dir), Math.sin(b.dir)];
    a.x = b.x; a.y = b.y;
    a.carrying = carrying.get(a.id) || null;
    a.anchor = kind === 'hold' ? { kind: 'bridge' } : null;
    a.extending = kind === 'pickup' && /^Hand /.test(b.seg?.label || '');
    if (WORK[kind]) a.work = { kind: 'fasten' };
    else if (kind === 'assemble') {
      const it = S.items.find((q) => b.seg?.unitKey === keyOf(q));
      a.work = it ? { kind: 'assemble', target: it } : { kind: 'fasten' };
    } else if (kind === 'gear' && b.seg?.assembling) a.work = { kind: 'tool' };
    else a.work = null;
    a.label = b.label;
    a.kind = kind;
  }
  for (const bolt of S.bolts) {
    if (internal.has(bolt.id)) { bolt.state = 'internal'; continue; }
    const s = st.bolts.get(bolt.id);
    const on = bolt.memberIds.filter((id) => S.installed.has(id)).length >= 2;
    bolt.progress = 0;
    if (!s) bolt.state = on ? 'needed' : 'hidden';
    else if (s.state === 'fastened') bolt.state = 'fastened';
    else if (s.state === 'inserted') bolt.state = on ? 'placed' : 'hidden';
    else if (s.state === 'moving') bolt.state = on ? 'needed' : 'hidden';
    else {
      bolt.state = on ? 'placed' : 'hidden';
      const e = (boltWork.get(bolt.id) || []).find((x) => x.t0 <= t && t < x.t1);
      if (e) bolt.progress = settings.fastenTime * ((t - e.t0) / Math.max(1e-6, e.t1 - e.t0));
    }
  }
  return st;
}

// A small crate on the ground.
function crate(g, P, x, y, w, d, h, top, front) {
  const q = (pts) => { g.beginPath(); pts.forEach(([a, b], i) => (i ? g.lineTo(a, b) : g.moveTo(a, b))); g.closePath(); };
  q([P(x - w / 2, y + d / 2, 0), P(x + w / 2, y + d / 2, 0), P(x + w / 2, y + d / 2, h), P(x - w / 2, y + d / 2, h)]); g.fillStyle = front; g.fill();
  q([P(x - w / 2, y - d / 2, h), P(x + w / 2, y - d / 2, h), P(x + w / 2, y + d / 2, h), P(x - w / 2, y + d / 2, h)]); g.fillStyle = top; g.fill();
  g.strokeStyle = 'rgba(0,0,0,0.25)'; g.lineWidth = 1; g.stroke();
}
function icon(g, x, y, text, size) {
  g.font = `${size}px "Segoe UI Emoji", "Apple Color Emoji", system-ui`;
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(text, x, y);
  g.textBaseline = 'alphabetic';
}
function bubble(g, x, y, text, k) {
  g.font = `600 ${Math.max(10, k * 3.4)}px system-ui`;
  const w = Math.min(220, g.measureText(text).width + 14), h = Math.max(16, k * 5.4);
  const r = h / 2;
  g.beginPath();
  g.moveTo(x - w / 2 + r, y - h); g.arcTo(x + w / 2, y - h, x + w / 2, y, r); g.arcTo(x + w / 2, y, x - w / 2, y, r);
  g.lineTo(x + 5, y); g.lineTo(x, y + 6); g.lineTo(x - 5, y);
  g.arcTo(x - w / 2, y, x - w / 2, y - h, r); g.arcTo(x - w / 2, y - h, x + w / 2, y - h, r); g.closePath();
  g.fillStyle = 'rgba(255,255,255,0.95)'; g.fill(); g.strokeStyle = 'rgba(15,23,42,0.5)'; g.lineWidth = 1; g.stroke();
  g.fillStyle = '#0f172a'; g.textAlign = 'center'; g.textBaseline = 'middle';
  let s = text;
  while (g.measureText(s).width > w - 12 && s.length > 4) s = s.slice(0, -2);
  g.fillText(s === text ? s : s + '…', x, y - h / 2 + 0.5);
  g.textBaseline = 'alphabetic';
}

// `bare`: no controls of its own (the Simulate tab drives the time), just a button to fill the window.
export function GameView({ project, model, sim, order, t, setT, bare = false, outerPlaying = false, onPlay = null }) {
  const wrap = useRef(null), canvas = useRef(null);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(4);
  const [big, setBig] = useState(false);
  const [shown, setShown] = useState(t); // the time on the slider
  const end = Math.max(0, sim?.endTime || 0);
  const prep = useMemo(() => (sim ? prepare(project, sim, order) : null), [project, sim, order]);
  const live = useRef({});
  live.current = { prep, sim, playing, speed, end, setT, bare };
  const tRef = useRef(t);
  // Clicking the timeline moves the playback there.
  useEffect(() => { if (!live.current.playing) { tRef.current = Math.min(t, end); setShown(tRef.current); } }, [t]);
  useEffect(() => { if (tRef.current > end) { tRef.current = end; setShown(end); } }, [end]);
  useEffect(() => { if (!playing) setT(tRef.current); }, [playing]);

  useEffect(() => {
    const ui = { now: 0, fx: [], banners: [], countdown: -1, replay: true, numberOf: (a) => prep0().S.actors.indexOf(a) + 1, keysOf: () => null };
    const prep0 = () => live.current.prep;
    let raf, last = performance.now(), lastT = -1, lastSync = 0, prevPrep = null, prev = null;
    const frame = (now) => {
      raf = requestAnimationFrame(frame);
      const { prep: P, sim: R, playing: on, speed: sp, end: E } = live.current;
      const c = canvas.current;
      if (!P || !R || !c || document.hidden) { last = now; return; }
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      ui.now = now / 1000;
      if (on) {
        tRef.current = Math.min(E, tRef.current + dt * sp);
        if (now - lastSync > 200 || tRef.current >= E) { lastSync = now; setShown(tRef.current); live.current.setT(tRef.current); }
        if (tRef.current >= E) setPlaying(false);
      }
      const t = tRef.current;
      const S = P.S;
      const st = pose(P, R, t, S.settings);
      // Effects for what just happened, when playing forward.
      if (prevPrep === P && prev && t > lastT && t - lastT < 3) {
        for (const it of S.items) {
          const was = prev.items.get(it.id);
          if (it.status === 'placed' && was !== 'placed') {
            const b = itemBox(S, it);
            addFx(ui, 'dust', (b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2, b.z0);
            addFx(ui, 'ring', (b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2, b.z0, { color: '#facc15', size: 16 });
          }
          if (it.multi && it.status === 'shelf' && (was === 'building' || was === 'waiting')) {
            const p = P.staged.get(it);
            if (p) { addFx(ui, 'ring', p.x, p.y, 4, { color: '#a855f7', size: 18 }); addFx(ui, 'text', p.x, p.y, 20, { text: 'Made!', color: '#e9d5ff' }); }
          }
        }
        for (const b of S.bolts) if (b.state === 'fastened' && prev.bolts.get(b.id) !== 'fastened') addFx(ui, 'sparks', b.x, b.y, b.z);
        if (lastT < E && t >= E && E > 0) {
          const xs = S.bolts.map((b) => b.x);
          addFx(ui, 'confetti', xs.length ? (Math.min(...xs) + Math.max(...xs)) / 2 : S.site.width / 2, S.site.depth / 2, 40);
        }
      }
      prev = { items: new Map(S.items.map((it) => [it.id, it.status])), bolts: new Map(S.bolts.map((b) => [b.id, b.state])) };
      prevPrep = P;
      lastT = t;

      // Size the canvas to its box.
      const dpr = window.devicePixelRatio || 1;
      const W = c.clientWidth, H = c.clientHeight;
      if (!W || !H) return;
      if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) { c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); }
      const g = c.getContext('2d');
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      const roomy = H >= 520;
      const V = makeView(S, W, H, { top: 92, bottom: roomy ? 86 : 4 });
      const owner = (key) => { let o = null; for (const m of P.toolMoves) { if (m.t > t) break; if (m.key === key) o = m.to; } return o; };
      ui.hudRight = live.current.bare ? `${fmt(t)} of ${fmt(E)}` : `Playback ${live.current.speed}× · ${fmt(t)} of ${fmt(E)}`;
      ui.activityOf = (a) => a.label || 'Idle';
      ui.deviceOf = (a) => `${a.side} side`;
      ui.readyLayout = () => {
        const out = new Map();
        for (const [it, p] of P.staged) {
          const b = itemBox(S, it);
          out.set(it, { dx: p.x - (b.x0 + b.x1) / 2, dy: p.y - (b.y0 + b.y1) / 2, dz: -b.z0, x: p.x, y: p.y });
        }
        return out;
      };
      // Bins of nuts and bolts, and the tools nobody has picked up yet.
      ui.drawGround = (g2, V2) => {
        const { P: Pj, k } = V2;
        for (const z of S.site.zones) {
          if (z.type !== 'hardware') continue;
          const cx = z.x + z.w / 2, cy = z.y + z.h / 2;
          crate(g2, Pj, cx, cy, Math.min(20, z.w * 0.7), Math.min(14, z.h * 0.6), 6, '#94a3b8', '#475569');
          const [ix, iy] = Pj(cx, cy, 9);
          icon(g2, ix, iy, '🔩', Math.max(10, k * 5));
        }
        for (const tl of P.tools) {
          if (owner(tl.key) || !tl.pos) continue;
          crate(g2, Pj, tl.pos.x, tl.pos.y, 12, 8, 4, '#f59e0b', '#b45309');
          const [ix, iy] = Pj(tl.pos.x, tl.pos.y, 8);
          icon(g2, ix, iy, tl.tool.kind === 'fastener' ? '🔧' : tl.tool.kind === 'support' ? '🗜️' : '🧰', Math.max(9, k * 4));
        }
      };
      // What each builder has picked up, and a bubble for jobs the game has no picture for.
      ui.drawTop = (g2, V2) => {
        const { P: Pj, k } = V2;
        for (const a of S.actors) {
          const held = P.tools.filter((tl) => owner(tl.key) === a.id).map((tl) => (tl.tool.kind === 'fastener' ? '🔧' : tl.tool.kind === 'support' ? '🗜️' : '🧰'));
          if ((P.hwAt.get(a.id) ?? Infinity) <= t) held.push('🔩');
          if (held.length) {
            const [hx, hy] = Pj(a.x + 7, a.y, 10);
            held.forEach((h, i) => icon(g2, hx + i * k * 3.4, hy, h, Math.max(9, k * 3.6)));
          }
          if (BUBBLE[a.kind] || (a.kind === 'pickup' && /^Pass /.test(a.label || ''))) {
            const [bx, by] = Pj(a.x, a.y, a.carrying ? 46 : 34);
            bubble(g2, bx, by, a.kind === 'wait' ? '⏳ ' + a.label : a.label, k);
          }
        }
      };
      draw(g, S, V, ui);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, []);

  const scrub = (v) => { tRef.current = v; setShown(v); setT(v); };
  if (bare) {
    return html`<div ref=${wrap} class=${'gameview bare' + (big ? ' big' : '')} data-gameview>
      <div class="gv-big">
        ${onPlay && html`<button class="primary" onClick=${onPlay}>${outerPlaying ? '❚❚ Pause' : '▶ Play'}</button>`}
        <button title=${big ? 'Back to the tab' : 'Fill the window'} onClick=${() => setBig(!big)}>${big ? '✕ Close' : '⛶ Big'}</button>
      </div>
      <canvas ref=${canvas} class="gv-canvas"></canvas>
    </div>`;
  }
  return html`<div ref=${wrap} class=${'gameview' + (big ? ' big' : '')} data-gameview>
    <div class="gv-bar">
      <button class="primary" data-gv-play onClick=${() => { if (tRef.current >= end) tRef.current = 0; setPlaying(!playing); }}>${playing ? '❚❚ Pause' : '▶ Play'}</button>
      <button title="Back to the start" onClick=${() => { setPlaying(false); scrub(0); }}>⏮</button>
      <select title="Playback speed" onChange=${(e) => setSpeed(parseFloat(e.target.value))}>
        ${SPEEDS.map((s) => html`<option value=${s} selected=${s === speed}>${s}×</option>`)}
      </select>
      <input type="range" min="0" max=${end || 1} step="0.1" value=${Math.min(shown, end)} title="Scrub through the build" onInput=${(e) => { setPlaying(false); scrub(parseFloat(e.target.value)); }} />
      <span class="gv-time">${fmt(Math.min(shown, end))} / ${fmt(end)}</span>
      <button title=${big ? 'Back to the tab' : 'Fill the window'} onClick=${() => setBig(!big)}>${big ? '✕ Close' : '⛶ Big'}</button>
    </div>
    <canvas ref=${canvas} class="gv-canvas"></canvas>
  </div>`;
}
