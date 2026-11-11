// Drawing the game: a tilted top-down view of the site, with heights shown by lifting things up the
// screen, so top chords, bottom chords and laterals read as above or below each other.
import { benchSlot, buildingItems, holdPoints, shelfItems, shelfSlot, R } from './world.js';

// Screen units per inch of ground depth (y) and of height (z). The ground stretches to fill a
// tall screen; heights are exaggerated a little so above and below are easy to tell apart.
let YF = 1.0, ZF = 1.35;
const HUD_TOP = 92, HUD_BOTTOM = 86;

const ZONE_FILL = {
  staging: '#cfe0fb', construction: '#d5f0d9', riverbank: '#d3ecb0', transport: '#e3e8ef',
  footing: '#cfa676', assembly: '#eadcfb', walkway: '#e5e7eb',
};
const PLANE = { A: '#5d6f88', B: '#4d5c73', L: '#7466c9' };
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

export function draw(g, S, V, ui) {
  const { P, k, W, H } = V;
  const t = S.t, now = ui.now;
  g.fillStyle = '#16202f';
  g.fillRect(0, 0, W, H);

  // Ground
  const site = S.site;
  const ground = (x, y, w, h) => [P(x, y), P(x + w, y), P(x + w, y + h), P(x, y + h)];
  poly(g, ground(0, 0, site.width, site.depth));
  g.fillStyle = '#eef1f5'; g.fill();
  const zones = [...site.zones].sort((a, b) => (a.type === 'footing') - (b.type === 'footing'));
  for (const z of zones) {
    if (z.type === 'nogo') {
      poly(g, ground(z.x, z.y, z.w, z.h));
      const grad = g.createLinearGradient(0, P(0, z.y)[1], 0, P(0, z.y + z.h)[1]);
      grad.addColorStop(0, '#3b82f6'); grad.addColorStop(1, '#1d4ed8');
      g.fillStyle = grad; g.fill();
      g.save(); g.clip();
      g.strokeStyle = 'rgba(255,255,255,0.25)'; g.lineWidth = 2;
      for (let yy = z.y - 20; yy < z.y + z.h + 20; yy += 14) {
        g.beginPath();
        for (let xx = z.x; xx <= z.x + z.w; xx += 4) { const p = P(xx, yy + Math.sin(xx / 9 + now * 2 + yy) * 2.5); xx === z.x ? g.moveTo(...p) : g.lineTo(...p); }
        g.stroke();
      }
      g.restore();
      continue;
    }
    const fill = ZONE_FILL[z.type];
    if (!fill) continue;
    poly(g, ground(z.x, z.y, z.w, z.h));
    g.fillStyle = fill; g.fill();
    g.strokeStyle = 'rgba(15,23,42,0.12)'; g.lineWidth = 1; g.stroke();
  }
  g.font = `600 ${Math.max(10, k * 4.2)}px system-ui, sans-serif`;
  g.fillStyle = 'rgba(15,23,42,0.28)';
  g.textAlign = 'center';
  for (const z of site.zones) {
    if (!ZONE_FILL[z.type] && z.type !== 'nogo') continue;
    if (z.type === 'footing' || z === S.yard) continue;
    const [x, y] = P(z.x + z.w / 2, z.y + z.h - 6);
    g.fillStyle = z.type === 'nogo' ? 'rgba(255,255,255,0.55)' : 'rgba(15,23,42,0.28)';
    g.fillText(z.name, x, y);
  }

  // Staging: the ready area and the assembly area, side by side in the yard.
  for (const [r, fill, edge, name] of [[S.ready, 'rgba(250,204,21,0.22)', '#ca8a04', 'Ready area'], [S.assembly, 'rgba(37,99,235,0.16)', '#2563eb', 'Assembly area']]) {
    poly(g, ground(r.x + 2, r.y + 2, r.w - 4, r.h - 4));
    g.fillStyle = fill; g.fill();
    g.setLineDash([6, 4]); g.strokeStyle = edge; g.lineWidth = 1.5; g.stroke(); g.setLineDash([]);
    const [x, y] = P(r.x + r.w / 2, r.y + r.h - 6);
    g.fillStyle = 'rgba(15,23,42,0.4)'; g.textAlign = 'center';
    g.fillText(name, x, y);
  }

  // The bridge still to build, faintly.
  const carriedBy = new Map(S.actors.filter((a) => a.carrying).map((a) => [a.carrying, a]));
  g.lineWidth = 1;
  for (const [id, mm] of S.members) {
    if (S.installed.has(id)) continue;
    const it = S.itemOf.get(id);
    const a = it && carriedBy.get(it.id);
    drawMember(g, P, mm, null, a ? { glow: a.color, pulse: 0.5 + 0.5 * Math.sin(now * 6) } : { ghost: true });
  }

  // Installed pieces and builders, back to front.
  const list = [];
  for (const id of S.installed) {
    const mm = S.members.get(id);
    const ys = mm.m.corners3.map((c) => c[1]);
    list.push({ y: S.toSite(0, Math.max(...ys))[1] + (mm.m.plane === 'L' ? -10 : 0), mm });
  }
  for (const a of S.actors) list.push({ y: a.y, a });
  list.sort((p, q) => p.y - q.y);
  const sag = S.support.fallen ? 3 + Math.sin(now * 20) * 0.6 : 0;
  for (const d of list) {
    if (d.mm) {
      const it = S.itemOf.get(d.mm.m.id);
      const loose = it?.loose;
      drawMember(g, P, d.mm, null, { color: S.support.fallen ? '#dc2626' : loose ? (Math.sin(now * 8) > 0 ? '#f59e0b' : '#fbbf24') : PLANE[d.mm.m.plane], sag });
    } else drawActor(g, S, V, d.a, ui);
  }

  // Bolts
  for (const b of S.bolts) {
    if (b.state === 'hidden' || b.state === 'internal') continue;
    const [x, y] = P(b.x, b.y, b.z - sag);
    const r = Math.max(3, k * 1.8);
    if (b.state === 'fastened') { g.fillStyle = '#16a34a'; g.beginPath(); g.arc(x, y, r * 0.7, 0, 7); g.fill(); continue; }
    if (b.state === 'needed') {
      const pulse = 1 + 0.25 * Math.sin(now * 6);
      g.fillStyle = '#ffffff'; g.strokeStyle = '#0f172a'; g.lineWidth = 2;
      g.beginPath(); g.arc(x, y, r * pulse, 0, 7); g.fill(); g.stroke();
      g.fillStyle = '#0f172a'; g.font = `700 ${r * 1.6}px system-ui`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('+', x, y + 0.5);
      g.textBaseline = 'alphabetic';
      continue;
    }
    // Placed, nut still to fasten.
    const flash = b.flashing && Math.sin(now * 14) > 0;
    g.fillStyle = flash ? '#ef4444' : '#f59e0b'; g.strokeStyle = '#78350f'; g.lineWidth = 1.5;
    g.beginPath(); g.arc(x, y, r * (b.flashing ? 1.25 : 1), 0, 7); g.fill(); g.stroke();
    if (b.progress > 0) {
      g.strokeStyle = '#16a34a'; g.lineWidth = 3;
      g.beginPath(); g.arc(x, y, r + 4, -Math.PI / 2, -Math.PI / 2 + (Math.PI * 2 * b.progress) / S.settings.fastenTime); g.stroke();
    }
  }

  // Items waiting in the ready area (the next one to be grabbed is ringed), and assemblies being made.
  shelfItems(S).forEach((it, i) => {
    const p = shelfSlot(S, it);
    const [x, y] = P(p.x, p.y, 2);
    if (i === 0) { g.strokeStyle = '#ca8a04'; g.lineWidth = 2.5; g.beginPath(); g.ellipse(x, y - 4, k * 10, k * 6, 0, 0, 7); g.stroke(); }
    drawPieceIcon(g, x, y, it, k, i === 0 ? '#0f172a' : '#475569');
  });
  for (const it of buildingItems(S)) {
    const p = benchSlot(S, it);
    const [x, y] = P(p.x, p.y, 2);
    drawPieceIcon(g, x, y, it, k, '#1e3a8a');
    const w = 18 * k;
    g.fillStyle = 'rgba(15,23,42,0.6)'; g.fillRect(x - w / 2, y + 6, w, 5);
    g.fillStyle = '#22c55e'; g.fillRect(x - w / 2, y + 6, (w * it.progress) / it.time, 5);
  }
  if (!buildingItems(S).length && S.items.some((x) => x.multi && x.status === 'waiting')) {
    const [x, y] = P(S.assembly.x + S.assembly.w / 2, S.assembly.y + S.assembly.h * 0.4, 0);
    g.fillStyle = 'rgba(15,23,42,0.5)'; g.font = `600 ${Math.max(10, k * 3.4)}px system-ui`; g.textAlign = 'center';
    g.fillText('Hold X here to assemble', x, y);
  }

  // Where to hold the bridge.
  const sup = S.support;
  if ((sup.needed || sup.fallen) && !sup.standing) {
    const pts = holdPoints(S);
    for (const p of pts) {
      const held = [...sup.holders.values()].some((h) => h.key === p.key);
      const [x, y] = P(p.x, p.y, p.z + 4);
      const s = 7 + (held ? 0 : 2 * Math.sin(now * 6));
      g.fillStyle = held ? 'rgba(34,197,94,0.9)' : 'rgba(250,204,21,0.95)'; g.strokeStyle = '#713f12'; g.lineWidth = 1.5;
      poly(g, [[x, y - s], [x + s, y], [x, y + s], [x - s, y]]); g.fill(); g.stroke();
    }
  }
  // Prompts and labels on top of everything.
  for (const a of S.actors) drawActorTop(g, S, V, a, ui);

  drawHud(g, S, V, ui);
}

function drawMember(g, P, mm, _unused, o) {
  const m = mm.m;
  const h = m.thick / 2;
  const sag = o.sag || 0;
  const off = m.plane === 'L' ? [0, 0, h] : [0, h, 0];
  const lo = m.corners3.map((c) => P(...mm_site(mm, c, -1, off, sag)));
  const hi = m.corners3.map((c) => P(...mm_site(mm, c, 1, off, sag)));
  if (o.ghost) {
    poly(g, hi);
    g.setLineDash([3, 3]); g.strokeStyle = 'rgba(30,41,59,0.28)'; g.lineWidth = 1; g.stroke(); g.setLineDash([]);
    return;
  }
  if (o.glow) {
    poly(g, hi);
    g.fillStyle = o.glow; g.globalAlpha = 0.25 + 0.35 * o.pulse; g.fill(); g.globalAlpha = 1;
    g.strokeStyle = o.glow; g.lineWidth = 2.5; g.stroke();
    return;
  }
  poly(g, lo); g.fillStyle = shade(o.color, 0.62); g.fill();
  poly(g, hi); g.fillStyle = o.color; g.fill();
  g.strokeStyle = shade(o.color, 0.45); g.lineWidth = 1; g.stroke();
}
// A member's corner (bridge x, y, z) to site (x, y, z), offset to one face of its thickness.
function mm_site(mm, c, sgn, off, sag) {
  return [...mm.toSite(c[0] + sgn * off[0], c[1] + sgn * off[1]), c[2] + sgn * off[2] - sag];
}

function drawPieceIcon(g, x, y, it, k, color) {
  const n = it.memberIds.length;
  const w = Math.max(16, k * 9), hh = 3;
  for (let i = 0; i < n; i++) { g.fillStyle = color; g.fillRect(x - w / 2, y - 6 + i * (hh + 1.5) - (n * (hh + 1.5)) / 2 + 4, w, hh); }
  g.fillStyle = it.buddy ? '#b45309' : '#0f172a';
  g.font = `700 ${Math.max(9, k * 3.2)}px system-ui`; g.textAlign = 'center';
  g.fillText('#' + (it.idx + 1) + (it.buddy ? '★' : ''), x, y - 9);
}

function drawActor(g, S, V, a, ui) {
  const { P, k } = V;
  const [sx, sy] = P(a.x, a.y, 0);
  g.fillStyle = 'rgba(15,23,42,0.25)';
  g.beginPath(); g.ellipse(sx, sy, R * k, R * k * 0.45 * YF, 0, 0, 7); g.fill();
  const bob = a.moving ? Math.abs(Math.sin(ui.now * 12)) * 1.5 : 0;
  const top = P(a.x, a.y, 26 + bob), head = P(a.x, a.y, 33 + bob);
  const w = R * k * 1.5;
  rrect(g, sx - w / 2, top[1], w, sy - top[1], w / 2.2);
  g.fillStyle = a.color; g.fill();
  g.strokeStyle = shade(a.color, 0.55); g.lineWidth = 1.5; g.stroke();
  g.beginPath(); g.arc(head[0], head[1], R * k * 0.72, 0, 7);
  g.fillStyle = '#fde7c8'; g.fill(); g.stroke();
  // Arms up holding the bridge or a piece.
  if (a.anchor) {
    const hz = a.anchor.kind === 'bridge' ? 18 : 22;
    g.strokeStyle = shade(a.color, 0.7); g.lineWidth = Math.max(2, k * 1.2);
    for (const s of [-1, 1]) { const p = P(a.x + s * 4, a.y, hz); g.beginPath(); g.moveTo(sx + s * w / 2.4, top[1] + 4); g.lineTo(p[0], p[1]); g.stroke(); }
  }
  g.fillStyle = '#fff'; g.font = `800 ${Math.max(9, k * 3.4)}px system-ui`; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(a.npc ? 'AI' : String(ui.numberOf(a)), sx, (top[1] + sy) / 2 + 2);
  g.textBaseline = 'alphabetic';
}

function drawActorTop(g, S, V, a, ui) {
  const { P, k } = V;
  let [x, y] = P(a.x, a.y, 44);
  if (a.carrying) {
    const it = S.items.find((q) => q.id === a.carrying);
    const ex = a.extending ? a.face[0] * 14 : 0, ey = a.extending ? a.face[1] * 14 : 0;
    const [ix, iy] = P(a.x + ex, a.y + ey, a.extending ? 30 : 44);
    drawPieceIcon(g, ix, iy, it, k, a.extending ? '#b45309' : '#334155');
    y -= 14;
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
  if (a.work) {
    const [wx, wy] = a.work.kind === 'fasten' ? P(a.work.target.x, a.work.target.y, a.work.target.z) : P(a.x, a.y, 50);
    if (a.work.kind === 'assemble') {
      const it = S.items.find((q) => q.id === a.work.target.itemId);
      if (it) { g.strokeStyle = '#22c55e'; g.lineWidth = 4; g.beginPath(); g.arc(wx, wy - 6, 9, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * it.progress / it.time); g.stroke(); }
    }
  }
  if (a.npc || !a.prompt) return;
  const chips = [['A', a.prompt.A], ['X', a.prompt.X], ['LB', a.prompt.LB]].filter(([, p]) => p && p.kind !== 'holding');
  if (!chips.length) return;
  // Keyboard players see their keys; controller players see the buttons.
  const keyOf = ui.keysOf(a);
  const cap = (b) => (keyOf ? keyOf[b] : b);
  const pad = 4, gap = 4, bh = Math.max(15, k * 5.4);
  g.font = `800 ${Math.max(9, k * 3)}px system-ui`;
  const bws = chips.map(([b]) => Math.max(bh - 4, g.measureText(cap(b)).width + 10));
  g.font = `600 ${Math.max(10, k * 3.4)}px system-ui`;
  const widths = chips.map(([, p], i) => g.measureText(p.label).width + bws[i] + pad * 2 + 6);
  const total = widths.reduce((s, w) => s + w, 0) + gap * (chips.length - 1);
  let cx = x - total / 2;
  const cy = y - bh - 6;
  chips.forEach(([b, p], i) => {
    rrect(g, cx, cy, widths[i], bh, bh / 2);
    g.fillStyle = 'rgba(15,23,42,0.85)'; g.fill();
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
  g.fillStyle = 'rgba(10,15,25,0.92)';
  g.fillRect(0, 0, W, HUD_TOP - 6);
  g.textBaseline = 'middle';
  g.textAlign = 'left';
  g.fillStyle = '#facc15'; g.font = '900 20px system-ui';
  g.fillText('OVER ENGINEERED', 16, 24);
  g.fillStyle = '#94a3b8'; g.font = '500 12px system-ui';
  g.fillText((S.project.name || 'Bridge') + ' · ' + (S.site.name || ''), 16, 46);

  g.textAlign = 'center';
  g.fillStyle = '#fff'; g.font = '800 32px ui-monospace, monospace';
  g.fillText(fmt(S.t), W / 2, 26);
  if (S.penalties) { g.fillStyle = '#f87171'; g.font = '700 14px system-ui'; g.fillText('+' + S.penalties + ' s penalties', W / 2, 50); }

  const placed = S.items.filter((it) => it.status === 'placed').length;
  const nuts = S.bolts.filter((b) => b.state !== 'internal');
  const fastened = nuts.filter((b) => b.state === 'fastened').length;
  g.textAlign = 'right'; g.font = '600 14px system-ui'; g.fillStyle = '#e2e8f0';
  g.fillText(`Pieces ${placed}/${S.items.length}   Nuts ${fastened}/${nuts.length}   Falls ${S.falls.length}`, W - 16, 24);
  g.font = '500 12px system-ui'; g.fillStyle = '#94a3b8';
  g.fillText(ui.paused ? 'Paused' : 'Esc / Start: pause', W - 16, 46);

  // The build order
  const n = S.items.length;
  const cw = Math.min(30, (W - 32) / n);
  const x0 = W / 2 - (cw * n) / 2;
  const COL = { waiting: '#334155', building: '#1d4ed8', shelf: '#16a34a', carried: '#ca8a04', placed: '#0f172a' };
  S.items.forEach((it, i) => {
    const x = x0 + i * cw;
    g.fillStyle = it.loose ? '#f59e0b' : COL[it.status];
    rrect(g, x + 1, 62, cw - 2, 18, 3); g.fill();
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
    rrect(g, x, y, cardW, HUD_BOTTOM - 20, 8);
    g.fillStyle = 'rgba(10,15,25,0.88)'; g.fill();
    g.fillStyle = a.color; g.fillRect(x, y + 8, 5, HUD_BOTTOM - 36);
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
  if (msg) banner(g, W, HUD_TOP + 22, msg, color, 1);
  let yb = HUD_TOP + (msg ? 58 : 22);
  for (const b of ui.banners) {
    const age = ui.now - b.t0;
    if (age > 2.6) continue;
    banner(g, W, yb, b.text, b.color, Math.min(1, (2.6 - age) / 0.5));
    yb += 34;
  }
  g.textBaseline = 'alphabetic';
}

function banner(g, W, y, text, color, alpha) {
  g.globalAlpha = alpha;
  g.font = '800 18px system-ui';
  const w = g.measureText(text).width + 36;
  rrect(g, W / 2 - w / 2, y - 15, w, 30, 15);
  g.fillStyle = color; g.fill();
  g.fillStyle = '#fff'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(text, W / 2, y + 1);
  g.globalAlpha = 1;
}

function activityText(S, a) {
  if (a.anchor?.locked) return 'Holding a buddy piece: someone else bolts it';
  if (S.support.holders.has(a.id)) return 'Holding the bridge' + (a.work ? ' + fastening' : '');
  if (a.anchor?.kind === 'piece') return 'Holding a piece until it has its bolts';
  if (a.work?.kind === 'fasten') return 'Fastening';
  if (a.work?.kind === 'assemble') return 'Making an assembly';
  if (a.extending) return 'Passing a piece';
  if (a.carrying) { const it = S.items.find((q) => q.id === a.carrying); return 'Carrying #' + (it.idx + 1) + (it.buddy ? ' (buddy piece)' : ''); }
  return a.moving ? 'Walking' : 'Ready';
}
