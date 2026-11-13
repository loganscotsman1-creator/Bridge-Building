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
  const lift = 50; // room above the ground for the bridge and builders
  const availH = H - HUD_TOP - HUD_BOTTOM - 16;
  const kw = (W - 30) / site.width;
  YF = Math.max(1, Math.min(2.4, availH / kw / (site.depth + 1.15 * lift)));
  ZF = 1.6 * Math.max(1, YF * 0.8);
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

// ---------- scenery ----------
// A box on the ground; this view shows its top and its south face.
function box(g, P, x0, y0, x1, y1, z0, z1, top, front) {
  poly(g, [P(x0, y1, z0), P(x1, y1, z0), P(x1, y1, z1), P(x0, y1, z1)]); g.fillStyle = front; g.fill();
  poly(g, [P(x0, y0, z1), P(x1, y0, z1), P(x1, y1, z1), P(x0, y1, z1)]); g.fillStyle = top; g.fill();
  g.strokeStyle = 'rgba(0,0,0,0.2)'; g.lineWidth = 1; g.stroke();
}
// A low brick wall along x, broken where the river runs through.
function wallRun(g, P, x0, x1, y0, y1, h, gaps) {
  let segs = [[x0, x1]];
  for (const [a, b] of gaps) segs = segs.flatMap(([p, q]) => (b <= p || a >= q ? [[p, q]] : [[p, a], [b, q]].filter(([u, v]) => v - u > 0.5)));
  for (const [a, b] of segs) {
    box(g, P, a, y0, b, y1, 0, h, '#e0936b', '#b4593a');
    // Mortar lines on the face.
    g.strokeStyle = 'rgba(80,30,15,0.35)'; g.lineWidth = 1;
    for (let z = 2; z < h; z += 2) { g.beginPath(); g.moveTo(...P(a, y1, z)); g.lineTo(...P(b, y1, z)); g.stroke(); }
    for (let z = 0, row = 0; z < h; z += 2, row++) for (let x = a + (row % 2 ? 3 : 6); x < b; x += 6) { g.beginPath(); g.moveTo(...P(x, y1, z)); g.lineTo(...P(x, y1, Math.min(h, z + 2))); g.stroke(); }
  }
}
let hazard = null;
function hazardFor(g) {
  if (hazard) return hazard;
  const c = document.createElement('canvas');
  c.width = c.height = 16;
  const x = c.getContext('2d');
  x.fillStyle = '#facc15'; x.fillRect(0, 0, 16, 16);
  x.fillStyle = '#1f2937';
  x.beginPath(); x.moveTo(0, 0); x.lineTo(8, 0); x.lineTo(0, 8); x.closePath(); x.fill();
  x.beginPath(); x.moveTo(16, 0); x.lineTo(16, 8); x.lineTo(8, 16); x.lineTo(0, 16); x.closePath(); x.fill();
  hazard = g.createPattern(c, 'repeat');
  return hazard;
}
let grass = null;
function grassFor(g) {
  if (grass) return grass;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const x = c.getContext('2d');
  x.fillStyle = '#7fb85a'; x.fillRect(0, 0, 64, 64);
  let seed = 3;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 140; i++) { x.fillStyle = rnd() < 0.5 ? 'rgba(52,110,40,0.35)' : 'rgba(190,230,140,0.35)'; x.fillRect(rnd() * 64, rnd() * 64, 1.5, 2.5 + rnd() * 2); }
  grass = g.createPattern(c, 'repeat');
  return grass;
}
// Grass out to the edges of the screen and a few things standing around: trees, bushes, cones,
// a pile of steel. Returns the props in front of the site, to draw after it.
function drawSurround(g, S, V, now) {
  const { P, k, W, H, ox, oy } = V;
  const site = S.site;
  const x0 = -ox / k - 10, x1 = (W - ox) / k + 10, y0 = (0 - oy) / (YF * k) - 10, y1 = (H - oy) / (YF * k) + 60;
  poly(g, [P(x0, y0), P(x1, y0), P(x1, y1), P(x0, y1)]);
  g.fillStyle = grassFor(g); g.fill();
  // A gravel path along the back.
  poly(g, [P(x0, -20), P(x1, -20), P(x1, -8), P(x0, -8)]); g.fillStyle = '#d6cdb8'; g.fill();
  if (!S.props) {
    let seed = 11;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const back = [], front = [];
    for (let x = -60; x < site.width + 60; x += 46 + rnd() * 30) {
      const kind = rnd() < 0.55 ? 'tree' : 'bush';
      back.push({ kind, x: x + rnd() * 10, y: -32 - rnd() * 14, s: 0.8 + rnd() * 0.5 });
    }
    back.push({ kind: 'steel', x: site.width - 60, y: -14, s: 1 });
    back.push({ kind: 'cone', x: (S.river ? S.river.x : site.width / 2) - 8, y: -12, s: 1 }, { kind: 'cone', x: (S.river ? S.river.x + S.river.w : site.width / 2) + 8, y: -12, s: 1 });
    for (let x = -40; x < site.width + 40; x += 70 + rnd() * 40) front.push({ kind: rnd() < 0.7 ? 'bush' : 'cone', x: x + rnd() * 20, y: site.depth + 14 + rnd() * 8, s: 0.7 + rnd() * 0.4 });
    S.props = { back: back.sort((a, b) => a.y - b.y), front: front.sort((a, b) => a.y - b.y) };
  }
  for (const pr of S.props.back) drawProp(g, P, k, pr, now);
  return S.props;
}
function drawProp(g, P, k, pr, now) {
  const [sx, sy] = P(pr.x, pr.y, 0);
  g.fillStyle = 'rgba(15,23,42,0.2)';
  g.beginPath(); g.ellipse(sx + 4 * k, sy + 1, 9 * k * pr.s, 3.5 * k * pr.s, 0, 0, 7); g.fill();
  if (pr.kind === 'tree') {
    const [tx, ty] = P(pr.x, pr.y, 14 * pr.s);
    g.fillStyle = '#7c4a26'; g.fillRect(sx - 1.6 * k, ty, 3.2 * k, sy - ty);
    const sway = Math.sin(now * 1.3 + pr.x) * 0.6 * k;
    for (const [dx, dz, r] of [[-5, 18, 8], [5, 19, 8], [0, 26, 9]]) {
      const [cx, cy] = P(pr.x + dx * pr.s, pr.y, dz * pr.s);
      const rr = r * k * pr.s;
      const gr = g.createRadialGradient(cx - rr * 0.35 + sway, cy - rr * 0.4, rr * 0.2, cx + sway, cy, rr);
      gr.addColorStop(0, '#9be070'); gr.addColorStop(1, '#3f8a2c');
      g.beginPath(); g.arc(cx + sway, cy, rr, 0, 7); g.fillStyle = gr; g.fill();
      g.strokeStyle = 'rgba(30,70,20,0.5)'; g.lineWidth = 1; g.stroke();
    }
  } else if (pr.kind === 'bush') {
    for (const [dx, r] of [[-4, 5], [4, 5], [0, 6]]) {
      const [cx, cy] = P(pr.x + dx * pr.s, pr.y, 4 * pr.s);
      const rr = r * k * pr.s;
      const gr = g.createRadialGradient(cx - rr * 0.3, cy - rr * 0.4, rr * 0.2, cx, cy, rr);
      gr.addColorStop(0, '#8fd468'); gr.addColorStop(1, '#3b7d2a');
      g.beginPath(); g.arc(cx, cy, rr, 0, 7); g.fillStyle = gr; g.fill();
    }
  } else if (pr.kind === 'cone') {
    const [tx, ty] = P(pr.x, pr.y, 9 * pr.s);
    g.fillStyle = '#1f2937'; g.fillRect(sx - 4 * k * pr.s, sy - 1.5 * k, 8 * k * pr.s, 2 * k);
    g.beginPath(); g.moveTo(sx - 3.2 * k * pr.s, sy - 1 * k); g.lineTo(tx, ty); g.lineTo(sx + 3.2 * k * pr.s, sy - 1 * k); g.closePath();
    g.fillStyle = '#f97316'; g.fill();
    g.fillStyle = '#fff'; g.fillRect(sx - 1.8 * k * pr.s, (sy + ty) / 2 - 0.8 * k, 3.6 * k * pr.s, 1.6 * k);
  } else if (pr.kind === 'steel') {
    // A stack of spare steel on timber bearers.
    for (let i = 0; i < 3; i++) box(g, P, pr.x - 30, pr.y - 10 + i * 4, pr.x + 30, pr.y - 7 + i * 4, i * 2.5, i * 2.5 + 2.5, '#9aa7ba', '#5f6b7d');
    box(g, P, pr.x - 26, pr.y - 11, pr.x - 22, pr.y + 2, 0, 1.2, '#a16207', '#713f12');
  }
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

  g.fillStyle = '#0d1420'; g.fillRect(0, 0, W, H);
  g.save();
  if (ui.shakeUntil > now) { const m = 6 * (ui.shakeUntil - now); g.translate((Math.random() - 0.5) * m * 2, (Math.random() - 0.5) * m * 2); }

  // The world around the site: grass, trees and bits of a job site, then a low brick wall.
  const site = S.site;
  const ground = (x, y, w, h) => [P(x, y), P(x + w, y), P(x + w, y + h), P(x, y + h)];
  const props = drawSurround(g, S, V, now);
  const gaps = S.river ? [[S.river.x, S.river.x + S.river.w]] : [];
  wallRun(g, P, 0, site.width, -5, 0, 8, gaps); // back wall (north)
  for (const [x0, x1] of [[-5, 0], [site.width, site.width + 5]]) box(g, P, x0, -5, x1, site.depth + 5, 0, 8, '#e0936b', '#b4593a');
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

  // Staging: a workshop floor with hazard stripes for assembling, a timber deck for what's ready.
  {
    const a = S.assembly, rd = S.ready;
    poly(g, ground(a.x + 2, a.y + 2, a.w - 4, a.h - 4)); g.fillStyle = '#b9c4d3'; g.fill();
    g.beginPath();
    for (const [x0, y0, w, h] of [[a.x + 2, a.y + 2, a.w - 4, a.h - 4], [a.x + 6, a.y + 6, a.w - 12, a.h - 12]]) { const q = ground(x0, y0, w, h); g.moveTo(...q[0]); q.slice(1).forEach((pt) => g.lineTo(...pt)); g.closePath(); }
    g.fillStyle = hazardFor(g); g.fill('evenodd');
    poly(g, ground(rd.x + 2, rd.y + 2, rd.w - 4, rd.h - 4)); g.fillStyle = '#c99a62'; g.fill();
    g.strokeStyle = 'rgba(92,58,24,0.45)'; g.lineWidth = 1;
    for (let yy = rd.y + 2 + 7; yy < rd.y + rd.h - 2; yy += 7) { g.beginPath(); g.moveTo(...P(rd.x + 2, yy)); g.lineTo(...P(rd.x + rd.w - 2, yy)); g.stroke(); }
    for (let yy = rd.y + 2, row = 0; yy < rd.y + rd.h - 2; yy += 7, row++) for (let xx = rd.x + 2 + (row % 2 ? 18 : 36); xx < rd.x + rd.w - 2; xx += 36) { g.beginPath(); g.moveTo(...P(xx, yy)); g.lineTo(...P(xx, Math.min(yy + 7, rd.y + rd.h - 2))); g.stroke(); }
    box(g, P, rd.x + 2, rd.y + rd.h - 4, rd.x + rd.w - 2, rd.y + rd.h - 2, 0, 1.5, '#d8aa70', '#8a5a2b');
    g.textAlign = 'center'; g.font = `900 ${Math.max(11, k * 4.6)}px system-ui`;
    for (const [r, c, name] of [[a, '#1e3a8a', 'ASSEMBLY'], [rd, '#7c4a14', 'READY']]) {
      const [x, y] = P(r.x + r.w / 2, r.y + r.h - 9);
      g.fillStyle = c; g.globalAlpha = 0.55; g.fillText(name, x, y); g.globalAlpha = 1;
    }
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
    const it = a.carrying && S.items.find((q) => q.id === a.carrying);
    if (it) for (const id of it.memberIds) drawShadow(g, P, S.members.get(id), carriedShift(S, a, it), 0);
  }
  for (const a of S.actors) {
    const [sx, sy] = P(a.x, a.y, 0);
    g.fillStyle = 'rgba(15,23,42,0.22)';
    g.beginPath(); g.ellipse(sx + 2 * k, sy + 1, R * k * 1.15, R * k * 0.5 * YF, 0, 0, 7); g.fill();
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

  // The front (south) wall and things in front of it, then warm light over everything.
  wallRun(g, P, -5, site.width + 5, site.depth, site.depth + 5, 5, gaps);
  poly(g, [P(-5, site.depth + 5, 0), P(site.width + 5, site.depth + 5, 0), P(site.width + 5, site.depth + 5, -8), P(-5, site.depth + 5, -8)]);
  g.fillStyle = '#5b4632'; g.fill();
  for (const pr of props.front) drawProp(g, P, k, pr, now);
  g.save();
  g.globalCompositeOperation = 'soft-light';
  const light = g.createLinearGradient(0, 0, W, H);
  light.addColorStop(0, 'rgba(255,214,150,0.7)'); light.addColorStop(1, 'rgba(60,80,140,0.45)');
  g.fillStyle = light; g.fillRect(-20, -20, W + 40, H + 40);
  g.restore();
  const vig = g.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, Math.max(W, H) * 0.75);
  vig.addColorStop(0, 'rgba(0,0,0,0)'); vig.addColorStop(1, 'rgba(0,0,0,0.35)');
  g.fillStyle = vig; g.fillRect(-20, -20, W + 40, H + 40);

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

// A builder: short and round, like a cartoon: little boots, a round body in their color with a
// hi-vis stripe, a big head with eyes that look where they're going, rosy cheeks and a hard hat.
function drawActor(g, S, V, a, ui) {
  const { P, k } = V;
  const now = ui.now;
  const [sx, sy] = P(a.x, a.y, 0);
  const step = a.moving ? Math.sin(now * 16 + a.x) : 0;
  const bob = a.moving ? Math.abs(step) * 1.4 : Math.sin(now * 2.5 + a.y) * 0.3;
  const body = a.npc ? '#64748b' : a.color;
  const ink = 'rgba(30,20,20,0.85)';
  const bw = R * k * 1.0; // body half-width
  // Boots
  for (const sd of [-1, 1]) {
    const lift = a.moving ? Math.max(0, sd * step) * 2.2 * k : 0;
    g.beginPath(); g.ellipse(sx + sd * bw * 0.45, sy - 1.2 * k - lift, bw * 0.38, 1.8 * k, 0, 0, 7);
    g.fillStyle = '#3f2a1d'; g.fill(); g.strokeStyle = ink; g.lineWidth = 1.5; g.stroke();
  }
  // A carried piece, at full size, held at waist height (pushed out in front while passing).
  const carried = a.carrying && S.items.find((q) => q.id === a.carrying);
  const sh = carried && carriedShift(S, a, carried);
  // Body: a round blob.
  const [bx, by] = P(a.x, a.y, 7 + bob);
  const bh = 6.5 * ZF * k;
  const bg = g.createRadialGradient(bx - bw * 0.35, by - bh * 0.4, bw * 0.1, bx, by, bw * 1.2);
  bg.addColorStop(0, shade(body, 1.35)); bg.addColorStop(1, shade(body, 0.8));
  g.beginPath(); g.ellipse(bx, by, bw, bh, 0, 0, 7); g.fillStyle = bg; g.fill();
  g.save(); g.clip();
  g.fillStyle = 'rgba(253,224,71,0.95)'; g.fillRect(bx - bw, by - bh * 0.05, bw * 2, Math.max(2, bh * 0.22));
  g.fillStyle = 'rgba(255,255,255,0.7)'; g.fillRect(bx - bw, by + bh * 0.06, bw * 2, Math.max(1, bh * 0.06));
  g.restore();
  g.beginPath(); g.ellipse(bx, by, bw, bh, 0, 0, 7); g.strokeStyle = ink; g.lineWidth = 2; g.stroke();
  if (carried) {
    const ms = carried.memberIds.map((id) => S.members.get(id)).filter(Boolean).sort((p, q) => p.m.centroid[1] - q.m.centroid[1]);
    for (const mm of ms) drawMember(g, P, mm, { color: a.extending ? '#d97706' : PLANE[mm.m.plane], shift: sh, outline: shade(a.npc ? '#64748b' : a.color, 1) });
  }
  // Hands: up on the bridge or a piece, holding what they carry, or swinging at the sides.
  const hand = (hx, hy) => { g.beginPath(); g.arc(hx, hy, Math.max(2.2, k * 1.7), 0, 7); g.fillStyle = '#fcd9b6'; g.fill(); g.strokeStyle = ink; g.lineWidth = 1.5; g.stroke(); };
  if (a.anchor) {
    const hz = a.anchor.kind === 'bridge' ? 18 : 21;
    for (const sd of [-1, 1]) {
      const [hx, hy] = P(a.x + sd * 4.5, a.y, hz + bob);
      g.strokeStyle = shade(body, 0.7); g.lineWidth = Math.max(3, k * 2); g.lineCap = 'round';
      g.beginPath(); g.moveTo(bx + sd * bw * 0.8, by - bh * 0.2); g.lineTo(hx, hy); g.stroke(); g.lineCap = 'butt';
      hand(hx, hy);
    }
  } else if (carried) {
    const [cx, cy] = P(a.x + (a.extending ? a.face[0] * 14 : 0), a.y + (a.extending ? a.face[1] * 14 : 0), CARRY_Z + 1);
    hand(cx - bw * 0.9, cy); hand(cx + bw * 0.9, cy);
  } else if (a.work) {
    const sw = Math.sin(now * 18) * 1.5 * k;
    hand(bx - bw * 0.95, by + sw); hand(bx + bw * 0.95, by - sw);
  } else {
    hand(bx - bw * 1.02, by + bh * 0.15 + step * k); hand(bx + bw * 1.02, by + bh * 0.15 - step * k);
  }
  // Head
  const [hx, hy] = P(a.x, a.y, 17 + bob);
  const hr = R * k * 0.82;
  const hg = g.createRadialGradient(hx - hr * 0.3, hy - hr * 0.3, hr * 0.1, hx, hy, hr);
  hg.addColorStop(0, '#ffe6cc'); hg.addColorStop(1, '#f2b98c');
  g.beginPath(); g.arc(hx, hy, hr, 0, 7); g.fillStyle = hg; g.fill(); g.strokeStyle = ink; g.lineWidth = 2; g.stroke();
  // Face, looking the way they last moved; a blink now and then.
  const fx = (a.face?.[0] || 0) * hr * 0.3, fy = (a.face?.[1] || 0) * hr * 0.12 + hr * 0.12;
  const blink = (now + a.x * 0.37) % 3.7 < 0.12;
  for (const sd of [-1, 1]) {
    const ex = hx + fx + sd * hr * 0.33, ey = hy + fy;
    if (blink) { g.strokeStyle = ink; g.lineWidth = 1.5; g.beginPath(); g.moveTo(ex - hr * 0.13, ey); g.lineTo(ex + hr * 0.13, ey); g.stroke(); continue; }
    g.beginPath(); g.ellipse(ex, ey, hr * 0.17, hr * 0.22, 0, 0, 7); g.fillStyle = '#fff'; g.fill(); g.strokeStyle = ink; g.lineWidth = 1; g.stroke();
    g.beginPath(); g.arc(ex + (a.face?.[0] || 0) * hr * 0.06, ey + hr * 0.04, hr * 0.1, 0, 7); g.fillStyle = '#1f2937'; g.fill();
    g.beginPath(); g.arc(ex + hr * 0.03, ey - hr * 0.04, hr * 0.035, 0, 7); g.fillStyle = '#fff'; g.fill();
  }
  g.fillStyle = 'rgba(244,114,182,0.45)';
  for (const sd of [-1, 1]) { g.beginPath(); g.ellipse(hx + fx + sd * hr * 0.55, hy + fy + hr * 0.3, hr * 0.15, hr * 0.09, 0, 0, 7); g.fill(); }
  g.strokeStyle = ink; g.lineWidth = 1.5;
  const fell = S.support.fallen;
  if (fell || a.work) { g.beginPath(); g.ellipse(hx + fx, hy + fy + hr * 0.45, hr * 0.12, hr * (fell ? 0.14 : 0.08), 0, 0, 7); g.fillStyle = '#7f1d1d'; g.fill(); }
  else { g.beginPath(); g.arc(hx + fx, hy + fy + hr * 0.28, hr * 0.22, 0.15 * Math.PI, 0.85 * Math.PI); g.stroke(); }
  // Hard hat: a shiny dome with a brim and a ridge in their color.
  const hat = a.npc ? '#e2e8f0' : '#facc15';
  g.beginPath(); g.ellipse(hx, hy - hr * 0.22, hr * 1.22, hr * 0.3, 0, 0, 7); g.fillStyle = shade(hat, 0.82); g.fill(); g.strokeStyle = ink; g.lineWidth = 1.5; g.stroke();
  g.beginPath(); g.arc(hx, hy - hr * 0.28, hr * 0.98, Math.PI, 0); g.closePath();
  const hh = g.createLinearGradient(hx - hr, hy - hr * 1.3, hx + hr, hy);
  hh.addColorStop(0, shade(hat, 1.2)); hh.addColorStop(1, shade(hat, 0.82));
  g.fillStyle = hh; g.fill(); g.stroke();
  g.beginPath(); g.ellipse(hx - hr * 0.35, hy - hr * 0.85, hr * 0.22, hr * 0.1, -0.5, 0, 7); g.fillStyle = 'rgba(255,255,255,0.6)'; g.fill();
  g.fillStyle = a.npc ? '#475569' : a.color; g.fillRect(hx - hr * 0.13, hy - hr * 1.24, hr * 0.26, hr * 0.96);
  // Player number on the tummy.
  const label = a.npc ? 'AI' : String(ui.numberOf(a));
  g.font = `900 ${Math.max(9, k * 3.6)}px system-ui`; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.lineWidth = 3; g.strokeStyle = 'rgba(15,23,42,0.7)'; g.strokeText(label, bx, by + bh * 0.48);
  g.fillStyle = '#fff'; g.fillText(label, bx, by + bh * 0.48);
  g.textBaseline = 'alphabetic';
}

// Where a carried piece is drawn: centered on its carrier, its lowest point at waist height.
const CARRY_Z = 9;
function carriedShift(S, a, it) {
  const b = itemBox(S, it);
  const ex = a.extending ? a.face[0] * 14 : 0, ey = a.extending ? a.face[1] * 14 : 0;
  return { dx: a.x + ex - (b.x0 + b.x1) / 2, dy: a.y + ey - (b.y0 + b.y1) / 2, dz: CARRY_Z - b.z0 };
}

function drawActorTop(g, S, V, a, ui) {
  const { P, k } = V;
  let [x, y] = P(a.x, a.y, 36);
  if (a.carrying) {
    // Just its number: the piece itself is in their hands.
    const it = S.items.find((q) => q.id === a.carrying);
    const b = itemBox(S, it);
    const [, iy] = P(a.x, a.y, CARRY_Z + (b.z1 - b.z0) + 4);
    y = Math.min(y, iy);
    chip(g, x, y, '#' + (it.idx + 1) + (it.buddy ? '★' : ''), a.extending ? '#b45309' : '#334155', k);
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
  if (a.work?.kind === 'assemble') {
    const it = a.work.target;
    const [wx, wy] = P(a.x, a.y, 40);
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
  g.fillText(ui.paused ? 'Paused' : `Esc / Start: pause · M: sound ${ui.muted ? 'off' : 'on'} · N: music ${ui.music ? 'on' : 'off'}`, W - 16, 46);

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
  // 3, 2, 1, GO!
  if (ui.countdown > -0.8 && !ui.briefing) {
    const n = Math.ceil(ui.countdown);
    const frac = ui.countdown > 0 ? ui.countdown - Math.floor(ui.countdown) : 1 + ui.countdown / 0.8;
    const text = n > 0 ? String(n) : 'GO!';
    g.save();
    if (n > 0) { g.fillStyle = 'rgba(8,12,20,0.35)'; g.fillRect(0, 0, W, H); }
    const sc = n > 0 ? 0.7 + 0.6 * frac : 1 + 0.6 * (1 - frac);
    g.globalAlpha = n > 0 ? Math.min(1, 0.3 + frac * 1.5) : Math.max(0, frac);
    g.translate(W / 2, H / 2); g.scale(sc, sc);
    g.font = `900 ${Math.min(W, H) * 0.22}px system-ui`; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.lineWidth = 14; g.strokeStyle = '#0f172a'; g.strokeText(text, 0, 6);
    g.fillStyle = n > 0 ? '#facc15' : '#4ade80'; g.fillText(text, 0, 0);
    if (n > 0) { g.font = `800 ${Math.min(W, H) * 0.04}px system-ui`; g.fillStyle = '#fff'; g.globalAlpha = 0.9; g.fillText('Get ready…', 0, Math.min(W, H) * 0.17); }
    g.restore();
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
