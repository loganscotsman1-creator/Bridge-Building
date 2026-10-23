// Browser test runner: open tests/index.html (through a local server) and read the results.
import { boxFit, buildModel, calibFromPoints, imageToView, viewToImage } from '../js/model/geometry.js';
import { computeStability } from '../js/sim/stability.js';
import { SiteGrid } from '../js/sim/grid.js';
import { simulate } from '../js/sim/simulate.js';
import { createExampleProject } from '../js/model/example.js';
import { normalizeProject } from '../js/model/schema.js';
import { autoBolts, detachSegment, moveSegment, splitSegment } from '../js/model/edit.js';

const results = [];
function test(name, fn) {
  try { fn(); results.push({ name, ok: true }); } catch (e) { results.push({ name, ok: false, msg: e.message }); console.error(name, e); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function near(a, b, tol = 1e-6) { return Math.abs(a - b) <= tol; }

const nodesOf = (list) => new Map(list.map((n) => [n.id, n]));

test('straight 40 in member fits the 4x6x42 box', () => {
  const nodes = nodesOf([{ id: 'a', x: 0, y: 0, z: 0 }, { id: 'b', x: 40, y: 0, z: 0 }]);
  const r = boxFit({ nodeIds: ['a', 'b'], segments: [['a', 'b']], tube: { w: 1, d: 1 } }, nodes, [4, 6, 42]);
  assert(r.fits, JSON.stringify(r));
  assert(near(r.dims[2], 41, 0.01), 'long side ' + r.dims[2]);
});

test('straight 42 in member does not fit once tube size is added', () => {
  const nodes = nodesOf([{ id: 'a', x: 0, y: 0, z: 0 }, { id: 'b', x: 42, y: 0, z: 0 }]);
  const r = boxFit({ nodeIds: ['a', 'b'], segments: [['a', 'b']], tube: { w: 1, d: 1 } }, nodes, [4, 6, 42]);
  assert(!r.fits);
});

test('diagonal member is measured along its own axis', () => {
  const nodes = nodesOf([{ id: 'a', x: 0, y: 0, z: 0 }, { id: 'b', x: 30, y: 0, z: 20 }]);
  const r = boxFit({ nodeIds: ['a', 'b'], segments: [['a', 'b']], tube: { w: 1, d: 1 } }, nodes, [4, 6, 42]);
  assert(r.fits && near(r.dims[2], Math.hypot(30, 20) + 1, 0.05), JSON.stringify(r));
});

test('L-shaped member 40 x 8 is too wide for a 6 in side', () => {
  const nodes = nodesOf([{ id: 'a', x: 0, y: 0, z: 0 }, { id: 'b', x: 40, y: 0, z: 0 }, { id: 'c', x: 40, y: 0, z: 8 }]);
  const r = boxFit({ nodeIds: ['a', 'b', 'c'], segments: [['a', 'b'], ['b', 'c']], tube: { w: 1, d: 1 } }, nodes, [4, 6, 42]);
  assert(!r.fits, JSON.stringify(r));
});

test('image calibration maps the two clicked points to the typed coordinates', () => {
  for (const flip of [true, false]) {
    const p1 = { px: 100, py: 400, u: 0, v: 0 }, p2 = { px: 900, py: 380, u: 210, v: 0 };
    const c = calibFromPoints(flip, p1, p2);
    for (const p of [p1, p2]) {
      const w = imageToView(c, flip, p.px, p.py);
      assert(near(w.u, p.u, 1e-6) && near(w.v, p.v, 1e-6), `flip=${flip}: got ${w.u},${w.v}`);
      const back = viewToImage(c, flip, p.u, p.v);
      assert(near(back.px, p.px, 1e-6) && near(back.py, p.py, 1e-6), 'inverse');
    }
    // Side views point z up: a pixel above the line must have positive z.
    if (flip) assert(imageToView(c, flip, 500, 200).v > 0, 'z should point up');
  }
});

test('mirroring creates a truss B copy of every truss A member and bolt', () => {
  const p = normalizeProject(createExampleProject());
  const m = buildModel(p);
  const a = m.members.filter((x) => x.plane === 'A').length, b = m.members.filter((x) => x.plane === 'B').length;
  assert(a === 21 && b === 21, `${a} A, ${b} B`);
  assert(m.nodes.get('b3~B').y === p.design.trussSpacing);
  assert(m.bolts.filter((x) => x.memberId.endsWith('~B')).length === m.bolts.filter((x) => m.memberById.get(x.memberId).plane === 'A').length);
});

test('adding a joint partway along a line splits it and keeps bolts in place', () => {
  const p = normalizeProject(createExampleProject());
  p.design.nodes.push({ id: 'mid', plane: 'A', x: 17.5, y: 0, z: 0, bearing: false });
  splitSegment(p, 'm-BC1', 0, 'mid', 0.5);
  const m = p.design.members.find((x) => x.id === 'm-BC1');
  assert(JSON.stringify(m.segments) === JSON.stringify([['b0', 'mid'], ['mid', 'b1']]), JSON.stringify(m.segments));
  const model = buildModel(p);
  const xs = model.bolts.filter((b) => b.memberId === 'm-BC1').map((b) => Math.round(b.pos[0] * 100) / 100).sort((a, b) => a - b);
  assert(JSON.stringify(xs) === JSON.stringify([1.4, 3.15, 31.85, 33.6]), 'bolt x ' + xs);
  assert(near(model.memberById.get('m-BC1').length, 35, 1e-6));
});

test('grouping moves a line and its bolts into another member', () => {
  const p = normalizeProject(createExampleProject());
  moveSegment(p, 'm-BC2', 0, 'm-BC1');
  assert(!p.design.members.some((m) => m.id === 'm-BC2'), 'emptied member is removed');
  const m = buildModel(p).memberById.get('m-BC1');
  assert(m.segments.length === 2 && near(m.length, 70, 1e-6));
  assert(p.design.bolts.filter((b) => b.memberId === 'm-BC1').length === 8, 'bolts moved');
  assert(!m.box.fits, 'a 70 in member is too long');
  const id = detachSegment(p, 'm-BC1', 1);
  assert(id !== 'm-BC1' && p.design.members.find((x) => x.id === id).segments.length === 1);
});

test('auto-fill puts bolts at member ends that meet other members', () => {
  const p = normalizeProject(createExampleProject());
  p.design.bolts = [];
  const added = autoBolts(p, buildModel(p), 'A', 2);
  // 21 truss A members, both ends meet something: 21 * 2 ends * 2 bolts
  assert(added === 84, 'added ' + added);
  assert(autoBolts(p, buildModel(p), 'A', 2) === 0, 'running again adds nothing');
});

const pos = nodesOf([
  { id: 'p', x: 0, y: 0, z: 0 }, { id: 'q', x: 30, y: 0, z: 0 }, { id: 'r', x: 15, y: 0, z: 20 }, { id: 's', x: 60, y: 0, z: 0 },
]);

test('member on one bearing is not stable; on two it is', () => {
  const u = [{ key: 'm', nodeIds: ['p', 'q'], attached: {} }];
  assert(!computeStability({ units: u, supportNodes: new Set(['p']), nodePos: pos, rigidBoltCount: 2 }).stable.has('m'));
  assert(computeStability({ units: u, supportNodes: new Set(['p', 'q']), nodePos: pos, rigidBoltCount: 2 }).stable.has('m'));
});

test('two-bolt splice lets a member cantilever off a stable one', () => {
  const units = [
    { key: 'a', nodeIds: ['p', 'q'], attached: { q: 2 } },
    { key: 'b', nodeIds: ['q', 's'], attached: { q: 2 } },
  ];
  const r = computeStability({ units, supportNodes: new Set(['p', 'q']), nodePos: pos, rigidBoltCount: 2 });
  assert(r.stable.has('a') && r.stable.has('b'));
  const units1 = units.map((u) => ({ ...u, attached: { q: 1 } }));
  const r1 = computeStability({ units: units1, supportNodes: new Set(['p', 'q']), nodePos: pos, rigidBoltCount: 2 });
  assert(r1.stable.has('a') && !r1.stable.has('b'), 'single bolt is a pin');
});

test('pinned triangle is rigid once both legs are bolted at the apex', () => {
  const units = [
    { key: 'base', nodeIds: ['p', 'q'], attached: { p: 1, q: 1 } },
    { key: 'left', nodeIds: ['p', 'r'], attached: { p: 1, r: 1 } },
    { key: 'right', nodeIds: ['q', 'r'], attached: { q: 1, r: 1 } },
  ];
  const r = computeStability({ units, supportNodes: new Set(['p', 'q']), nodePos: pos, rigidBoltCount: 2 });
  assert(r.stable.has('left') && r.stable.has('right'), [...r.stable].join(','));
  const r2 = computeStability({ units: units.slice(0, 2), supportNodes: new Set(['p', 'q']), nodePos: pos, rigidBoltCount: 2 });
  assert(!r2.stable.has('left'), 'one leg alone swings');
});

test('paths go around a no-go zone', () => {
  const site = { width: 300, depth: 120, cell: 6, zones: [{ id: 'r', type: 'nogo', x: 120, y: 0, w: 60, h: 100 }] };
  const g = new SiteGrid(site);
  const m = g.mask(null);
  const p = g.path(m, { x: 30, y: 30 }, { x: 270, y: 30 });
  assert(p && p.length > 260, 'length ' + (p && p.length));
  assert(p.points.every((pt) => !(pt.x > 121 && pt.x < 179 && pt.y < 99)), 'path enters the river');
});

test('restricted builder cannot leave their zone', () => {
  const site = { width: 300, depth: 120, cell: 6, zones: [{ id: 'a', type: 'staging', x: 0, y: 0, w: 100, h: 120 }] };
  const g = new SiteGrid(site);
  assert(g.path(g.mask(['a']), { x: 30, y: 30 }, { x: 200, y: 30 }) === null);
});

test('example project builds completely with no errors', () => {
  const p = normalizeProject(createExampleProject());
  const r = simulate(p);
  assert(!r.errors.length, r.errors.map((e) => e.msg).join(' | '));
  assert(r.endTime > 60 && r.endTime < 3600, 'end time ' + r.endTime);
  assert(r.units.every((u) => u.installedAt != null && u.stableAt != null), 'all units installed and stable');
  window.exampleResult = r;
});

test('builders never carry two pieces at once', () => {
  const r = window.exampleResult;
  const byB = new Map();
  for (const s of r.segments) if (s.kind === 'carry' || s.kind === 'hold') { if (!byB.has(s.builderId)) byB.set(s.builderId, []); byB.get(s.builderId).push(s); }
  for (const list of byB.values()) {
    list.sort((a, b) => a.t0 - b.t0);
    for (let i = 1; i < list.length; i++) assert(list[i].t0 >= list[i - 1].t1 - 1e-6, 'overlap for ' + list[i].builderId);
  }
});

test('a builder never does two things at once', () => {
  const r = window.exampleResult;
  const byB = new Map();
  for (const s of r.segments) { if (!byB.has(s.builderId)) byB.set(s.builderId, []); byB.get(s.builderId).push(s); }
  for (const [id, list] of byB) {
    list.sort((a, b) => a.t0 - b.t0);
    for (let i = 1; i < list.length; i++) assert(list[i].t0 >= list[i - 1].t1 - 1e-6, `${id}: ${list[i - 1].label} overlaps ${list[i].label}`);
  }
});

test('a mid-span piece with nothing under it is held forever and reported', () => {
  const p = normalizeProject(createExampleProject());
  p.plans[0].steps = [{ id: 'x', kind: 'install', unit: { type: 'member', id: 'm-BC3' }, carrier: 'auto', fastener: 'auto' }];
  const r = simulate(p);
  assert(r.holds.length === 1 && r.holds[0].open, 'expected an open hold');
  assert(r.errors.some((e) => /never becomes stable/.test(e.msg)), r.errors.map((e) => e.msg).join(' | '));
});

test('pulling a support out from under a lone piece is reported as a fall', () => {
  const p = normalizeProject(createExampleProject());
  p.plans[0].assemblies = [];
  p.plans[0].steps = [
    { id: 'a', kind: 'support', action: 'place', toolId: 't-jack', nodeId: 'b1', builder: 'auto' },
    { id: 'b', kind: 'install', unit: { type: 'member', id: 'm-BC1' }, carrier: 'auto', fastener: 'auto' },
    { id: 'c', kind: 'support', action: 'remove', toolId: 't-jack', nodeId: 'b1', builder: 'auto' },
  ];
  const r = simulate(p);
  assert(r.errors.some((e) => /would fall/.test(e.msg)), r.errors.map((e) => e.msg).join(' | '));
});

test('everyone holding unstable pieces stops the plan with a clear message', () => {
  const p = normalizeProject(createExampleProject());
  p.plans[0].assemblies = [];
  const ids = ['m-BC3', 'm-BC3~B', 'm-BC4', 'm-BC4~B', 'm-TC2'];
  p.plans[0].steps = ids.map((id, i) => ({ id: 's' + i, kind: 'install', unit: { type: 'member', id }, carrier: 'auto', fastener: 'auto' }));
  const r = simulate(p);
  assert(r.aborted && r.errors.some((e) => /No builder can/.test(e.msg)), r.errors.map((e) => e.msg).join(' | '));
});

const ok = results.filter((r) => r.ok).length;
document.getElementById('out').innerHTML =
  `<h2>${ok} / ${results.length} passed</h2>` +
  results.map((r) => `<div class="${r.ok ? 'ok' : 'bad'}">${r.ok ? '✔' : '✘'} ${r.name}${r.msg ? ' — ' + r.msg : ''}</div>`).join('');
window.testResults = results;
