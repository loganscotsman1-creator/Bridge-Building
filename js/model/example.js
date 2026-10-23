// A made-up example so the app has something to show on first open: a 17.5 ft Pratt truss
// bridge (two trusses, 6 panels) on an invented site. Not an official AISC layout.
import { emptyProject } from './schema.js';
import { MIRROR_SUFFIX as B } from './ids.js';
import { buildModel, calibFromPoints } from './geometry.js';
import { autoOrderSteps } from './plan.js';

export function exampleSite() {
  return {
    name: 'Example site (not official)',
    year: 'example',
    notes: 'Invented layout for trying the app. Replace with the real layout from this year\'s rules.',
    width: 600,
    depth: 360,
    cell: 6,
    zones: [
      { id: 'z-con', name: 'Construction zone', type: 'construction', x: 90, y: 105, w: 330, h: 150 },
      { id: 'z-river', name: 'River', type: 'nogo', x: 215, y: 105, w: 80, h: 150 },
      { id: 'z-stage', name: 'Staging yard', type: 'staging', x: 430, y: 30, w: 160, h: 220 },
      { id: 'z-asm', name: 'Assembly area', type: 'assembly', x: 430, y: 260, w: 160, h: 90 },
    ],
    bridge: { x: 150, y: 165, rotation: 0 },
    hardware: { x: 445, y: 235 },
    staging: {},
  };
}

export function createExampleProject() {
  const p = emptyProject();
  p.name = 'Example Pratt truss';
  const d = p.design;
  d.trussSpacing = 30;
  d.mirrorB = true;

  const panel = 35, h = 20, panels = 6;
  for (let i = 0; i <= panels; i++) d.nodes.push({ id: 'b' + i, plane: 'A', x: i * panel, y: 0, z: 0, bearing: i === 0 || i === panels });
  for (let i = 1; i < panels; i++) d.nodes.push({ id: 't' + i, plane: 'A', x: i * panel, y: 0, z: h, bearing: false });

  const members = [];
  const add = (name, a, b, bolts) => members.push({ id: 'm-' + name, name: 'A-' + name, plane: 'A', segments: [[a, b]], bolts });
  for (let i = 1; i <= panels; i++) add('BC' + i, 'b' + (i - 1), 'b' + i, 2); // bottom chord, 2-bolt splices
  for (let i = 1; i < panels - 1; i++) add('TC' + i, 't' + i, 't' + (i + 1), 2); // top chord
  add('EP1', 'b0', 't1', 1); // end posts
  add('EP2', 'b' + panels, 't' + (panels - 1), 1);
  for (let i = 1; i < panels; i++) add('V' + i, 'b' + i, 't' + i, 1); // verticals
  add('D1', 't1', 'b2', 1); // diagonals slope down toward mid-span
  add('D2', 't2', 'b3', 1);
  add('D3', 't5', 'b4', 1);
  add('D4', 't4', 'b3', 1);
  // Laterals connect truss A to its mirror image, truss B.
  for (const i of [0, 2, 4, 6]) members.push({ id: 'm-LB' + i, name: 'L-BS' + i, plane: 'L', segments: [['b' + i, 'b' + i + B]], bolts: 1 });
  for (const i of [1, 3, 5]) members.push({ id: 'm-LT' + i, name: 'L-TS' + i, plane: 'L', segments: [['t' + i, 't' + i + B]], bolts: 1 });

  for (const m of members) {
    const { bolts, ...rest } = m;
    d.members.push(rest);
    // Bolts sit a little in from each end.
    const offsets = bolts === 2 ? [0.04, 0.09] : [0.05];
    offsets.forEach((s, k) => {
      d.bolts.push({ id: `${m.id}-s${k}`, memberId: m.id, seg: 0, s });
      d.bolts.push({ id: `${m.id}-e${k}`, memberId: m.id, seg: 0, s: 1 - s });
    });
  }

  if (typeof document !== 'undefined') addExampleScreenshots(p);
  p.site = exampleSite();
  p.tools = [
    { id: 't-impact', name: 'Impact driver', kind: 'fastener', count: 2, boltTime: 4, placeTime: 0, removeTime: 0, start: { x: 490, y: 235 }, notes: 'Battery impact with socket' },
    { id: 't-wrench', name: 'Hand wrench', kind: 'fastener', count: 4, boltTime: 10, placeTime: 0, removeTime: 0, start: { x: 525, y: 235 }, notes: '' },
    { id: 't-jack', name: 'Jack stand', kind: 'support', count: 2, boltTime: 0, placeTime: 6, removeTime: 5, start: { x: 560, y: 235 }, notes: 'Temporary support under a bottom-chord joint' },
  ];
  p.builders = [
    { id: 'w1', name: 'Builder 1', color: '#e11d48', role: 'carrier', start: { x: 450, y: 207 }, allowedZones: null, loadout: [], hardware: false },
    { id: 'w2', name: 'Builder 2', color: '#2563eb', role: 'carrier', start: { x: 485, y: 207 }, allowedZones: null, loadout: [], hardware: false },
    { id: 'w3', name: 'Builder 3', color: '#16a34a', role: 'fastener', start: { x: 520, y: 207 }, allowedZones: null, loadout: ['t-impact'], hardware: true },
    { id: 'w4', name: 'Builder 4', color: '#d97706', role: 'any', start: { x: 555, y: 207 }, allowedZones: null, loadout: ['t-impact'], hardware: true },
  ];

  const plan = p.plans[0];
  plan.name = 'Left to right';
  plan.assemblies = [
    { id: 'as-endA', name: 'A end frame', memberIds: ['m-BC1', 'm-EP1', 'm-V1'], areaZoneId: 'z-asm' },
    { id: 'as-endB', name: 'B end frame', memberIds: ['m-BC1' + B, 'm-EP1' + B, 'm-V1' + B], areaZoneId: 'z-asm' },
  ];
  const model = buildModel(p);
  const ordered = autoOrderSteps(model, plan);
  plan.steps = [
    { id: 's-j1', kind: 'support', action: 'place', toolId: 't-jack', nodeId: 'b1', builder: 'auto' },
    { id: 's-j2', kind: 'support', action: 'place', toolId: 't-jack', nodeId: 'b1' + B, builder: 'auto' },
    ...ordered,
    { id: 's-j3', kind: 'support', action: 'remove', toolId: 't-jack', nodeId: 'b1', builder: 'auto' },
    { id: 's-j4', kind: 'support', action: 'remove', toolId: 't-jack', nodeId: 'b1' + B, builder: 'auto' },
  ];
  return p;
}

// Draw stand-in "CAD screenshots" of the example bridge (side, top, isometric) so the markup
// workflow has something to show. Real projects use screenshots from your CAD program.
function addExampleScreenshots(p) {
  const model = buildModel(p);
  const S = 5, M = 60; // pixels per inch, margin
  const nodes = [...model.nodes.values()];
  const maxX = Math.max(...nodes.map((n) => n.x)), maxZ = Math.max(...nodes.map((n) => n.z));
  const canvas = (w, h) => {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d');
    const grad = g.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, '#eef2f7'); grad.addColorStop(1, '#cfd8e3');
    g.fillStyle = grad; g.fillRect(0, 0, w, h);
    g.lineCap = 'round';
    return { c, g };
  };
  const tube = (g, a, b, width) => {
    g.strokeStyle = '#3f4a59'; g.lineWidth = width + 2; g.beginPath(); g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); g.stroke();
    g.strokeStyle = '#8b97a8'; g.lineWidth = width; g.beginPath(); g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); g.stroke();
  };
  const add = (key, c, img) => { p.images[key] = { url: c.toDataURL('image/png'), w: c.width, h: c.height, name: img }; };

  // Side view of truss A
  {
    const w = Math.round(maxX * S + 2 * M), h = Math.round(maxZ * S + 2 * M + 30);
    const { c, g } = canvas(w, h);
    const P = (n) => [M + n.x * S, h - M - 30 - n.z * S];
    g.fillStyle = '#9aa5b4';
    for (const n of nodes.filter((x) => x.plane === 'A' && x.bearing)) { const [x, y] = P(n); g.fillRect(x - 30, y + 3, 60, 24); }
    for (const m of model.members.filter((x) => x.plane === 'A')) for (const [a, b] of m.segments) tube(g, P(model.nodes.get(a)), P(model.nodes.get(b)), S);
    g.fillStyle = '#5b6677';
    for (const n of nodes.filter((x) => x.plane === 'A')) { const [x, y] = P(n); g.beginPath(); g.arc(x, y, 7, 0, 7); g.fill(); }
    g.fillStyle = '#1f2937';
    for (const b of model.bolts.filter((x) => model.memberById.get(x.memberId).plane === 'A')) { const [x, y] = P({ x: b.pos[0], z: b.pos[2] }); g.beginPath(); g.arc(x, y, 2.2, 0, 7); g.fill(); }
    g.fillStyle = '#475569'; g.font = '14px sans-serif'; g.fillText('Example CAD screenshot · side elevation', 12, 20);
    add('img-ex-side', c, 'example-side-view.png');
    const p1 = { px: M, py: h - M - 30, u: 0, v: 0 }, p2 = { px: M + maxX * S, py: h - M - 30, u: maxX, v: 0 };
    p.design.views.sideA = { imageId: 'img-ex-side', calib: calibFromPoints(true, p1, p2), scaled: true, opacity: 0.7 };
  }
  // Top view
  {
    const sp = p.design.trussSpacing;
    const w = Math.round(maxX * S + 2 * M), h = Math.round(sp * S + 2 * M);
    const { c, g } = canvas(w, h);
    const P = (n) => [M + n.x * S, M + n.y * S];
    for (const m of model.members.filter((x) => x.plane !== 'L')) for (const [a, b] of m.segments) tube(g, P(model.nodes.get(a)), P(model.nodes.get(b)), S);
    for (const m of model.members.filter((x) => x.plane === 'L')) for (const [a, b] of m.segments) tube(g, P(model.nodes.get(a)), P(model.nodes.get(b)), S);
    g.fillStyle = '#475569'; g.font = '14px sans-serif'; g.fillText('Example CAD screenshot · plan view', 12, 20);
    add('img-ex-top', c, 'example-top-view.png');
    const p1 = { px: M, py: M, u: 0, v: 0 }, p2 = { px: M + maxX * S, py: M + sp * S, u: maxX, v: sp };
    p.design.views.top = { imageId: 'img-ex-top', calib: calibFromPoints(false, p1, p2), scaled: true, opacity: 0.7 };
  }
  // Isometric reference
  {
    const az = (-32 * Math.PI) / 180, el = (24 * Math.PI) / 180;
    const proj = (n) => { const x1 = n.x * Math.cos(az) - n.y * Math.sin(az), y1 = n.x * Math.sin(az) + n.y * Math.cos(az); return [x1, -(n.z * Math.cos(el) + y1 * Math.sin(el))]; };
    const pts = nodes.map(proj);
    const minX = Math.min(...pts.map((q) => q[0])), minY = Math.min(...pts.map((q) => q[1]));
    const s = 4, w = Math.round((Math.max(...pts.map((q) => q[0])) - minX) * s + 2 * M), h = Math.round((Math.max(...pts.map((q) => q[1])) - minY) * s + 2 * M);
    const { c, g } = canvas(w, h);
    const P = (n) => { const q = proj(n); return [M + (q[0] - minX) * s, M + (q[1] - minY) * s]; };
    for (const m of model.members) for (const [a, b] of m.segments) tube(g, P(model.nodes.get(a)), P(model.nodes.get(b)), 4);
    g.fillStyle = '#475569'; g.font = '14px sans-serif'; g.fillText('Example CAD screenshot · isometric', 12, 20);
    add('img-ex-iso', c, 'example-isometric.png');
    p.design.isoRefs = [{ imageId: 'img-ex-iso', caption: 'Example isometric' }];
  }
}
