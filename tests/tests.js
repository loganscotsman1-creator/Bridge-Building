// Browser test runner: open tests/index.html (through a local server) and read the results.
import { fits3d, inPlaneLimits, maxThickness, buildModel, calibFromPoints, contact2d, boxCorners, footingPoints, imageToView, isConvex, isSimple, pointInPoly, pointOnContact, polyArea, polyFits, rectOfPoly, viewToImage } from '../js/model/geometry.js';
import { computeStability } from '../js/sim/stability.js';
import { SiteGrid } from '../js/sim/grid.js';
import { planTasks, simulate } from '../js/sim/simulate.js';
import { createExampleProject } from '../js/model/example.js';
import { emptyProject, normalizeProject } from '../js/model/schema.js';
import { site2027, RULES_2027 } from '../js/model/rules2027.js';
import { autoBolts, clampBox, newBox, removeMember } from '../js/model/edit.js';
import { snapBox, snapPoint, snapSize } from '../js/ui/snap.js';
import { assemblyConnections, defaultView, layOutAssembly, membersArea, stagedPoly, stagingSpots, viewSizes } from '../js/model/plan.js';
import { stateAt } from '../js/sim/playback.js';

const results = [];
async function test(name, fn) {
  try { await fn(); results.push({ name, ok: true }); } catch (e) { results.push({ name, ok: false, msg: e.message }); console.error(name, e); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function near(a, b, tol = 1e-6) { return Math.abs(a - b) <= tol; }

const box = (u, v, len, depth, angle = 0) => ({ u, v, len, depth, angle });

await test('boxes end to end touch along an edge', () => {
  const c = contact2d(boxCorners(box(0, 0, 10, 2)), boxCorners(box(10, 0, 10, 2)));
  assert(c && c.kind === 'edge', JSON.stringify(c));
  const L = Math.hypot(c.seg[1][0] - c.seg[0][0], c.seg[1][1] - c.seg[0][1]);
  assert(near(L, 2, 1e-6), 'edge length ' + L);
});

await test('boxes with a gap do not touch; overlapping boxes do', () => {
  assert(!contact2d(boxCorners(box(0, 0, 10, 2)), boxCorners(box(11, 0, 10, 2))));
  const c = contact2d(boxCorners(box(0, 0, 10, 2)), boxCorners(box(4, 1.5, 10, 2, 30)));
  assert(c && c.kind === 'overlap', JSON.stringify(c && c.kind));
});

await test('a vertical box standing on a chord touches along the chord top', () => {
  const chord = box(20, 0.75, 40, 1.5);
  const post = box(10, 1.5 + 2.5, 5, 1.5, 90);
  const c = contact2d(boxCorners(chord), boxCorners(post));
  assert(c && c.kind === 'edge' && near(Math.abs(c.seg[1][0] - c.seg[0][0]), 1.5, 1e-6), JSON.stringify(c));
});

await test('dragging a box near another snaps its edge on and lines up the ends', () => {
  const target = boxCorners(box(0, 0, 20, 2));
  const moving = box(0.4, 2.3, 20, 2, 2); // a bit high, a bit off, slightly rotated
  const { box: b } = snapBox(moving, [target], 0.6);
  assert(near(b.angle % 180, 0, 1e-6), 'angle ' + b.angle);
  assert(near(b.v, 2, 1e-6), 'v ' + b.v);
  assert(near(b.u, 0, 1e-6), 'u ' + b.u);
});

await test('resizing snaps the moving end to a neighbouring edge', () => {
  const target = boxCorners(box(30, 0, 10, 2)); // left edge at x = 25
  const b = box(10, 0, 20, 2); // right end at 20, back end fixed at 0
  const size = snapSize(b, 'len', 1, 24.6, [target], 0.6);
  assert(near(size, 25, 1e-6), 'size ' + size);
});

await test('a reshaped box must still fit the size box', () => {
  const lim = { len: 42, depth: 6, thick: 4 };
  const trapezoid = [[0, 0], [40, 0], [36, 5], [4, 5]];
  assert(polyFits(trapezoid, lim), 'trapezoid fits');
  assert(!polyFits([[0, 0], [40, 0], [40, 7], [0, 7]], lim), '7 in deep does not');
  const r = rectOfPoly(trapezoid);
  assert(near(r.len, 40, 1e-6) && near(r.depth, 5, 1e-6), JSON.stringify(r));
  assert(!isConvex([[0, 0], [10, 0], [2, 2], [10, 4], [0, 4]]), 'dented shape is not convex');
  // A long thin shape on a diagonal still fits when turned.
  const diag = [[0, 0], [29, 29], [27, 31], [-2, 2]];
  assert(polyFits(diag, lim), 'diagonal box fits');
});

await test('shapes with extra corners (even notched ones) fit, hit-test and touch correctly', () => {
  const lim = { len: 42, depth: 6, thick: 4 };
  // A chord with a gusset tab sticking up in the middle (a T), 40 x 6 overall.
  const T = [[0, 0], [40, 0], [40, 3], [24, 3], [24, 6], [16, 6], [16, 3], [0, 3]];
  assert(isSimple(T) && !isConvex(T) && polyFits(T, lim), 'T is a valid shape');
  assert(!isSimple([[0, 0], [10, 0], [0, 4], [10, 4]]), 'a crossed outline is refused');
  assert(pointInPoly([20, 5], T) && !pointInPoly([5, 5], T), 'inside the tab, not over the notch');
  const r = rectOfPoly(T);
  assert(near(r.len, 40, 1e-6) && near(r.depth, 6, 1e-6), JSON.stringify(r));
  // A post standing in the notch beside the tab touches the tab's side edge and the chord top.
  const post = [[10, 3], [16, 3], [16, 20], [10, 20]];
  const c = contact2d(T, post);
  assert(c && c.kind === 'edge', 'post in the notch touches along an edge: ' + JSON.stringify(c));
  // A plate lapped over the tab overlaps only the tab, not the empty notch beside it.
  const plate = [[12, 4], [28, 4], [28, 10], [12, 10]];
  const o = contact2d(T, plate);
  const area = o.pieces.reduce((s, q) => s + Math.abs(polyArea(q)), 0);
  assert(o.kind === 'overlap' && near(area, 16, 1e-6), 'overlap area ' + area);
  assert(pointOnContact(o, [20, 5]) && !pointOnContact(o, [13, 5]), 'bolt spots follow the real overlap');
});

await test('snapping a point catches corners first, then edges', () => {
  const t = [[[0, 0], [10, 0], [10, 2], [0, 2]]];
  const c = snapPoint([10.3, 2.2], t, 0.6);
  assert(c.kind === 'corner' && c.p[0] === 10 && c.p[1] === 2, JSON.stringify(c));
  const e = snapPoint([5, 2.4], t, 0.6);
  assert(e.kind === 'edge' && near(e.p[1], 2, 1e-9), JSON.stringify(e));
  assert(snapPoint([5, 4], t, 0.6).kind === null);
});

await test('footing supports are centered on the 2027 footings at the chosen distance', () => {
  const p = emptyProject();
  const def = footingPoints(p);
  assert(near(def.west, 6) && near(def.east, 270) && near(def.span, 264), JSON.stringify(def));
  const wide = footingPoints(p, 270);
  assert(near(wide.west, 3) && near(wide.east, 273), JSON.stringify(wide));
});

await test('members standing on a footing are found automatically', () => {
  const m = buildModel(normalizeProject(createExampleProject()));
  const piers = m.members.filter((x) => /P\d/.test(x.name));
  assert(piers.length === 4 && piers.every((x) => x.bearing && x.autoBearing), piers.map((x) => x.name + ':' + x.bearing).join(','));
  assert(m.members.filter((x) => x.bearing).length === 4, 'only the piers');
  const p = normalizeProject(createExampleProject());
  p.design.members.find((x) => x.id === 'm-P1').bearing = false;
  assert(!buildModel(p).memberById.get('m-P1').bearing, 'a hand setting wins');
});

await test('new boxes start at the full size box and never exceed it', () => {
  const p = emptyProject();
  const m = newBox(p, 'A', 0, 0);
  assert(m.len === 42 && m.depth === 6 && m.thick === 4, JSON.stringify(m));
});

await test('image calibration maps the two clicked points to the typed coordinates', () => {
  for (const flip of [true, false]) {
    const p1 = { px: 100, py: 400, u: 0, v: 0 }, p2 = { px: 900, py: 380, u: 210, v: 0 };
    const c = calibFromPoints(flip, p1, p2);
    for (const p of [p1, p2]) {
      const w = imageToView(c, flip, p.px, p.py);
      assert(near(w.u, p.u, 1e-6) && near(w.v, p.v, 1e-6), `flip=${flip}: got ${w.u},${w.v}`);
      const back = viewToImage(c, flip, p.u, p.v);
      assert(near(back.px, p.px, 1e-6) && near(back.py, p.py, 1e-6), 'inverse');
    }
    if (flip) assert(imageToView(c, flip, 500, 200).v > 0, 'z should point up');
  }
});

await test('the 2027 layout matches the site plan dimensions', () => {
  const s = site2027();
  assert(s.width === 720 && s.depth === 180, 'site 60 ft × 15 ft');
  const z = (name) => s.zones.find((x) => x.name === name);
  assert(z('River').w === 84 && z('River').x === 264, 'river 7 ft');
  assert(z('Transportation zone').w === 168, 'transportation zone 14 ft');
  assert(z('East staging yard').w === 144 && z('West staging yard').w === 60, 'staging yards');
  // Outer edges of the footings are 23 ft apart (Bridge Elevation Diagram).
  assert(z('East footing').x + z('East footing').w - z('West footing').x === 276, 'footings 23 ft out to out');
  assert(RULES_2027.maxBuilders === 6 && RULES_2027.maxAssemblyMembers === 3);
});

await test('the shared library copy of the 2027 layout matches the built-in one', async () => {
  const index = await (await fetch('../library/sites/index.json')).json();
  const entry = index.sites.find((s) => s.year === '2027');
  assert(entry, 'no 2027 entry in the library');
  const file = await (await fetch('../library/sites/' + entry.file)).json();
  const built = site2027();
  assert(JSON.stringify(file.zones) === JSON.stringify(built.zones), 'zones differ');
  assert(JSON.stringify(file.rules) === JSON.stringify(built.rules), 'rules differ');
});

await test('mirroring copies truss A boxes and bolts to truss B', () => {
  const p = normalizeProject(createExampleProject());
  const m = buildModel(p);
  const a = m.members.filter((x) => x.plane === 'A').length, b = m.members.filter((x) => x.plane === 'B').length;
  assert(a === b && a > 10, `${a} A, ${b} B`);
  assert(m.bolts.filter((x) => x.plane === 'B').length === m.bolts.filter((x) => x.plane === 'A').length);
});

await test('example: every place members touch has a bolt, and laterals meet both trusses', () => {
  const m = buildModel(normalizeProject(createExampleProject()));
  assert(m.contacts.every((c) => c.bolts > 0), m.contacts.filter((c) => !c.bolts).map((c) => c.id).join(', '));
  for (const l of m.members.filter((x) => x.plane === 'L')) {
    const sides = m.contacts.filter((c) => c.a === l.id || c.b === l.id).map((c) => m.memberById.get(c.a === l.id ? c.b : c.a).plane);
    assert(sides.includes('A') && sides.includes('B'), l.name + ' touches ' + sides.join(','));
  }
  assert(m.bolts.every((b) => b.jointId), 'every bolt is on a connection');
});

await test('auto-fill adds bolts only where boxes touch without one', () => {
  const p = normalizeProject(createExampleProject());
  p.design.bolts = [];
  const n = autoBolts(p, buildModel(p), 'A', 1);
  const model = buildModel(p);
  const aContacts = model.contacts.filter((c) => c.plane === 'A').length;
  assert(n === aContacts, `${n} vs ${aContacts}`);
  assert(autoBolts(p, model, 'A', 1) === 0, 'second run adds nothing');
});

const pos = new Map(Object.entries({ p: { x: 0, y: 0, z: 0 }, q: { x: 30, y: 0, z: 0 }, r: { x: 15, y: 0, z: 20 }, s: { x: 60, y: 0, z: 0 } }));

await test('stability: one pin swings, two pins hold, two bolts cantilever', () => {
  const u = [{ key: 'm', nodeIds: ['p', 'q'], attached: {} }];
  assert(!computeStability({ units: u, supportNodes: new Set(['p']), nodePos: pos, rigidBoltCount: 2 }).stable.has('m'));
  assert(computeStability({ units: u, supportNodes: new Set(['p', 'q']), nodePos: pos, rigidBoltCount: 2 }).stable.has('m'));
  const units = [{ key: 'a', nodeIds: ['p', 'q'], attached: { q: 2 } }, { key: 'b', nodeIds: ['q', 's'], attached: { q: 2 } }];
  assert(computeStability({ units, supportNodes: new Set(['p', 'q']), nodePos: pos, rigidBoltCount: 2 }).stable.has('b'));
});

await test('stability: a rigidly bolted chain is one body, held by footings at both ends', () => {
  const chain = [
    { key: 'a', nodeIds: ['p', 'j1'], attached: { j1: 2 } },
    { key: 'b', nodeIds: ['j1', 'j2'], attached: { j1: 2, j2: 2 } },
    { key: 'c', nodeIds: ['j2', 's'], attached: { j2: 2 } },
  ];
  const P = new Map([...pos, ['j1', { x: 20, y: 0, z: 0 }], ['j2', { x: 40, y: 0, z: 0 }]]);
  const both = computeStability({ units: chain, supportNodes: new Set(['p', 's']), nodePos: P, rigidBoltCount: 2 });
  assert(['a', 'b', 'c'].every((k) => both.stable.has(k)), [...both.stable].join(','));
  const one = computeStability({ units: chain, supportNodes: new Set(['p']), nodePos: P, rigidBoltCount: 2 });
  assert(one.stable.size === 0, 'one pinned end swings: ' + [...one.stable].join(','));
});

await test('stability: a pinned triangle is rigid', () => {
  const units = [
    { key: 'base', nodeIds: ['p', 'q'], attached: { p: 1, q: 1 } },
    { key: 'left', nodeIds: ['p', 'r'], attached: { p: 1, r: 1 } },
    { key: 'right', nodeIds: ['q', 'r'], attached: { q: 1, r: 1 } },
  ];
  const r = computeStability({ units, supportNodes: new Set(['p', 'q']), nodePos: pos, rigidBoltCount: 2 });
  assert(r.stable.has('left') && r.stable.has('right'));
});

await test('stability: one builder holding a lateral holds up both trusses through it', () => {
  // Truss A and truss B pieces each pinned once at a footing (they'd swing), and a lateral pinned
  // to both of them.
  const units = [
    { key: 'A', nodeIds: ['fa', 'la'], attached: { fa: 1, la: 1 } },
    { key: 'B', nodeIds: ['fb', 'lb'], attached: { fb: 1, lb: 1 } },
    { key: 'L', nodeIds: ['la', 'lb'], attached: { la: 1, lb: 1 } },
  ];
  const nodePos = new Map([['fa', { x: 0, y: 0, z: 0 }], ['fb', { x: 0, y: 38, z: 0 }], ['la', { x: 30, y: 0, z: 12 }], ['lb', { x: 30, y: 38, z: 12 }]]);
  const args = { units, supportNodes: new Set(['fa', 'fb']), nodePos, rigidBoltCount: 2 };
  const free = computeStability(args).stable;
  assert(!free.has('A') && !free.has('B') && !free.has('L'), 'nothing stands without a hand');
  const held = computeStability({ ...args, held: new Set(['L']) }).stable;
  assert(held.has('A') && held.has('B'), 'holding the lateral holds both sides');
});

await test('builders cannot cross the river on the 2027 site', () => {
  const g = new SiteGrid(site2027());
  const m = g.mask(null);
  assert(g.path(m, { x: 30, y: 90 }, { x: 650, y: 40 }) === null, 'west yard reached the east yard');
  assert(g.path(m, { x: 600, y: 130 }, { x: 380, y: 90 }), 'east yard to east construction zone');
  assert(g.handoffs(m, m, 90).length === 0, 'same area needs no hand-off');
  const east = g.region(m, { x: 600, y: 130 }), west = g.region(m, { x: 30, y: 90 });
  assert(east.key !== west.key && g.handoffs(east, west, 90).length > 0, 'the river splits the ground into two regions');
});

await test('pieces can be handed across the river within reach', () => {
  const s = site2027();
  const g = new SiteGrid(s);
  const zid = (name) => s.zones.find((z) => z.name === name).id;
  const east = g.mask([zid('East construction zone'), zid('Transportation zone'), zid('East staging yard')]);
  const west = g.mask([zid('West construction zone'), zid('Riverbank'), zid('West staging yard')]);
  const spots = g.handoffs(east, west, 90);
  assert(spots.length > 0 && spots.every((h) => h.d <= 90), 'hand-off spots ' + spots.length);
  assert(g.handoffs(east, west, 80).length === 0, 'a 7 ft river is too wide to pass across with 80 in');
});

await test('example project builds completely with no errors', () => {
  const p = normalizeProject(createExampleProject());
  const r = simulate(p);
  assert(!r.errors.length, r.errors.map((e) => e.msg).join(' | '));
  assert(r.endTime > 60 && r.endTime < 30 * 60, 'end time ' + r.endTime);
  assert(r.units.every((u) => u.installedAt != null && u.stableAt != null), 'all units installed and stable');
  assert(r.handoffs > 0, 'some pieces are handed across the river');
  assert(r.cost > 0, 'construction cost');
  window.exampleResult = r;
  window.exampleProject = p;
});

await test('assemblies are bolted together where their members are staged (nothing carried first)', () => {
  const r = window.exampleResult;
  for (const id of ['m-P1', 'm-TC1', 'm-BC1']) {
    const evs = r.tracks.get(id).map((e) => e.kind + (e.assembled ? '*' : ''));
    const firstCarry = evs.indexOf('carried'), assembled = evs.indexOf('ground*');
    assert(assembled > 0 && (firstCarry === -1 || firstCarry > assembled), id + ': ' + evs.join(' → '));
  }
  assert(r.segments.some((s) => s.kind === 'assemble'), 'there is assembly work');
});

await test('staging-yard bolt times and per-connection overrides change only what they should', () => {
  const base = normalizeProject(createExampleProject());
  const asmTime = (r) => r.segments.filter((s) => s.kind === 'assemble').reduce((a, s) => a + s.t1 - s.t0, 0);
  const fastenOf = (r, jid) => r.segments.filter((s) => s.kind === 'fasten' && s.nodeId === jid).reduce((a, s) => a + s.t1 - s.t0, 0);
  const r0 = simulate(base);
  const p1 = structuredClone(base);
  p1.timing.assemblyBoltTime = 30;
  const r1 = simulate(p1);
  assert(asmTime(r1) > asmTime(r0) + 1, `assembly ${asmTime(r0)} -> ${asmTime(r1)}`);
  // A bridge connection (not inside an assembly) with its own per-bolt time.
  const seg = r0.segments.find((x) => x.kind === 'fasten' && x.nodeId && x.nodeId.endsWith(':A'));
  const p2 = structuredClone(base);
  p2.design.connections = { [seg.nodeId]: { boltTime: 20 } };
  const r2 = simulate(p2);
  assert(near(fastenOf(r2, seg.nodeId), seg.bolts * 20, 1e-6), `override ${fastenOf(r2, seg.nodeId)} vs ${seg.bolts * 20}`);
  // ...and its truss B copy follows it.
  const bId = seg.nodeId.replace(/^j:(.*)\|(.*):A$/, (_, a, b) => 'j:' + [a + '~B', b + '~B'].sort().join('|') + ':B');
  if (r0.segments.some((x) => x.nodeId === bId)) assert(near(fastenOf(r2, bId), seg.bolts * 20, 1e-6), 'mirror copy uses the override');
});

await test('a bolt through three members can wait until all three are in place', () => {
  const p = normalizeProject(createExampleProject());
  // Stack a gusset X over the TC1|TC2 joint and put one bolt through all three.
  const model = buildModel(p);
  const c = model.contacts.find((q) => q.plane === 'A' && q.kind === 'edge' && q.a === 'm-TC1' && q.b === 'm-TC2');
  const pt = [(c.seg[0][0] + c.seg[1][0]) / 2, (c.seg[0][1] + c.seg[1][1]) / 2];
  p.design.members.push({ id: 'mX', name: 'X1', plane: 'A', u: pt[0], v: pt[1], angle: 0, len: 6, depth: 2, thick: 1, z: 0 });
  p.design.bolts = p.design.bolts.filter((b) => !(['m-TC1', 'm-TC2'].includes(b.a) && ['m-TC1', 'm-TC2'].includes(b.b)));
  p.design.bolts.push({ id: 'bX', plane: 'A', a: 'm-TC1', b: 'm-TC2', more: ['mX'], u: pt[0], v: pt[1] - 0.3 });
  const m2 = buildModel(p);
  for (const q of m2.contacts.filter((q) => q.plane === 'A' && (q.a === 'mX' || q.b === 'mX'))) {
    if (!q.bolts) p.design.bolts.push({ id: 'bf' + q.id, plane: 'A', a: q.a, b: q.b, u: (q.poly ? q.poly[0][0] : q.seg[0][0]), v: (q.poly ? q.poly[0][1] : q.seg[0][1]) });
  }
  const plan = p.plans[0];
  const idxTC2 = plan.steps.findIndex((s) => s.kind === 'install' && s.unit.id === 'm-TC2');
  plan.steps.splice(idxTC2 + 1, 0, { id: 'sX', kind: 'install', unit: { type: 'member', id: 'mX' }, carrier: 'auto', fastener: 'auto' });
  const idxB = plan.steps.findIndex((s) => s.kind === 'install' && s.unit.id === 'm-TC2~B');
  plan.steps.splice(idxB + 1, 0, { id: 'sXB', kind: 'install', unit: { type: 'member', id: 'mX~B' }, carrier: 'auto', fastener: 'auto' });
  const fastenedWith = (r) => r.segments.filter((s) => s.kind === 'fasten' && s.label.includes('X1') === false && s.nodeId === c.id).reduce((a, s) => a + (s.bolts || 0), 0);
  const first = simulate(p);
  p.design.bolts.find((b) => b.id === 'bX').when = 'all';
  const all = simulate(p);
  // With "first" the stack bolt goes in at TC1-TC2; with "all" it waits for X1.
  assert(fastenedWith(first) >= 1, 'first: bolt at TC1-TC2');
  assert(fastenedWith(all) === 0, 'all: nothing fastened at TC1-TC2 yet');
  const xSeg = all.segments.filter((s) => s.kind === 'fasten' && s.unitKey === 'm:mX').reduce((a, s) => a + (s.bolts || 0), 0);
  assert(xSeg >= 1, 'all: the bolt goes in with X1');
  assert(!all.warnings.some((w) => /never go/.test(w.msg || w)), 'every bolt goes in');
});

await test('construction cost follows the 2027 formula', () => {
  const r = window.exampleResult;
  const expected = (r.endTime / 60) * 4 * 172500 * 0.8;
  assert(near(r.cost, expected, 1e-6), `${r.cost} vs ${expected}`);
});

await test('nobody does two things at once, and everyone ends in a staging yard', () => {
  const r = window.exampleResult, p = window.exampleProject;
  const byB = new Map();
  for (const s of r.segments) { if (!byB.has(s.builderId)) byB.set(s.builderId, []); byB.get(s.builderId).push(s); }
  const yards = p.site.zones.filter((z) => z.type === 'staging');
  for (const [id, list] of byB) {
    list.sort((a, b) => a.t0 - b.t0);
    for (let i = 1; i < list.length; i++) assert(list[i].t0 >= list[i - 1].t1 - 1e-6, `${id}: ${list[i - 1].label} overlaps ${list[i].label}`);
    const last = list[list.length - 1];
    const end = last.path ? last.path[last.path.length - 1] : { x: last.x, y: last.y };
    assert(yards.some((z) => end.x >= z.x - 1 && end.x <= z.x + z.w + 1 && end.y >= z.y - 1 && end.y <= z.y + z.h + 1), `${id} ends at ${Math.round(end.x)},${Math.round(end.y)}`);
  }
});

await test('builders stand in a construction zone or on the riverbank while holding or fastening', () => {
  const r = window.exampleResult, p = window.exampleProject;
  const work = p.site.zones.filter((z) => ['construction', 'riverbank', 'footing'].includes(z.type));
  for (const s of r.segments) {
    if (!['hold', 'align', 'fasten', 'support'].includes(s.kind)) continue;
    assert(work.some((z) => s.x >= z.x - 1 && s.x <= z.x + z.w + 1 && s.y >= z.y - 1 && s.y <= z.y + z.h + 1), `${s.label} at ${Math.round(s.x)},${Math.round(s.y)}`);
  }
});

await test('a piece that starts off a footing is reported (10.3.11)', () => {
  const p = normalizeProject(createExampleProject());
  p.plans[0].assemblies = [];
  p.plans[0].steps = [{ id: 'x', kind: 'install', unit: { type: 'member', id: 'm-TC4' }, carrier: 'auto', fastener: 'auto' }];
  const r = simulate(p);
  assert(r.errors.some((e) => /10\.3\.11/.test(e.msg)), r.errors.map((e) => e.msg).join(' | '));
  assert(r.holds.length === 1 && r.holds[0].open, 'held forever');
});

await test('assemblies over the member limit are reported (10.3.7)', () => {
  const p = normalizeProject(createExampleProject());
  p.plans[0].assemblies[0].memberIds.push('m-V1');
  const r = simulate(p);
  assert(r.errors.some((e) => /10\.3\.7/.test(e.msg)), r.errors.map((e) => e.msg).join(' | '));
});

await test('too many builders is reported (10.2.2)', () => {
  const p = normalizeProject(createExampleProject());
  for (let i = 0; i < 3; i++) p.builders.push({ ...p.builders[2], id: 'extra' + i, name: 'Extra ' + i });
  const r = simulate(p);
  assert(r.errors.some((e) => /10\.2\.2/.test(e.msg)));
});

await test('a support left under the bridge at the finish is reported (10.9.1)', () => {
  const p = normalizeProject(createExampleProject());
  p.plans[0].steps = p.plans[0].steps.filter((s) => !(s.kind === 'support' && s.action === 'remove'));
  const r = simulate(p);
  assert(r.errors.some((e) => /10\.9\.1/.test(e.msg)), r.errors.map((e) => e.msg).join(' | '));
});

await test('every new member is staged inside the members area, even when there are many', () => {
  const p = normalizeProject(createExampleProject());
  for (const n of [p.design.members.length, 150]) {
    while (p.design.members.length < n) p.design.members.push({ ...newBox(p, 'A', 0, 0), id: 'X' + p.design.members.length, name: 'X' + p.design.members.length });
    p.site.staging = {};
    const model = buildModel(p);
    const area = membersArea(p.site);
    const spots = stagingSpots(p, model);
    assert(spots.size === model.members.length, 'spots ' + spots.size);
    for (const m of model.members) {
      const s = spots.get(m.id);
      assert(s.x - m.len / 2 >= area.x - 1e-6 && s.x + m.len / 2 <= area.x + area.w + 1e-6 && s.y - m.depth / 2 >= area.y - 1e-6 && s.y + m.depth / 2 <= area.y + area.h + 1e-6, `${m.name} at ${s.x},${s.y} (n=${n})`);
    }
  }
});

await test('one bolt through three overlapping members holds all three connections', () => {
  const p = emptyProject();
  p.design.footingSpan = 200;
  const mk = (id, u, v, angle) => ({ ...newBox(p, 'A', u, v, angle), id, name: id });
  p.design.members = [mk('P', 20, 3, 0), mk('Q', 20, 3, 90), mk('R', 20, 3, 45)];
  p.design.bolts = [{ id: 'b1', plane: 'A', a: 'P', b: 'Q', more: ['R'], u: 20, v: 3 }];
  const model = buildModel(p);
  const b = model.bolts[0];
  assert(b.memberIds.length === 3 && b.jointIds.length === 3, JSON.stringify(b.jointIds));
  for (const c of model.contacts) assert(c.bolts === 1, c.id + ' has ' + c.bolts);
  removeMember(p, 'R');
  assert(p.design.bolts.length === 1 && !p.design.bolts[0].more, JSON.stringify(p.design.bolts));
  removeMember(p, 'Q');
  assert(p.design.bolts.length === 0, 'bolt through one member should go');
});

await test('boxes are 3D: the out-of-view size depends on the other two', () => {
  const lim = { len: 42, depth: 6, thick: 4 };
  const rect = (l, d) => [[0, 0], [l, 0], [l, d], [0, d]];
  assert(maxThickness(rect(6, 4), lim) === 42, '6 x 4 can run 42 across');
  assert(maxThickness(rect(30, 4), lim) === 6, '30 x 4 leaves 6');
  assert(maxThickness(rect(30, 6), lim) === 4, '30 x 6 leaves 4');
  assert(fits3d(rect(6, 4), 42, lim) && !fits3d(rect(7, 4), 42, lim), '7 x 4 x 42 does not fit');
  assert(inPlaneLimits(42, lim).len === 6 && inPlaneLimits(5, lim).depth === 4, 'limits in the view shrink');
  const p = emptyProject();
  const m = { ...newBox(p, 'A', 0, 0), thick: 42 };
  clampBox(p, m);
  assert(m.len === 6 && m.depth === 4, `clamped to ${m.len} x ${m.depth}`);
});

await test('a member extended across the bridge connects both trusses and has no mirror copy', () => {
  const p = emptyProject();
  p.design.footingSpan = 200;
  p.design.trussSpacing = 38;
  p.design.members = [
    { ...newBox(p, 'A', 20, 10, 0), id: 'C', name: 'C', len: 40, depth: 4, thick: 2 },
    { ...newBox(p, 'A', 20, 14, 0), id: 'X', name: 'X', len: 6, depth: 4, thick: 40, off: 19 },
  ];
  const model = buildModel(p);
  assert(model.memberById.has('C~B') && !model.memberById.has('X~B'), 'only the chord is mirrored');
  const x = model.memberById.get('X');
  assert(x.box.fits && near(x.yRange[0], -1) && near(x.yRange[1], 39), JSON.stringify(x.yRange));
  assert(near(x.long, 40) && near(x.weight, (40 / 12) * p.design.lbPerFt), 'weight follows its longest size');
  const pair = (a, b) => model.contacts.find((c) => (c.a === a && c.b === b) || (c.a === b && c.b === a));
  assert(pair('C', 'X')?.plane === 'A', 'touches truss A in its side view');
  assert(pair('C~B', 'X')?.plane === 'B', 'touches truss B in its side view');
  // A bolt on truss A is copied to truss B, where the same cross member is.
  const seg = pair('C', 'X').seg;
  p.design.bolts = [{ id: 'b', plane: 'A', a: 'C', b: 'X', u: (seg[0][0] + seg[1][0]) / 2, v: seg[0][1] }];
  const m2 = buildModel(p);
  assert(m2.bolts.length === 2 && m2.bolts.every((b) => b.jointId), JSON.stringify(m2.bolts.map((b) => b.jointId)));
  assert(near(m2.bolts[1].pos[1], 38, 1.5), 'copy sits at truss B: ' + m2.bolts[1].pos[1]);
  // Too big a box isn't accepted: 6 x 5 in the side view can't also be 40 across.
  p.design.members[1].depth = 5;
  assert(!buildModel(p).memberById.get('X').box.fits, 'over the 3D limit');
});

await test('every bolt gets an event, and builders count down what they carry', () => {
  const p = normalizeProject(createExampleProject());
  const r = simulate(p);
  const put = r.boltEvents.filter((e) => e.kind !== 'tighten');
  assert(put.length === r.model.bolts.filter((b) => b.jointId).length, `${put.length} events, ${r.model.bolts.length} bolts`);
  assert(new Set(put.map((e) => e.boltId)).size === put.length, 'each bolt goes in once');
  const end = stateAt(r, r.endTime);
  assert(end.boltCounts.fastened === put.length && end.boltCounts.inserted === 0, JSON.stringify(end.boltCounts));
  const mid = stateAt(r, put[Math.floor(put.length / 2)].t0 + (put[Math.floor(put.length / 2)].t1 - put[Math.floor(put.length / 2)].t0) * 0.25);
  assert([...mid.bolts.values()].some((b) => b.state === 'moving'), 'a bolt is on its way');
  const q = structuredClone(p);
  q.builders[1].boltCount = 1;
  assert(simulate(q).warnings.some((w) => /starts with 1 bolt/.test(w.msg)), 'warns when someone runs out');
});

await test('a bolt can hold when just inserted, until someone comes back to fasten it', () => {
  const base = normalizeProject(createExampleProject());
  const r0 = simulate(base);
  const p = structuredClone(base);
  for (const b of p.design.bolts) if (b.plane === 'A') b.snug = true;
  const r1 = simulate(p);
  assert(!r1.errors.length, r1.errors[0]?.msg);
  const ins = r1.boltEvents.filter((e) => e.kind === 'insert'), tight = r1.boltEvents.filter((e) => e.kind === 'tighten');
  assert(ins.length > 0 && tight.length === ins.length, `${ins.length} inserted, ${tight.length} tightened`);
  assert(tight.every((e) => e.t0 >= ins.find((i) => i.boltId === e.boltId).t1 - 1e-6), 'nuts go on after the bolts');
  assert(r1.warnings.some((w) => /fastened at the end/.test(w.msg)), 'says it fastened them at the end');
  // Partway through, some bolts are only inserted.
  const during = stateAt(r1, ins[ins.length - 1].t1 + 0.01);
  assert(during.boltCounts.inserted > 0, 'partly connected shows');
  assert(stateAt(r1, r1.endTime).boltCounts.inserted === 0, 'all fastened at the end');
  assert(r1.endTime !== r0.endTime, 'timing changes');
  // A step in the plan does it sooner, for one member.
  const q = structuredClone(p);
  const memberId = q.design.bolts.find((b) => b.snug).a;
  const i = q.plans[0].steps.findIndex((s) => s.kind === 'install' && s.unit.id === 'm-V3');
  q.plans[0].steps.splice(i + 1, 0, { id: 'sf', kind: 'fasten', scope: 'all', builder: 'auto' });
  const r2 = simulate(q);
  const stepTight = r2.segments.filter((s) => s.step === i + 1 && s.kind === 'fasten');
  assert(i >= 0 && stepTight.length > 0, 'the step fastens: ' + memberId);
});

await test('assembly members staged touching go together faster, with their own times', () => {
  const p = normalizeProject(createExampleProject());
  const model = buildModel(p);
  const plan = p.plans[0];
  const conns = assemblyConnections(p, model, plan);
  assert(conns.every((c) => c.joints.length && c.joints.every((j) => j.touching)), 'laid out touching');
  const area = membersArea(p.site);
  const spots = stagingSpots(p, model);
  for (const id of plan.assemblies.flatMap((a) => a.memberIds)) {
    for (const [x, y] of stagedPoly(model.memberById.get(id), spots.get(id))) assert(x >= area.x - 1e-6 && x <= area.x + area.w + 1e-6 && y >= area.y - 1e-6 && y <= area.y + area.h + 1e-6, id + ' stays in the area');
  }
  const time = (r) => r.segments.filter((s) => s.kind === 'assemble').reduce((t, s) => t + s.t1 - s.t0, 0);
  const near0 = simulate(p);
  // Sent back to the automatic stack, they count as not touching.
  const q = structuredClone(p);
  q.site.staging = {};
  assert(assemblyConnections(q, buildModel(q), q.plans[0]).every((c) => c.joints.every((j) => !j.touching)), 'auto-stacked pieces never count');
  assert(time(simulate(q)) > time(near0) + 1, `${time(simulate(q))} vs ${time(near0)}`);
  // One connection's own time wins over the touching default.
  const j = conns[0].joints[0].joint;
  const o = structuredClone(p);
  o.design.connections = { [j.timeKey]: { alignTime: 50 } };
  assert(time(simulate(o)) > time(near0) + 40, 'override used');
  // Moving one away breaks it.
  const away = structuredClone(p);
  away.site.staging[j.a] = { ...away.site.staging[j.a], x: area.x + 2, y: area.y + area.h - 2 };
  const still = assemblyConnections(away, buildModel(away), away.plans[0])[0].joints.find((x) => x.joint.id === j.id);
  assert(!still.touching, 'no longer touching');
  assert(layOutAssembly(away, buildModel(away), away.plans[0].assemblies[0]) !== undefined, 'lays out again');
});

// A project whose plan is a step list, as the app uses it.
function taskProject() {
  const p = normalizeProject(createExampleProject());
  const pl = p.plans[0];
  pl.tasks = planTasks(p, pl, pl.steps);
  pl.steps = [];
  return p;
}

await test('the automatic plan becomes steps that build the bridge with no errors', () => {
  const p = taskProject();
  const pl = p.plans[0];
  assert(pl.tasks.length > 100, 'steps: ' + pl.tasks.length);
  const r = simulate(p);
  assert(!r.errors.length, r.errors.map((e) => e.msg).slice(0, 3).join(' | '));
  assert(!r.aborted && r.endTime > 60, 'end ' + r.endTime);
  const model = buildModel(p);
  for (const m of model.members) assert(r.tracks.get(m.id).some((e) => e.kind === 'bridge'), m.name + ' placed');
  const end = stateAt(r, r.endTime);
  assert(end.boltCounts.fastened === model.bolts.filter((b) => b.jointId).length, JSON.stringify(end.boltCounts));
  assert(r.handoffs > 0, 'pieces cross the river');
  // Nobody does two main things at once, and nothing starts before its piece is placed.
  for (const b of r.builders) {
    const segs = r.segments.filter((s) => s.builderId === b.id && !s.along).sort((x, y) => x.t0 - y.t0);
    for (let i = 1; i < segs.length; i++) assert(segs[i].t0 >= segs[i - 1].t1 - 1e-6, `${b.name}: ${segs[i - 1].label} overlaps ${segs[i].label}`);
  }
});

await test('multitasking: a nut fastened while supporting overlaps, and takes the slowdown', () => {
  const p = taskProject();
  const pl = p.plans[0];
  const nut = pl.tasks.find((t) => t.kind === 'nut' && t.where === 'bridge');
  const bolt = pl.tasks.find((t) => t.kind === 'bolt' && t.jointId === nut.jointId && t.where === 'bridge');
  const joint = buildModel(p).contacts.find((c) => c.id === nut.jointId);
  const unit = [...pl.tasks].reverse().find((t) => t.kind === 'support' && (t.member === joint.a || t.member === joint.b)) || pl.tasks.find((t) => t.kind === 'support');
  // The builder supporting the piece does the bolt and nut themselves, at the same time.
  const ids = [bolt.id, nut.id];
  const list = pl.tasks.filter((t) => !ids.includes(t.id));
  const at = list.indexOf(unit);
  list.splice(at + 1, 0, { ...bolt, builder: unit.builder, along: true }, { ...nut, builder: unit.builder, along: true });
  pl.tasks = list;
  const r = simulate(p);
  const hold = r.segments.find((s) => s.taskId === unit.id && s.kind === 'hold');
  const work = r.segments.filter((s) => s.taskId === nut.id && s.kind === 'fasten');
  assert(hold && work.length, 'both happen');
  assert(work.every((s) => s.along && s.t0 >= hold.t0 - 1e-6 && s.t1 <= hold.t1 + 1e-6), `nut ${work[0].t0}-${work[0].t1} in hold ${hold.t0}-${hold.t1}`);
  const holder = p.builders.find((b) => b.id === unit.builder);
  const base = holder.loadout.length ? p.tools.find((t) => t.id === holder.loadout[0]).boltTime : p.timing.boltTimeHand;
  assert(near(work[0].t1 - work[0].t0, base * p.timing.soloMultiplier, 1e-6), 'slower while multitasking: ' + (work[0].t1 - work[0].t0));
});

await test('a bolt can go into a member while it is being run to its place', () => {
  const p = taskProject();
  const pl = p.plans[0];
  const receive = pl.tasks.filter((t) => t.kind === 'receive' && t.unit.type === 'member')[0];
  const bolt = pl.tasks.find((t) => t.kind === 'bolt' && t.where === 'bridge' && t.member === receive.unit.id) || pl.tasks.find((t) => t.kind === 'bolt' && t.where === 'bridge' && buildModel(p).contacts.find((c) => c.id === t.jointId && (c.a === receive.unit.id || c.b === receive.unit.id)));
  const moved = { ...bolt, builder: receive.builder, member: receive.unit.id, where: 'hand', along: true };
  pl.tasks = pl.tasks.filter((t) => t.id !== bolt.id);
  pl.tasks.splice(pl.tasks.indexOf(receive) + 1, 0, moved);
  const r = simulate(p);
  const seg = r.segments.find((s) => s.taskId === bolt.id && s.kind === 'insert');
  const times = r.taskTimes[receive.id];
  assert(seg && seg.along, 'placed at the same time');
  assert(seg.t0 < times.end && seg.t0 >= times.start, `bolt at ${seg.t0}, run ${times.start}-${times.end}`);
  assert(!r.errors.length, r.errors[0]?.msg);
});

await test('timed supports end when set, and a swap frees the first builder', () => {
  const p = taskProject();
  const pl = p.plans[0];
  // A support that's really needed (not one resting on a jack stand).
  const r00 = simulate(p);
  const needed = r00.segments.find((x) => x.kind === 'hold' && x.t1 - x.t0 > 5);
  const sup = pl.tasks.find((t) => t.id === needed.taskId);
  // Too short: the piece falls.
  const short = structuredClone(p);
  short.plans[0].tasks.find((t) => t.id === sup.id).until = 0.5;
  const rs = simulate(short);
  assert(rs.errors.some((e) => /would fall/.test(e.msg)), 'falls when let go too soon');
  const seg = rs.segments.find((s) => s.taskId === sup.id && s.kind === 'hold');
  assert(near(seg.t1 - seg.t0, 0.5, 1e-6), 'lasts as set: ' + (seg.t1 - seg.t0));
  // Swap: someone else on that side takes over; the first builder then lets go early.
  const r0 = simulate(p);
  const first = r0.segments.find((s) => s.taskId === sup.id && s.kind === 'hold');
  const other = p.builders.find((b) => b.id !== sup.builder && b.start.x < 300 === p.builders.find((x) => x.id === sup.builder).start.x < 300);
  const swap = structuredClone(p);
  const tasks = swap.plans[0].tasks;
  tasks.splice(tasks.findIndex((t) => t.id === sup.id) + 1, 0, { id: 'swap', kind: 'support', builder: other.id, member: sup.member, until: 'auto' });
  const r1 = simulate(swap);
  const before = r1.segments.find((s) => s.taskId === sup.id && s.kind === 'hold');
  const after = r1.segments.find((s) => s.taskId === 'swap' && s.kind === 'hold');
  // (No bar at all for the first builder means the other was already waiting there.)
  assert(first && after && (!before || near(before.t1, after.t0, 1e-6)), `the first builder lets go when the other takes over: ${before?.t1} vs ${after?.t0}`);
});

await test('other tasks, assembling and passing tools take their time and change bolt times', () => {
  const p = taskProject();
  const pl = p.plans[0];
  const tool = p.tools.find((t) => t.id === 't-impact-e');
  tool.pieces = [{ name: 'Body', time: 3 }, { name: 'Socket', time: 4 }];
  const east = p.builders.filter((b) => b.start.x > 300);
  const holder = east.find((b) => b.loadout.includes(tool.id));
  const other = east.find((b) => b !== holder);
  pl.tasks.unshift(
    { id: 'o1', kind: 'other', builder: other.id, text: 'Check the chalk line', duration: 9 },
    { id: 'o2', kind: 'tool', builder: holder.id, toolId: tool.id },
    { id: 'o3', kind: 'pass', builder: holder.id, toolId: tool.id, to: other.id },
  );
  const r = simulate(p);
  const o = r.segments.find((s) => s.taskId === 'o1');
  assert(o && near(o.t1 - o.t0, 9) && o.label === 'Check the chalk line', 'other task');
  const asm = r.segments.filter((s) => s.taskId === 'o2');
  assert(near(asm.reduce((a, s) => a + s.t1 - s.t0, 0), 7), 'assembly takes the pieces\' time');
  assert(r.segments.some((s) => s.taskId === 'o3' && s.kind === 'pickup'), 'tool passed');
  assert(r.taskTimes.o3.start >= r.taskTimes.o2.end - 1e-6, 'in order');
  // Across the river it can't be passed.
  const q = structuredClone(p);
  q.plans[0].tasks.find((t) => t.id === 'o3').to = p.builders.find((b) => b.start.x < 300).id;
  assert(simulate(q).errors.some((e) => /can't be passed|close enough/.test(e.msg)), 'too far to pass');
});

await test('a plan that can never finish says who is stuck on what', () => {
  const p = taskProject();
  const pl = p.plans[0];
  const run = pl.tasks.find((t) => t.kind === 'run');
  pl.tasks = [run]; // nobody receives it
  assert(simulate(p).errors.some((e) => /no step has a builder receive/.test(e.msg)), 'no receiver');
  const q = taskProject();
  const nut = q.plans[0].tasks.find((t) => t.kind === 'nut');
  q.plans[0].tasks = [nut]; // its bolt never goes in
  const r = simulate(q);
  assert(r.errors.some((e) => /stuck waiting for its bolt/.test(e.msg)), r.errors.map((e) => e.msg).join(' | '));
});

await test('staged members can sit in their side, top or front view', () => {
  const p = emptyProject();
  p.design.footingSpan = 200;
  p.design.members = [
    { ...newBox(p, 'A', 100, 50, 30), id: 'M', name: 'M', len: 40, depth: 6, thick: 3 },
    { ...newBox(p, 'A', 20, 14, 0), id: 'X', name: 'X', len: 6, depth: 4, thick: 40, off: 19 },
  ];
  const model = buildModel(p);
  const m = model.memberById.get('M'), x = model.memberById.get('X');
  const box = (q) => [Math.max(...q.map((a) => a[0])) - Math.min(...q.map((a) => a[0])), Math.max(...q.map((a) => a[1])) - Math.min(...q.map((a) => a[1]))];
  const lay = (member, view) => {
    p.site.staging[member.id] = { x: 600, y: 40, view };
    return box(stagedPoly(member, stagingSpots(p, model).get(member.id)));
  };
  // Each view lines its long side up with the yard, whatever angle it has on the bridge.
  let b = lay(m, 'side');
  assert(near(b[0], 40, 1e-6) && near(b[1], 6, 1e-6), 'side ' + b);
  b = lay(m, 'top');
  assert(near(b[0], 40, 1e-6) && near(b[1], 3, 1e-6), 'top ' + b);
  b = lay(m, 'front');
  assert(near(b[0], 6, 1e-6) && near(b[1], 3, 1e-6), 'front ' + b);
  assert(viewSizes(m, 'front').tall === 40 && viewSizes(m, 'top').tall === 6 && viewSizes(m, 'side').tall === 3, 'heights');
  // A member running across the bridge starts with its long side on the ground.
  assert(defaultView(x) === 'top' && defaultView(m) === 'side', 'default views');
  delete p.site.staging.X;
  const spots = stagingSpots(p, model);
  b = box(stagedPoly(x, spots.get('X')));
  assert(near(b[0], 40, 1e-6) && near(b[1], 6, 1e-6), 'cross member ' + b);
  b = lay(x, 'side');
  assert(near(b[0], 6, 1e-6) && near(b[1], 4, 1e-6), 'its outline when flat ' + b);
});

await test('a staged view decides whether assembly pieces touch', () => {
  const p = normalizeProject(createExampleProject());
  const plan = p.plans[0];
  const model = buildModel(p);
  const first = assemblyConnections(p, model, plan)[0];
  assert(first.joints.every((j) => j.touching), 'laid out touching');
  const id = first.joints[0].joint.a;
  // Stood on end where it lay, a long piece shrinks to its middle and stops reaching the others.
  p.site.staging[id] = { ...p.site.staging[id], view: 'front', rot: 0 };
  const after = assemblyConnections(p, buildModel(p), plan)[0];
  assert(after.joints.some((j) => !j.touching), 'no longer touching');
});

await test('old (version 1) project files still open', () => {
  const v1 = { version: 1, design: { nodes: [{ id: 'a', plane: 'A', x: 0, y: 0, z: 0, bearing: true }, { id: 'b', plane: 'A', x: 30, y: 0, z: 0 }], members: [{ id: 'm', name: 'A-1', plane: 'A', segments: [['a', 'b']] }], bolts: [{ id: 'x', memberId: 'm', seg: 0, s: 0.1 }] } };
  const p = normalizeProject(v1);
  assert(p.design.members.length === 1 && near(p.design.members[0].len, 30) && p.design.members[0].bearing);
  assert(p.design.bolts.length === 0 && !p.design.nodes);
});

const ok = results.filter((r) => r.ok).length;
document.getElementById('out').innerHTML =
  `<h2>${ok} / ${results.length} passed</h2>` +
  results.map((r) => `<div class="${r.ok ? 'ok' : 'bad'}">${r.ok ? '✔' : '✘'} ${r.name}${r.msg ? ' — ' + r.msg : ''}</div>`).join('');
window.testResults = results;
