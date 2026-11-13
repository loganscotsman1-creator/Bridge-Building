// Drawing the game: a tilted top-down view of the site, with heights shown by lifting things up the
// screen, so top chords, bottom chords and laterals read as above or below each other. Also the
// little effects (sparks, dust, confetti, floating text, a shake when the bridge falls).
import { benchLayout, buildingItems, holdPoints, itemBox, readyLayout, shelfItems, R } from './world.js';

// Screen units per inch of ground depth (y) and of height (z). The ground stretches to fill a
// tall screen; heights are exaggerated a little so above and below are easy to tell apart.
let YF = 1.0, ZF = 1.35;
const HUD_TOP = 92, HUD_BOTTOM = 86;

const ZONE_FILL = {
  staging: '#d6e4fb', construction: '#d9f0dc', riverbank: '#cfe8a9', transport: '#e4e8ee',
  footing: '#c8a070', assembly: '#eadcfb', walkway: '#e5e7eb',
};
const PLANE = { A: '#6b7f9c', B: '#5a6b85', L: '#7c6fd6' };
const BTN = { A: '#16a34a', X: '#2563eb', LB: '#d97706' };

export function makeView(S, W, H) {
  const site = S.site;
  const lift = 48; // room above the ground for the bridge and builders
  const availH = H - HUD_TOP - HUD_BOTTOM - 16;
  const kw = (W - 30) / site.width;
  YF = Math.max(1, Math.min(2.4, availH / kw / (site.depth + 1.15 * lift)));
  ZF = 1.35 * Math.max(1, YF * 0.85);
  const k = Math.min(kw, availH / (site.depth * YF + lift * ZF));
  const ox = (W - site.width * k) / 2;
  const used = (site.depth * YF + lift * ZF) * k;
  const oy = HUD_TOP + 8 + Math.max(0, (availH - used) / 2) + lift * ZF * k;
  return { k, ox, oy, W, H, P: (x, y, z = 0) => [ox + x * k, oy + (y * YF - z * ZF) * k] };
}

function shade(hex, f) {
  const n = parseInt(hex.slice(1), 16);
  const c = (v) => Math.max(0, Math.min(255, Math.round(v * f)));
  return `rgb(${c((n >> 16) & 255)},${c((n >> 8) & 255)},${c(n & 255)})`;
}
function poly(g, pts) {
  g.beginPath();
  pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
  g.closePath();
}
function rrect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r);
  g.closePath();
}
const fmt = (t) => { const m = Math.floor(t / 60), s = t - m * 60; return m + ':' + (s < 10 ? '0' : '') + s.toFixed(1); };
export { fmt as fmtTime };

// A faint speckle laid over the ground so it reads as dirt and grass, not flat paper.
let speckle = null;
function speckleFor(g) {
  if (speckle) return speckle;
  const c = document.createElement('canvas');
  c.width = c.height = 96;
  const x = c.getContext('2d');
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 260; i++) {
    x.fillStyle = rnd() < 0.5 ? 'rgba(15,23,42,0.05)' : 'rgba(255,255,255,0.22)';
    x.fillRect(rnd() * 96, rnd() * 96, 1 + rnd() * 2, 1 + rnd() * 1.5);
  }
  speckle = g.createPattern(c, 'repeat');
  return speckle;
}

// ---------- effects ----------
// Effects live in site inches (x, y, z up) so they stay put when the window resizes.
export function addFx(ui, kind, x, y, z = 0, opts = {}) {
  const now = ui.now, list = ui.fx;
  const rnd = (a, b) => a + Math.random() * (b - a);
  if (kind === 'sparks') {
    for (let i = 0; i < 16; i++) { const a = rnd(0, 7); const v = rnd(25, 70); list.push({ kind: 'spark', x, y, z, vx: Math.cos(a) * v, vy: Math.sin(a) * v * 0.6, vz: rnd(40, 110), t0: now, life: rnd(0.35, 0.65), color: Math.random() < 0.5 ? '#fde047' : '#fb923c' }); }
  } else if (kind === 'dust') {
    for (let i = 0; i < 12; i++) { const a = rnd(0, 7); const v = rnd(12, 34); list.push({ kind: 'puff', x, y, z: z + rnd(0, 4), vx: Math.cos(a) * v, vy: Math.sin(a) * v * 0.5, vz: rnd(4, 16), t0: now, life: rnd(0.5, 0.9), size: rnd(2.5, 5) }); }
  } else if (kind === 'ring') {
    list.push({ kind: 'ring', x, y, z, t0: now, life: opts.life || 0.45, color: opts.color || '#ffffff', size: opts.size || 10 });
  } else if (kind === 'confetti') {
    const cols = ['#f43f5e', '#facc15', '#22c55e', '#3b82f6', '#a855f7', '#fb923c'];
    for (let i = 0; i < (opts.n || 140); i++) { const a = rnd(0, 7); const v = rnd(20, 140); list.push({ kind: 'confetti', x: x + rnd(-30, 30), y, z, vx: Math.cos(a) * v, vy: Math.sin(a) * v * 0.4, vz: rnd(90, 230), t0: now, life: rnd(1.8, 3), color: cols[i % cols.length], spin: rnd(-12, 12) }); }
  } else if (kind === 'splash') {
    for (let i = 0; i < 24; i++) { const a = rnd(0, 7); const v = rnd(20, 60); list.push({ kind: 'spark', x, y, z, vx: Math.cos(a) * v, vy: Math.sin(a) * v * 0.5, vz: rnd(60, 140), t0: now, life: rnd(0.5, 0.9), color: Math.random() < 0.5 ? '#ef4444' : '#f97316' }); }
    addFx(ui, 'dust', x, y, z);
  } else if (kind === 'text') {
    list.push({ kind: 'text', x, y, z, t0: now, life: opts.life || 1.4, text: opts.text, color: opts.color || '#fff' });
  } else if (kind === 'swoosh') {
    list.push({ kind: 'swoosh', x, y, z, x2: opts.x2, y2: opts.y2, t0: now, life: 0.4, color: opts.color || '#fff' });
  }
  if (list.length > 600) list.splice(0, list.length - 600);
}

function drawFx(g, V, ui) {
  const { P, k } = V;
  const now = ui.now, G = 260;
  ui.fx = ui.fx.filter((f) => now - f.t0 < f.life);
  for (const f of ui.fx) {
    const t = now - f.t0, u = t / f.life;
    if (f.kind === 'spark' || f.kind === 'confetti' || f.kind === 'puff') {
      const g2 = f.kind === 'puff' ? 0 : f.kind === 'confetti' ? 160 : G;
      const drag = f.kind === 'confetti' ? Math.exp(-t * 1.2) : 1;
      const x = f.x + f.vx * t * drag, y = f.y + f.vy * t * drag, z = Math.max(0, f.z + f.vz * t - 0.5 * g2 * t * t);
      const [sx, sy] = P(x, y, z);
      if (f.kind === 'spark') {
        const [px, py] = P(x - f.vx * 0.03, y - f.vy * 0.03, Math.max(0, z - (f.vz - g2 * t) * 0.03));
        g.strokeStyle = f.color; g.globalAlpha = 1 - u; g.lineWidth = Math.max(1.5, k * 0.7);
        g.beginPath(); g.moveTo(px, py); g.lineTo(sx, sy); g.stroke();
      } else if (f.kind === 'puff') {
        g.fillStyle = 'rgba(148,163,184,1)'; g.globalAlpha = 0.45 * (1 - u);
        g.beginPath(); g.arc(sx, sy, (f.size + u * 5) * k, 0, 7); g.fill();
      } else {
        g.save(); g.translate(sx, sy); g.rotate(f.spin * t); g.globalAlpha = Math.min(1, 2 * (1 - u));
        g.fillStyle = f.color; g.fillRect(-2.5 * k, -1.2 * k, 5 * k, 2.4 * k); g.restore();
      }
    } else if (f.kind === 'ring') {
      const [sx, sy] = P(f.x, f.y, f.z);
      g.strokeStyle = f.color; g.globalAlpha = 1 - u; g.lineWidth = 3 * (1 - u) + 1;
      g.beginPath(); g.ellipse(sx, sy, (4 + f.size * u) * k, (4 + f.size * u) * k * 0.6, 0, 0, 7); g.stroke();
    } else if (f.kind === 'text') {
      const [sx, sy] = P(f.x, f.y, f.z + 20 * u);
      g.globalAlpha = Math.min(1, 3 * (1 - u));
      g.font = `900 ${Math.max(14, k * 7)}px system-ui`; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.lineWidth = 4; g.strokeStyle = 'rgba(15,23,42,0.8)'; g.strokeText(f.text, sx, sy);
      g.fillStyle = f.color; g.fillText(f.text, sx, sy);
      g.textBaseline = 'alphabetic';
    } else if (f.kind === 'swoosh') {
      const [ax, ay] = P(f.x, f.y, 30), [bx, by] = P(f.x2, f.y2, 30);
      const mx = (ax + bx) / 2, my = Math.min(ay, by) - 30 * k;
      g.strokeStyle = f.color; g.globalAlpha = 1 - u; g.lineWidth = 3; g.setLineDash([6, 6]); g.lineDashOffset = -now * 60;
      g.beginPath(); g.moveTo(ax, ay); g.quadraticCurveTo(mx, my, bx, by); g.stroke(); g.setLineDash([]);
    }
  }
  g.globalAlpha = 1;
}

// ---------- the scene ----------
export function draw(g, S, V, ui) {
  const { P, k, W, H } = V;
  const now = ui.now;
  ui.fx = ui.fx || [];

  // Backdrop
  const bg = g.createRadialGradient(W / 2, H * 0.55, 50, W / 2, H * 0.55, Math.max(W, H) * 0.75);
  bg.addColorStop(0, '#24324a'); bg.addColorStop(1, '#0d1420');
  g.fillStyle = bg; g.fillRect(0, 0, W, H);

  g.save();
  if (ui.shakeUntil > now) { const m = 6 * (ui.shakeUntil - now); g.translate((Math.random() - 0.5) * m * 2, (Math.random() - 0.5) * m * 2); }

  // Ground: a slab with a front edge, so the site reads as a board.
  const site = S.site;
  const ground = (x, y, w, h) => [P(x, y), P(x + w, y), P(x + w, y + h), P(x, y + h)];
  poly(g, [P(0, site.depth, 0), P(site.width, site.depth, 0), P(site.width, site.depth, -7), P(0, site.depth, -7)]);
  g.fillStyle = '#5b4632'; g.fill();
  poly(g, ground(0, 0, site.width, site.depth));
  g.fillStyle = '#eef1f5'; g.fill();
  const zones = [...site.zones].sort((a, b) => (a.type === 'footing') - (b.type === 'footing'));
  for (const z of zones) {
    if (z.type === 'nogo') {
      // River: a cut in the ground with moving water.
      poly(g, ground(z.x, z.y, z.w, z.h));
      const grad = g.createLinearGradient(P(z.x, 0)[0], 0, P(z.x + z.w, 0)[0], 0);
      grad.addColorStop(0, '#1e40af'); grad.addColorStop(0.5, '#3b82f6'); grad.addColorStop(1, '#1e40af');
      g.fillStyle = grad; g.fill();
      g.save(); g.clip();
      g.strokeStyle = 'rgba(255,255,255,0.28)'; g.lineWidth = 2;
      for (let yy = z.y - 20; yy < z.y + z.h + 20; yy += 12) {
        g.beginPath();
        for (let xx = z.x; xx <= z.x + z.w; xx += 4) { const p = P(xx, yy + Math.sin(xx / 9 + now * 2 + yy) * 2.5); xx === z.x ? g.moveTo(...p) : g.lineTo(...p); }
        g.stroke();
      }
      // Glints
      g.fillStyle = 'rgba(255,255,255,0.55)';
      for (let i = 0; i < 10; i++) { const gx = z.x + ((i * 37 + now * 9) % z.w), gy = z.y + ((i * 53) % z.h); const [sx, sy] = P(gx, gy); g.fillRect(sx, sy, 3 * k, 1); }
      g.restore();
      // Banks
      g.strokeStyle = '#7c5a3a'; g.lineWidth = Math.max(2, k * 1.4);
      for (const bx of [z.x, z.x + z.w]) { g.beginPath(); g.moveTo(...P(bx, z.y)); g.lineTo(...P(bx, z.y + z.h)); g.stroke(); }
      continue;
    }
    const fill = ZONE_FILL[z.type];
    if (!fill) continue;
    poly(g, ground(z.x, z.y, z.w, z.h));
    g.fillStyle = fill; g.fill();
    g.strokeStyle = 'rgba(15,23,42,0.14)'; g.lineWidth = 1; g.stroke();
  }
  poly(g, ground(0, 0, site.width, site.depth));
  g.fillStyle = speckleFor(g); g.fill();
  g.font = `700 ${Math.max(10, k * 4.2)}px system-ui, sans-serif`;
  g.textAlign = 'center';
  for (const z of site.zones) {
    if (!ZONE_FILL[z.type] && z.type !== 'nogo') continue;
    if (z.type === 'footing' || z === S.yard) continue;
    const [x, y] = P(z.x + z.w / 2, z.y + z.h - 6);
    g.fillStyle = z.type === 'nogo' ? 'rgba(255,255,255,0.6)' : 'rgba(15,23,42,0.25)';
    g.fillText(z.name.toUpperCase(), x, y);
  }

  // Staging: the ready area (north) and the assembly area (south).
  for (const [r, fill, edge, name] of [[S.ready, 'rgba(250,204,21,0.2)', '#ca8a04', 'READY'], [S.assembly, 'rgba(37,99,235,0.14)', '#2563eb', 'ASSEMBLY']]) {
    poly(g, ground(r.x + 2, r.y + 2, r.w - 4, r.h - 4));
    g.fillStyle = fill; g.fill();
    g.setLineDash([7, 5]); g.strokeStyle = edge; g.lineWidth = 2; g.stroke(); g.setLineDash([]);
    const [x, y] = P(r.x + r.w / 2, r.y + r.h - 5);
    g.fillStyle = edge; g.globalAlpha = 0.55; g.textAlign = 'center';
    g.font = `900 ${Math.max(11, k * 4.6)}px system-ui`;
    g.fillText(name, x, y);
    g.globalAlpha = 1;
  }

  // The bridge still to build, faintly; a carried piece's spot glows in its carrier's color.
  const carriedBy = new Map(S.actors.filter((a) => a.carrying).map((a) => [a.carrying, a]));
  g.lineWidth = 1;
  for (const [id, mm] of S.members) {
    if (S.installed.has(id)) continue;
    const it = S.itemOf.get(id);
    const a = it && carriedBy.get(it.id);
    drawMember(g, P, mm, a ? { glow: a.color, pulse: 0.5 + 0.5 * Math.sin(now * 6) } : { ghost: true });
  }

  // Pieces at full size in the ready and assembly areas.
  const ready = readyLayout(S), building = benchLayout(S);
  const next = shelfItems(S)[0];

  // Shadows first (under everything), then pieces and builders back to front.
  const sag = S.support.fallen ? 3 + Math.sin(now * 20) * 0.6 : 0;
  for (const id of S.installed) drawShadow(g, P, S.members.get(id), null, sag);
  for (const [it, sl] of [...ready, ...building]) for (const id of it.memberIds) drawShadow(g, P, S.members.get(id), sl, 0);
  for (const a of S.actors) {
    const [sx, sy] = P(a.x, a.y, 0);
    g.fillStyle = 'rgba(15,23,42,0.22)';
    g.beginPath(); g.ellipse(sx + 2 * k, sy + 1, R * k * 1.1, R * k * 0.5 * YF, 0, 0, 7); g.fill();
  }

  const list = [];
  for (const id of S.installed) {
    const mm = S.members.get(id);
    const ys = mm.m.corners3.map((c) => c[1]);
    list.push({ y: S.toSite(0, Math.max(...ys))[1] + (mm.m.plane === 'L' ? -10 : 0), mm });
  }
  for (const [it, sl] of ready) list.push({ y: sl.y + (itemBox(S, it).y1 - itemBox(S, it).y0) / 2, it, sl, where: 'ready' });
  for (const [it, sl] of building) list.push({ y: sl.y + (itemBox(S, it).y1 - itemBox(S, it).y0) / 2, it, sl, where: 'bench' });
  for (const a of S.actors) list.push({ y: a.y, a });
  list.sort((p, q) => p.y - q.y);
  for (const d of list) {
    if (d.mm) {
      const it = S.itemOf.get(d.mm.m.id);
      const loose = it?.loose;
      drawMember(g, P, d.mm, { color: S.support.fallen ? '#dc2626' : loose ? (Math.sin(now * 8) > 0 ? '#f59e0b' : '#fbbf24') : PLANE[d.mm.m.plane], sag });
    } else if (d.it) {
      const isNext = d.it === next;
      const ms = d.it.memberIds.map((id) => S.members.get(id)).filter(Boolean).sort((a, b) => a.m.centroid[1] - b.m.centroid[1]);
      if (d.where === 'bench') g.globalAlpha = 0.45 + 0.4 * (d.it.progress / d.it.time);
      for (const mm of ms) drawMember(g, P, mm, { color: PLANE[mm.m.plane], shift: d.sl, outline: isNext ? `rgba(250,204,21,${0.6 + 0.4 * Math.sin(now * 6)})` : null });
      g.globalAlpha = 1;
    } else drawActor(g, S, V, d.a, ui);
  }

  // Labels over the pieces in staging: their number, the next one to grab, assembly progress.
  for (const [it, sl] of ready) {
    const b = itemBox(S, it);
    const [x, y] = P(sl.x, sl.y, b.z1 - b.z0 + 5);
    chip(g, x, y, '#' + (it.idx + 1) + (it.buddy ? '★' : ''), it === next ? '#ca8a04' : 'rgba(15,23,42,0.8)', k);
    if (it === next) {
      const [nx, ny] = P(sl.x, sl.y, b.z1 - b.z0 + 13 + Math.sin(now * 5) * 1.5);
      g.fillStyle = '#facc15'; g.font = `900 ${Math.max(10, k * 3.6)}px system-ui`; g.textAlign = 'center';
      g.fillText('NEXT ▼', nx, ny);
    }
  }
  for (const [it, sl] of building) {
    const b = itemBox(S, it);
    const [x, y] = P(sl.x, sl.y, b.z1 - b.z0 + 6);
    const w = Math.max(30, (b.x1 - b.x0) * k * 0.7);
    rrect(g, x - w / 2, y - 4, w, 8, 4); g.fillStyle = 'rgba(15,23,42,0.75)'; g.fill();
    rrect(g, x - w / 2 + 1, y - 3, Math.max(0, (w - 2) * Math.min(1, it.progress / it.time)), 6, 3); g.fillStyle = '#22c55e'; g.fill();
    chip(g, x, y - 13, '#' + (it.idx + 1), '#1d4ed8', k);
  }
  if (!buildingItems(S).length && S.items.some((x) => x.multi && x.status === 'waiting')) {
    const [x, y] = P(S.assembly.x + S.assembly.w / 2, S.assembly.y + S.assembly.h * 0.45, 0);
    g.fillStyle = 'rgba(30,58,138,0.55)'; g.font = `700 ${Math.max(10, k * 3.6)}px system-ui`; g.textAlign = 'center';
    g.fillText('Hold X here to assemble', x, y);
  }

  // Bolts: a white + where one is needed, an amber nut to fasten, a green nut when done.
  for (const b of S.bolts) {
    if (b.state === 'hidden' || b.state === 'internal') continue;
    const [x, y] = P(b.x, b.y, b.z - sag);
    const r = Math.max(3, k * 1.8);
    if (b.state === 'fastened') { hexagon(g, x, y, r * 0.8); g.fillStyle = '#22c55e'; g.fill(); g.strokeStyle = '#14532d'; g.lineWidth = 1; g.stroke(); continue; }
    if (b.state === 'needed') {
      const pulse = 1 + 0.25 * Math.sin(now * 6);
      g.strokeStyle = 'rgba(255,255,255,0.6)'; g.lineWidth = 2;
      g.beginPath(); g.arc(x, y, r * 1.9 * pulse, 0, 7); g.stroke();
      g.fillStyle = '#ffffff'; g.strokeStyle = '#0f172a'; g.lineWidth = 2;
      g.beginPath(); g.arc(x, y, r, 0, 7); g.fill(); g.stroke();
      g.fillStyle = '#0f172a'; g.font = `800 ${r * 1.7}px system-ui`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('+', x, y + 0.5);
      g.textBaseline = 'alphabetic';
      continue;
    }
    // Placed, nut still to fasten.
    const flash = b.flashing && Math.sin(now * 14) > 0;
    hexagon(g, x, y, r * (b.flashing ? 1.3 : 1.05));
    g.fillStyle = flash ? '#ef4444' : '#f59e0b'; g.fill(); g.strokeStyle = '#78350f'; g.lineWidth = 1.5; g.stroke();
    if (b.progress > 0) {
      g.strokeStyle = '#22c55e'; g.lineWidth = 3.5; g.lineCap = 'round';
      g.beginPath(); g.arc(x, y, r + 5, -Math.PI / 2, -Math.PI / 2 + (Math.PI * 2 * b.progress) / S.settings.fastenTime); g.stroke();
      g.lineCap = 'butt';
    }
  }

  // Where to hold the bridge.
  const sup = S.support;
  if ((sup.needed || sup.fallen) && !sup.standing) {
    for (const p of holdPoints(S)) {
      const held = [...sup.holders.values()].some((h) => h.key === p.key);
      const [x, y] = P(p.x, p.y, p.z + 4);
      const s = 7 + (held ? 0 : 2 * Math.sin(now * 6));
      if (!held) { g.fillStyle = 'rgba(250,204,21,0.25)'; g.beginPath(); g.arc(x, y, s * 2, 0, 7); g.fill(); }
      g.fillStyle = held ? 'rgba(34,197,94,0.95)' : 'rgba(250,204,21,0.95)'; g.strokeStyle = '#713f12'; g.lineWidth = 1.5;
      poly(g, [[x, y - s], [x + s, y], [x, y + s], [x - s, y]]); g.fill(); g.stroke();
    }
  }

  drawFx(g, V, ui);
  // Prompts and labels on top of everything.
  for (const a of S.actors) drawActorTop(g, S, V, a, ui);
  g.restore();

  drawHud(g, S, V, ui);
}

function hexagon(g, x, y, r) {
  g.beginPath();
  for (let i = 0; i < 6; i++) { const a = Math.PI / 6 + (i * Math.PI) / 3; const px = x + r * Math.cos(a), py = y + r * Math.sin(a) * 0.8; i ? g.lineTo(px, py) : g.moveTo(px, py); }
  g.closePath();
}
function chip(g, x, y, text, color, k) {
  g.font = `800 ${Math.max(9, k * 3.2)}px system-ui`;
  const w = g.measureText(text).width + 10, h = Math.max(14, k * 4.8);
  rrect(g, x - w / 2, y - h / 2, w, h, h / 2); g.fillStyle = color; g.fill();
  g.fillStyle = '#fff'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(text, x, y + 0.5);
  g.textBaseline = 'alphabetic';
}

// A member's corner (bridge x, y, z) to site (x, y, z), offset to one face of its thickness and
// optionally shifted (a piece laid out in staging).
function mmSite(mm, c, sgn, off, sag, sh) {
  const [x, y] = mm.toSite(c[0] + sgn * off[0], c[1] + sgn * off[1]);
  return sh ? [x + sh.dx, y + sh.dy, c[2] + sgn * off[2] + sh.dz] : [x, y, c[2] + sgn * off[2] - sag];
}
function faces(P, mm, sag, sh) {
  const m = mm.m, h = m.thick / 2;
  const off = m.plane === 'L' ? [0, 0, h] : [0, h, 0];
  return {
    lo: m.corners3.map((c) => mmSite(mm, c, -1, off, sag, sh)),
    hi: m.corners3.map((c) => mmSite(mm, c, 1, off, sag, sh)),
  };
}
// Sunlight from the upper left: a soft shadow cast onto the ground.
function drawShadow(g, P, mm, sh, sag) {
  if (!mm) return;
  const { lo, hi } = faces(P, mm, sag, sh);
  g.fillStyle = 'rgba(15,23,42,0.13)';
  for (const f of [lo, hi]) {
    poly(g, f.map(([x, y, z]) => P(x + z * 0.35, y + z * 0.55, 0)));
    g.fill();
  }
}
function drawMember(g, P, mm, o) {
  const { lo, hi } = faces(P, mm, o.sag || 0, o.shift);
  const lo2 = lo.map((p) => P(...p)), hi2 = hi.map((p) => P(...p));
  if (o.ghost) {
    poly(g, hi2);
    g.setLineDash([3, 3]); g.strokeStyle = 'rgba(30,41,59,0.28)'; g.lineWidth = 1; g.stroke(); g.setLineDash([]);
    return;
  }
  if (o.glow) {
    poly(g, hi2);
    g.fillStyle = o.glow; g.globalAlpha = 0.25 + 0.35 * o.pulse; g.fill(); g.globalAlpha = 1;
    g.strokeStyle = o.glow; g.lineWidth = 2.5; g.stroke();
    return;
  }
  // Sides: join the two faces so the steel has some depth.
  g.fillStyle = shade(o.color, 0.5);
  for (let i = 0; i < lo2.length; i++) {
    const j = (i + 1) % lo2.length;
    poly(g, [lo2[i], lo2[j], hi2[j], hi2[i]]); g.fill();
  }
  poly(g, lo2); g.fillStyle = shade(o.color, 0.62); g.fill();
  // Top face with a brushed-steel sheen.
  poly(g, hi2);
  const ys = hi2.map((p) => p[1]);
  const gr = g.createLinearGradient(0, Math.min(...ys), 0, Math.max(...ys));
  gr.addColorStop(0, shade(o.color, 1.35)); gr.addColorStop(0.5, o.color); gr.addColorStop(1, shade(o.color, 0.82));
  g.fillStyle = gr; g.fill();
  g.strokeStyle = o.outline || shade(o.color, 0.42); g.lineWidth = o.outline ? 3 : 1; g.stroke();
}

function drawPieceIcon(g, x, y, it, k, color) {
  const n = it.memberIds.length;
  const w = Math.max(18, k * 10), hh = Math.max(3, k * 1.4);
  for (let i = 0; i < n; i++) {
    const yy = y - 6 + i * (hh + 1.5) - (n * (hh + 1.5)) / 2 + 4;
    rrect(g, x - w / 2, yy, w, hh, 1.5); g.fillStyle = color; g.fill();
    g.fillStyle = 'rgba(255,255,255,0.35)'; g.fillRect(x - w / 2 + 1, yy, w - 2, 1);
  }
  chip(g, x, y - 13, '#' + (it.idx + 1) + (it.buddy ? '★' : ''), it.buddy ? '#b45309' : '#0f172a', k);
}

// A builder: boots, a body in their color with a hi-vis stripe, a face, and a hard hat.
function drawActor(g, S, V, a, ui) {
  const { P, k } = V;
  const [sx, sy] = P(a.x, a.y, 0);
  const step = a.moving ? Math.sin(ui.now * 14 + a.x) : 0;
  const bob = a.moving ? Math.abs(step) * 1.5 : 0;
  const w = R * k * 1.5;
  // Boots
  g.fillStyle = '#1f2937';
  for (const s of [-1, 1]) { const lift = a.moving ? Math.max(0, s * step) * 2 * k : 0; rrect(g, sx + s * w * 0.22 - w * 0.17, sy - 3 * k - lift, w * 0.34, 3.2 * k, 1.5); g.fill(); }
  const top = P(a.x, a.y, 25 + bob), head = P(a.x, a.y, 32 + bob);
  const body = a.npc ? '#64748b' : a.color;
  rrect(g, sx - w / 2, top[1], w, sy - top[1] - 2 * k, w / 2.4);
  const bg = g.createLinearGradient(sx - w / 2, 0, sx + w / 2, 0);
  bg.addColorStop(0, shade(body, 1.25)); bg.addColorStop(1, shade(body, 0.8));
  g.fillStyle = bg; g.fill();
  g.strokeStyle = shade(body, 0.5); g.lineWidth = 1.5; g.stroke();
  // Hi-vis stripe
  const sty = top[1] + (sy - top[1]) * 0.42;
  g.fillStyle = 'rgba(253,224,71,0.9)'; g.fillRect(sx - w / 2 + 1, sty, w - 2, Math.max(2, k * 1.2));
  // Arms up holding the bridge or a piece.
  if (a.anchor) {
    const hz = a.anchor.kind === 'bridge' ? 18 : 22;
    g.strokeStyle = shade(body, 0.75); g.lineWidth = Math.max(2.5, k * 1.4); g.lineCap = 'round';
    for (const s of [-1, 1]) { const p = P(a.x + s * 4, a.y, hz + bob); g.beginPath(); g.moveTo(sx + s * w / 2.4, top[1] + 4); g.lineTo(p[0], p[1]); g.stroke(); }
    g.lineCap = 'butt';
  }
  // Head and face, looking the way they last moved.
  const hr = R * k * 0.72;
  g.beginPath(); g.arc(head[0], head[1], hr, 0, 7);
  g.fillStyle = '#fcd9b6'; g.fill(); g.strokeStyle = '#b07a54'; g.lineWidth = 1; g.stroke();
  const fx = (a.face?.[0] || 0) * hr * 0.35, fy = (a.face?.[1] || 0) * hr * 0.15;
  g.fillStyle = '#1f2937';
  for (const s of [-1, 1]) { g.beginPath(); g.arc(head[0] + fx + s * hr * 0.32, head[1] + fy + hr * 0.1, Math.max(1, hr * 0.12), 0, 7); g.fill(); }
  if (a.work) { g.strokeStyle = '#7c2d12'; g.lineWidth = 1; g.beginPath(); g.arc(head[0] + fx, head[1] + fy + hr * 0.42, hr * 0.18, 0, Math.PI); g.stroke(); }
  // Hard hat
  const hat = a.npc ? '#e2e8f0' : '#facc15';
  g.beginPath(); g.ellipse(head[0], head[1] - hr * 0.15, hr * 1.25, hr * 0.32, 0, 0, 7); g.fillStyle = shade(hat, 0.85); g.fill();
  g.beginPath(); g.arc(head[0], head[1] - hr * 0.2, hr * 0.95, Math.PI, 0); g.closePath();
  const hg = g.createLinearGradient(0, head[1] - hr * 1.2, 0, head[1]);
  hg.addColorStop(0, shade(hat, 1.15)); hg.addColorStop(1, shade(hat, 0.85));
  g.fillStyle = hg; g.fill(); g.strokeStyle = shade(hat, 0.55); g.lineWidth = 1; g.stroke();
  g.fillStyle = a.npc ? '#475569' : a.color; g.fillRect(head[0] - hr * 0.12, head[1] - hr * 1.1, hr * 0.24, hr * 0.9);
  // Player number on the chest
  g.fillStyle = '#fff'; g.font = `900 ${Math.max(9, k * 3.4)}px system-ui`; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.lineWidth = 2.5; g.strokeStyle = 'rgba(15,23,42,0.6)';
  const label = a.npc ? 'AI' : String(ui.numberOf(a));
  const ly = top[1] + (sy - top[1]) * 0.7;
  g.strokeText(label, sx, ly); g.fillText(label, sx, ly);
  g.textBaseline = 'alphabetic';
}

function drawActorTop(g, S, V, a, ui) {
  const { P, k } = V;
  let [x, y] = P(a.x, a.y, 46);
  if (a.carrying) {
    const it = S.items.find((q) => q.id === a.carrying);
    const ex = a.extending ? a.face[0] * 14 : 0, ey = a.extending ? a.face[1] * 14 : 0;
    const [ix, iy] = P(a.x + ex, a.y + ey, a.extending ? 30 : 44);
    drawPieceIcon(g, ix, iy, it, k, a.extending ? '#b45309' : '#475569');
    y -= 20;
  }
  // Holding the bridge: how many times it has grown since moving out (two drops it).
  const h = S.support.holders.get(a.id);
  if (h) {
    for (let i = 0; i < 2; i++) {
      g.beginPath(); g.arc(x - 6 + i * 12, y - 4, 4, 0, 7);
      g.fillStyle = i < h.stale ? '#ef4444' : 'rgba(255,255,255,0.85)'; g.fill();
      g.strokeStyle = '#7f1d1d'; g.lineWidth = 1; g.stroke();
    }
    y -= 12;
  }
  if (a.work?.kind === 'assemble') {
    const it = a.work.target;
    const [wx, wy] = P(a.x, a.y, 50);
    g.strokeStyle = 'rgba(15,23,42,0.5)'; g.lineWidth = 5; g.beginPath(); g.arc(wx, wy - 6, 9, 0, 7); g.stroke();
    g.strokeStyle = '#22c55e'; g.lineWidth = 4; g.lineCap = 'round';
    g.beginPath(); g.arc(wx, wy - 6, 9, -Math.PI / 2, -Math.PI / 2 + (Math.PI * 2 * it.progress) / it.time); g.stroke();
    g.lineCap = 'butt';
    // A little hammer swing
    const sw = Math.sin(ui.now * 16) * 0.6;
    g.save(); g.translate(wx + 16, wy - 6); g.rotate(sw);
    g.fillStyle = '#92400e'; g.fillRect(-1, -2, 2.5, 11); g.fillStyle = '#475569'; g.fillRect(-4, -4, 9, 4); g.restore();
  }
  if (a.npc || !a.prompt) return;
  const chips = [['A', a.prompt.A], ['X', a.prompt.X], ['LB', a.prompt.LB]].filter(([, p]) => p && p.kind !== 'holding');
  if (!chips.length) return;
  // Keyboard players see their keys; controller players see the buttons.
  const keyOf = ui.keysOf(a);
  const cap = (b) => (keyOf ? keyOf[b] : b);
  const pad = 4, gap = 4, bh = Math.max(16, k * 5.6);
  g.font = `800 ${Math.max(9, k * 3)}px system-ui`;
  const bws = chips.map(([b]) => Math.max(bh - 4, g.measureText(cap(b)).width + 10));
  g.font = `600 ${Math.max(10, k * 3.4)}px system-ui`;
  const widths = chips.map(([, p], i) => g.measureText(p.label).width + bws[i] + pad * 2 + 6);
  const total = widths.reduce((s, w) => s + w, 0) + gap * (chips.length - 1);
  let cx = x - total / 2;
  const cy = y - bh - 6 + Math.sin(ui.now * 3 + a.x) * 1.2;
  chips.forEach(([b, p], i) => {
    rrect(g, cx, cy + 2, widths[i], bh, bh / 2); g.fillStyle = 'rgba(0,0,0,0.25)'; g.fill();
    rrect(g, cx, cy, widths[i], bh, bh / 2);
    g.fillStyle = 'rgba(15,23,42,0.9)'; g.fill(); g.strokeStyle = 'rgba(255,255,255,0.15)'; g.lineWidth = 1; g.stroke();
    const bw = bws[i];
    rrect(g, cx + 2, cy + 2, bw, bh - 4, (bh - 4) / 2);
    g.fillStyle = BTN[b]; g.fill();
    g.fillStyle = '#fff'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.font = `800 ${Math.max(9, k * 3)}px system-ui`;
    g.fillText(cap(b), cx + 2 + bw / 2, cy + bh / 2 + 0.5);
    g.font = `600 ${Math.max(10, k * 3.4)}px system-ui`;
    g.textAlign = 'left';
    g.fillText(p.label, cx + bw + 6, cy + bh / 2 + 0.5);
    g.textBaseline = 'alphabetic';
    cx += widths[i] + gap;
  });
}

function drawHud(g, S, V, ui) {
  const { W, H } = V;
  const top = g.createLinearGradient(0, 0, 0, HUD_TOP);
  top.addColorStop(0, 'rgba(8,12,20,0.98)'); top.addColorStop(1, 'rgba(15,23,42,0.92)');
  g.fillStyle = top; g.fillRect(0, 0, W, HUD_TOP - 6);
  g.fillStyle = '#facc15'; g.fillRect(0, HUD_TOP - 8, W, 2);
  g.textBaseline = 'middle';
  g.textAlign = 'left';
  g.font = '900 21px system-ui';
  g.fillStyle = '#92400e'; g.fillText('OVER ENGINEERED', 18, 26);
  g.fillStyle = '#facc15'; g.fillText('OVER ENGINEERED', 16, 24);
  g.fillStyle = '#94a3b8'; g.font = '500 12px system-ui';
  g.fillText((S.project.name || 'Bridge') + ' · ' + (S.site.name || ''), 16, 46);

  g.textAlign = 'center';
  rrect(g, W / 2 - 78, 6, 156, 38, 12); g.fillStyle = 'rgba(255,255,255,0.06)'; g.fill();
  g.fillStyle = '#fff'; g.font = '800 30px ui-monospace, monospace';
  g.fillText(fmt(S.t), W / 2, 26);
  if (S.penalties) { g.fillStyle = '#f87171'; g.font = '700 13px system-ui'; g.fillText('+' + S.penalties + ' s penalties', W / 2, 52); }

  const placed = S.items.filter((it) => it.status === 'placed').length;
  const nuts = S.bolts.filter((b) => b.state !== 'internal');
  const fastened = nuts.filter((b) => b.state === 'fastened').length;
  g.textAlign = 'right'; g.font = '700 14px system-ui'; g.fillStyle = '#e2e8f0';
  g.fillText(`🧱 ${placed}/${S.items.length}   🔩 ${fastened}/${nuts.length}   💥 ${S.falls.length}`, W - 16, 24);
  g.font = '500 12px system-ui'; g.fillStyle = '#94a3b8';
  g.fillText(ui.paused ? 'Paused' : `Esc / Start: pause · M: sound ${ui.muted ? 'off' : 'on'}`, W - 16, 46);

  // The build order
  const n = S.items.length;
  const cw = Math.min(30, (W - 32) / n);
  const x0 = W / 2 - (cw * n) / 2;
  const COL = { waiting: '#334155', building: '#1d4ed8', shelf: '#16a34a', carried: '#ca8a04', placed: '#0f172a' };
  S.items.forEach((it, i) => {
    const x = x0 + i * cw;
    g.fillStyle = it.loose ? '#f59e0b' : COL[it.status];
    rrect(g, x + 1, 62, cw - 2, 18, 4); g.fill();
    if (it.status === 'building') { g.fillStyle = '#60a5fa'; g.fillRect(x + 1, 76, ((cw - 2) * it.progress) / it.time, 4); }
    if (cw >= 18) {
      g.fillStyle = it.status === 'placed' ? '#475569' : '#fff'; g.font = `700 ${cw >= 24 ? 10 : 8}px system-ui`; g.textAlign = 'center';
      g.fillText((it.multi ? '▦' : '') + (i + 1), x + cw / 2, 71.5);
    }
  });

  // Player cards
  const humans = S.actors;
  const cardW = Math.min(300, (W - 20) / humans.length - 8);
  humans.forEach((a, i) => {
    const x = W / 2 - (humans.length * (cardW + 8)) / 2 + i * (cardW + 8) + 4, y = H - HUD_BOTTOM + 10;
    rrect(g, x, y, cardW, HUD_BOTTOM - 20, 10);
    g.fillStyle = 'rgba(10,15,25,0.9)'; g.fill();
    g.strokeStyle = (a.npc ? '#64748b' : a.color) + '88'; g.lineWidth = 2; g.stroke();
    g.fillStyle = a.npc ? '#64748b' : a.color; g.fillRect(x + 1, y + 8, 5, HUD_BOTTOM - 36);
    g.textAlign = 'left'; g.fillStyle = '#fff'; g.font = '700 14px system-ui';
    g.fillText((a.npc ? '' : ui.numberOf(a) + '  ') + a.name, x + 14, y + 16);
    g.fillStyle = '#cbd5e1'; g.font = '500 12px system-ui';
    g.fillText(activityText(S, a), x + 14, y + 36);
    g.fillStyle = '#64748b'; g.font = '500 11px system-ui';
    g.fillText(a.npc ? (a.npc === 'holder' ? 'Holds the bridge, then bolts buddy pieces' : 'Makes every assembly') : ui.deviceOf(a), x + 14, y + 54);
  });

  // Messages
  const sup = S.support;
  let msg = null, color = '#dc2626';
  if (sup.fallen) msg = 'The bridge fell! Someone hold it up (LB) to keep building';
  else if (sup.needed && !sup.holders.size) msg = `Hold the bridge up! ${Math.max(0, S.settings.grace - sup.grace).toFixed(1)}`;
  else if (S.allBuilt && !S.done) { msg = 'All built! Everyone back to a staging yard'; color = '#16a34a'; }
  if (msg) banner(g, W, HUD_TOP + 22, msg, color, 1, sup.needed && !sup.holders.size && !sup.fallen ? 1 + 0.05 * Math.sin(ui.now * 18) : 1);
  let yb = HUD_TOP + (msg ? 58 : 22);
  for (const b of ui.banners) {
    const age = ui.now - b.t0;
    if (age > 2.6) continue;
    const pop = age < 0.15 ? 0.8 + (age / 0.15) * 0.2 : 1;
    banner(g, W, yb, b.text, b.color, Math.min(1, (2.6 - age) / 0.5), pop);
    yb += 34;
  }
  g.textBaseline = 'alphabetic';
}

function banner(g, W, y, text, color, alpha, scale = 1) {
  g.save();
  g.globalAlpha = alpha;
  g.translate(W / 2, y); g.scale(scale, scale);
  g.font = '800 18px system-ui';
  const w = g.measureText(text).width + 36;
  rrect(g, -w / 2, -13, w, 30, 15); g.fillStyle = 'rgba(0,0,0,0.3)'; g.fill();
  rrect(g, -w / 2, -15, w, 30, 15);
  g.fillStyle = color; g.fill();
  g.fillStyle = '#fff'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(text, 0, 1);
  g.restore();
}

function activityText(S, a) {
  if (a.anchor?.locked) return 'Holding a buddy piece: someone else bolts it';
  if (S.support.holders.has(a.id)) return 'Holding the bridge' + (a.work ? ' + fastening' : '');
  if (a.anchor?.kind === 'piece') return 'Holding a piece until it has its bolts';
  if (a.work?.kind === 'fasten') return 'Fastening';
  if (a.work?.kind === 'assemble') return 'Making assembly #' + (a.work.target.idx + 1);
  if (a.extending) return 'Passing a piece';
  if (a.carrying) { const it = S.items.find((q) => q.id === a.carrying); return 'Carrying #' + (it.idx + 1) + (it.buddy ? ' (buddy piece)' : ''); }
  return a.moving ? 'Walking' : 'Ready';
}
