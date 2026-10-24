// A made-up example so the app has something to show on first open: a 22'-9" truss with piers
// on both footings, on the 2027 official site. The bridge itself is invented, not a real design.
import { emptyProject } from './schema.js';
import { MIRROR_SUFFIX as B } from './ids.js';
import { buildModel, calibFromPoints } from './geometry.js';
import { autoOrderSteps } from './plan.js';
import { autoBolts } from './edit.js';
import { site2027 } from './rules2027.js';

export function exampleSite() {
  return site2027();
}

export function createExampleProject() {
  const p = emptyProject();
  p.name = 'Example truss (2027 site)';
  p.site = site2027();
  const d = p.design;
  d.trussSpacing = 38;
  d.mirrorB = true;
  d.rigidBoltCount = 2;

  const t = 1.5; // tube size (in) in and out of plane
  const box = (id, name, plane, x0, z0, x1, z1, extra = {}) => {
    // An axis-aligned box from (x0, z0) to (x1, z1) in its view; tall boxes stand at 90°.
    const w = x1 - x0, h = z1 - z0;
    const vertical = h > w;
    d.members.push({
      id, name, plane, u: (x0 + x1) / 2, v: (z0 + z1) / 2, angle: vertical ? 90 : 0,
      len: vertical ? h : w, depth: vertical ? w : h, thick: t, z: 0, bearing: false, ...extra,
    });
  };

  // Truss A, side view (x along the span from the west footing's outer edge, z up).
  const topZ = 20, botZ = 12;
  const tc = 39, tcStart = 1;
  for (let k = 0; k < 7; k++) box('m-TC' + (k + 1), 'A-TC' + (k + 1), 'A', tcStart + k * tc, topZ - t, tcStart + (k + 1) * tc, topZ);
  const bcStart = tcStart + t, bcEnd = tcStart + 7 * tc - t; // between the piers
  const bc = (bcEnd - bcStart) / 7;
  for (let k = 0; k < 7; k++) box('m-BC' + (k + 1), 'A-BC' + (k + 1), 'A', bcStart + k * bc, botZ, bcStart + (k + 1) * bc, botZ + t);
  box('m-P1', 'A-P1', 'A', tcStart, 0, tcStart + t, topZ - t, { bearing: true }); // west pier
  box('m-P2', 'A-P2', 'A', bcEnd, 0, bcEnd + t, topZ - t, { bearing: true }); // east pier
  for (let k = 1; k < 7; k++) {
    const x = tcStart + k * tc;
    box('m-V' + k, 'A-V' + k, 'A', x - t / 2, botZ + t, x + t / 2, topZ - t);
  }
  // Laterals at bottom-chord height, between the verticals, ends against the chords' inner faces.
  for (const [i, x] of [[1, 20], [2, 98.5], [3, 176], [4, 254]].map(([i, x]) => [i, x])) {
    d.members.push({ id: 'm-L' + i, name: 'L-' + i, plane: 'L', u: x, v: d.trussSpacing / 2, angle: 90, len: d.trussSpacing - t, depth: t, thick: t, z: botZ + t / 2, bearing: false });
  }

  const model0 = buildModel(p);
  autoBolts(p, model0, 'A', 2); // 2 bolts: rigid connections in the trusses
  autoBolts(p, buildModel(p), 'L', 1);

  if (typeof document !== 'undefined') addExampleScreenshots(p);

  p.tools = [
    { id: 't-impact-w', name: 'Impact driver (west)', kind: 'fastener', count: 1, boltTime: 4, placeTime: 0, removeTime: 0, start: { x: 12, y: 30 }, notes: 'Battery impact with socket' },
    { id: 't-jack', name: 'Jack stand', kind: 'support', count: 2, boltTime: 0, placeTime: 6, removeTime: 5, start: { x: 12, y: 70 }, notes: 'Temporary support under the first bottom-chord piece' },
    { id: 't-impact-e', name: 'Impact driver (east)', kind: 'fastener', count: 1, boltTime: 4, placeTime: 0, removeTime: 0, start: { x: 690, y: 130 }, notes: '' },
  ];
  p.builders = [
    { id: 'w1', name: 'Builder 1 (west)', color: '#e11d48', role: 'carrier', start: { x: 42, y: 50 }, allowedZones: null, loadout: [], hardware: false },
    { id: 'w2', name: 'Builder 2 (west)', color: '#2563eb', role: 'fastener', start: { x: 42, y: 130 }, allowedZones: null, loadout: ['t-impact-w'], hardware: true },
    { id: 'w3', name: 'Builder 3 (east)', color: '#16a34a', role: 'any', start: { x: 600, y: 120 }, allowedZones: null, loadout: [], hardware: true },
    { id: 'w4', name: 'Builder 4 (east)', color: '#d97706', role: 'any', start: { x: 600, y: 160 }, allowedZones: null, loadout: ['t-impact-e'], hardware: true },
  ];

  const plan = p.plans[0];
  plan.name = 'West to east';
  plan.assemblies = [
    { id: 'as-endA', name: 'A west end', memberIds: ['m-P1', 'm-TC1', 'm-BC1'], areaZoneId: null },
    { id: 'as-endB', name: 'B west end', memberIds: ['m-P1' + B, 'm-TC1' + B, 'm-BC1' + B], areaZoneId: null },
  ];
  const model = buildModel(p);
  const ordered = autoOrderSteps(model, plan);
  plan.steps = [
    { id: 's-j1', kind: 'support', action: 'place', toolId: 't-jack', memberId: 'm-BC1', builder: 'auto' },
    { id: 's-j2', kind: 'support', action: 'place', toolId: 't-jack', memberId: 'm-BC1' + B, builder: 'auto' },
    ...ordered,
    { id: 's-j3', kind: 'support', action: 'remove', toolId: 't-jack', memberId: 'm-BC1', builder: 'auto' },
    { id: 's-j4', kind: 'support', action: 'remove', toolId: 't-jack', memberId: 'm-BC1' + B, builder: 'auto' },
  ];
  return p;
}

// Draw stand-in "CAD screenshots" of the example bridge (side, top, isometric) so the markup
// workflow has something to show. Real projects use screenshots from your CAD program.
function addExampleScreenshots(p) {
  const model = buildModel(p);
  const S = 4, M = 50; // pixels per inch, margin
  const maxX = Math.max(...model.members.flatMap((m) => m.corners3.map((c) => c[0])));
  const maxZ = Math.max(...model.members.flatMap((m) => m.corners3.map((c) => c[2])));
  const canvas = (w, h) => {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d');
    const grad = g.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, '#eef2f7'); grad.addColorStop(1, '#cfd8e3');
    g.fillStyle = grad; g.fillRect(0, 0, w, h);
    return { c, g };
  };
  const poly = (g, pts) => {
    g.beginPath();
    pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
    g.closePath();
    g.fillStyle = '#8b97a8'; g.fill();
    g.strokeStyle = '#3f4a59'; g.lineWidth = 1; g.stroke();
  };
  const add = (key, c, name) => { p.images[key] = { url: c.toDataURL('image/png'), w: c.width, h: c.height, name }; };
  const label = (g, text) => { g.fillStyle = '#475569'; g.font = '13px sans-serif'; g.fillText(text, 10, 18); };

  // Side view of truss A
  {
    const w = Math.round(maxX * S + 2 * M), h = Math.round(maxZ * S + 2 * M + 20);
    const { c, g } = canvas(w, h);
    const P = ([x, z]) => [M + x * S, h - M - 20 - z * S];
    g.fillStyle = '#b8a27a';
    g.fillRect(P([0, 0])[0], P([0, 0])[1], 12 * S, 10); // footings
    g.fillRect(P([264, 0])[0], P([0, 0])[1], 12 * S, 10);
    for (const m of model.members.filter((x) => x.plane === 'A')) poly(g, m.poly.map(P));
    g.fillStyle = '#111827';
    for (const b of model.bolts.filter((x) => x.plane === 'A')) { const [x, y] = P([b.u, b.v]); g.beginPath(); g.arc(x, y, 2, 0, 7); g.fill(); }
    label(g, 'Example CAD screenshot · south side elevation');
    add('img-ex-side', c, 'example-side-view.png');
    const p1 = { px: M, py: h - M - 20, u: 0, v: 0 }, p2 = { px: M + 276 * S, py: h - M - 20, u: 276, v: 0 };
    p.design.views.sideA = { imageId: 'img-ex-side', calib: calibFromPoints(true, p1, p2), scaled: true, opacity: 0.7 };
  }
  // Top view
  {
    const sp = p.design.trussSpacing;
    const w = Math.round(maxX * S + 2 * M), h = Math.round(sp * S + 2 * M + 10);
    const { c, g } = canvas(w, h);
    const P = ([x, y]) => [M + x * S, M + 10 + y * S];
    for (const m of model.members.filter((x) => x.plane !== 'L')) poly(g, m.footprint.map(P));
    for (const m of model.members.filter((x) => x.plane === 'L')) poly(g, m.poly.map(P));
    label(g, 'Example CAD screenshot · plan view');
    add('img-ex-top', c, 'example-top-view.png');
    const p1 = { px: M, py: M + 10, u: 0, v: 0 }, p2 = { px: M + 276 * S, py: M + 10 + sp * S, u: 276, v: sp };
    p.design.views.top = { imageId: 'img-ex-top', calib: calibFromPoints(false, p1, p2), scaled: true, opacity: 0.7 };
  }
  // Isometric reference
  {
    const az = (-32 * Math.PI) / 180, el = (24 * Math.PI) / 180;
    const proj = ([x, y, z]) => { const x1 = x * Math.cos(az) - y * Math.sin(az), y1 = x * Math.sin(az) + y * Math.cos(az); return [x1, -(z * Math.cos(el) + y1 * Math.sin(el))]; };
    const all = model.members.flatMap((m) => m.corners3.map(proj));
    const minX = Math.min(...all.map((q) => q[0])), minY = Math.min(...all.map((q) => q[1]));
    const s = 3.2, w = Math.round((Math.max(...all.map((q) => q[0])) - minX) * s + 2 * M), h = Math.round((Math.max(...all.map((q) => q[1])) - minY) * s + 2 * M);
    const { c, g } = canvas(w, h);
    const P = (pt) => { const q = proj(pt); return [M + (q[0] - minX) * s, M + (q[1] - minY) * s]; };
    for (const m of model.members) poly(g, m.corners3.map(P));
    label(g, 'Example CAD screenshot · isometric');
    add('img-ex-iso', c, 'example-isometric.png');
    p.design.isoRefs = [{ imageId: 'img-ex-iso', caption: 'Example isometric' }];
  }
}
