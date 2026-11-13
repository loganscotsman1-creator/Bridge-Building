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
import { TOURS, dueTour } from '../js/ui/Tour.js';
import { feetInches, parseLength, snapZoneEdge, snapZoneMove } from '../js/model/zonesnap.js';
import { defaultOrder, orderProblems } from '../game/js/order.js';
import { clampPos, createGame, defaultSettings, holdPoints, itemBox, itemDist, readyLayout, shelfItems, shelfSlot, stepGame } from '../game/js/world.js';
import { applyAssembly, connectionChoices, dissolveAssembly, dropSlot, insertAtSlot, onStagingSide, pieceChoices, planChecks, removeTask, taskBlocks, taskGroup } from '../js/model/timeline.js';

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

await test('several pieces can rest on one footing, including long ones and ones with two feet', () => {
  const p = normalizeProject(createExampleProject());
  const box = (id, u, v, len, depth, extra = {}) => ({ id, name: id, plane: 'A', u, v, angle: 0, len, depth, thick: 4, ...extra });
  p.design.members.push(
    box('t-chord', 21, 3, 42, 6), // lying on the ground, one end over the west footing
    box('t-feet', 17, 7, 34, 14, { corners: [[0, 0], [3, 0], [3, 10], [30, 10], [30, 0], [34, 0], [34, 14], [0, 14]] }), // two feet
    box('t-high', 21, 30, 42, 6), // up off the ground
    box('t-beside', 60, 3, 42, 6), // on the ground, but not over a footing
  );
  const m = buildModel(p);
  const get = (id) => m.memberById.get(id);
  assert(get('t-chord').bearing && get('t-feet').bearing, 'both rest on the footing');
  assert(get('m-P1').bearing, 'alongside the pier');
  assert(!get('t-high').bearing && !get('t-beside').bearing, 'not on a footing');
  const x = get('t-chord').bearingPoint[0];
  assert(x >= 0 && x <= 12, 'it bears over the footing: ' + x);
  // In a plan, the pier and the chord both stand without anyone holding them.
  const pl = p.plans[0];
  pl.steps = [];
  pl.assemblies = [];
  const near = p.builders.filter((b) => onStagingSide(p.site, b));
  const far = p.builders.filter((b) => !onStagingSide(p.site, b));
  pl.tasks = [];
  for (const [i, id] of ['m-P1', 't-chord'].entries()) {
    pl.tasks.push({ id: 'r' + i, kind: 'run', builder: near[i % near.length].id, unit: { type: 'member', id } });
    pl.tasks.push({ id: 'c' + i, kind: 'receive', builder: far[i % far.length].id, unit: { type: 'member', id } });
  }
  const r = simulate(p);
  assert(!r.falls.length, 'nothing falls: ' + r.errors.map((e) => e.msg).join(' | '));
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

await test('stability: a piece on a footing stands by itself until something hangs out past it', () => {
  const nodePos = new Map([['f', { x: 0, y: 0, z: 0 }], ['j', { x: 3, y: 0, z: 10 }], ['k', { x: 40, y: 0, z: 10 }], ['g', { x: 240, y: 0, z: 0 }]]);
  const pier = (bolts = 0) => ({ key: 'P', nodeIds: ['f', 'j'], attached: bolts ? { j: bolts } : {}, footed: true });
  const over = (bolts = 1) => ({ key: 'V', nodeIds: ['j'], attached: { j: bolts }, overFooting: true });
  const hang = (bolts = 1) => ({ key: 'X', nodeIds: ['j', 'k'], attached: { j: bolts }, overFooting: false });
  const run = (units, held) => computeStability({ units, supportNodes: new Set(['f', 'g']), nodePos, rigidBoltCount: 2, held }).stable;
  assert(run([pier()]).has('P'), 'alone on its footing');
  let s = run([pier(1), over(1)]);
  assert(s.has('P') && s.has('V'), 'with a piece that stays over the footing');
  // Placed but not bolted yet: the hanging piece needs holding, the pier doesn't.
  s = run([pier(), { ...hang(), attached: {} }]);
  assert(s.has('P') && !s.has('X'), 'not attached yet');
  for (const bolts of [1, 2]) {
    s = run([pier(bolts), hang(bolts)]);
    assert(!s.has('P') && !s.has('X'), bolts + ' bolts: hanging past the footing, it all needs support');
    s = run([pier(bolts), hang(bolts)], new Set(['X']));
    assert(s.has('P') && s.has('X'), bolts + ' bolts: holding the hanging piece holds it up');
  }
  // A braced cantilever off a footing still counts as hanging out.
  const brace = { key: 'Y', nodeIds: ['j', 'k'], attached: { j: 1, k: 1 }, overFooting: false };
  s = run([pier(1), { ...hang(1), attached: { j: 1, k: 1 } }, brace]);
  assert(!s.has('X') && !s.has('Y'), 'braced, but only one footing');
  // Reaching the other footing, the usual rules hold it up.
  const span = { key: 'S', nodeIds: ['f', 'g'], attached: {}, footed: true, overFooting: false };
  assert(run([span]).has('S'), 'footing to footing');
});

const sideOfX = (m) => Math.max(...m.corners3.map((c) => c[0]));
await test('a plan: pieces on a footing need no support, the next piece out does', () => {
  const p = taskProject();
  const pl = p.plans[0];
  pl.assemblies = [];
  const model = buildModel(p);
  const near = p.builders.find((b) => onStagingSide(p.site, b));
  const pier = model.members.filter((m) => m.bearing).sort((a, b) => (sideOfX(b) - sideOfX(a)))[0]; // (on the builder's side of the river)
  const c = model.contacts.find((x) => x.bolts > 0 && (x.a === pier.id || x.b === pier.id) && !model.memberById.get(x.a === pier.id ? x.b : x.a).bearing);
  const out = c.a === pier.id ? c.b : c.a;
  const place = (id, member) => ({ id, kind: 'receive', builder: near.id, unit: { type: 'member', id: member } });
  pl.tasks = [place('p', pier.id)];
  let r = simulate(p);
  assert(!r.falls.length, 'the pier stands: ' + r.errors.map((e) => e.msg).join(' | '));
  assert(!r.errors.some((e) => e.msg.includes(pier.name + ' ')), r.errors.map((e) => e.msg).join(' | '));
  pl.tasks.push(place('o', out));
  r = simulate(p);
  assert(r.falls.some((f) => f.unitKey === 'm:' + out), 'the piece hanging out would fall');
  assert(!r.falls.some((f) => f.unitKey === 'm:' + pier.id), 'not bolted yet, so the pier still stands');
  pl.tasks.push(
    { id: 'b', kind: 'bolt', builder: near.id, member: out, jointId: c.id, boltIds: [...c.boltIds], where: 'bridge' },
    { id: 'n', kind: 'nut', builder: near.id, member: out, jointId: c.id, boltIds: [...c.boltIds], where: 'bridge' },
  );
  r = simulate(p);
  assert(r.falls.some((f) => f.unitKey === 'm:' + pier.id), 'once bolted, the piece hanging out takes the pier with it');
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

await test('a plan with no steps is empty, not rebuilt from old steps', () => {
  const p = taskProject();
  const pl = p.plans[0];
  pl.tasks = [];
  pl.assemblies = [];
  const r = simulate(p);
  assert(!r.segments.some((s) => s.kind === 'carry'), 'nothing is carried');
  const c = planChecks(p, buildModel(p), pl, r);
  assert(c.pieces.done === 0 && c.pieces.total === buildModel(p).members.length, JSON.stringify(c.pieces));
  assert(c.bolts.done === 0 && c.nuts.done === 0 && c.bolts.total === c.nuts.total && c.bolts.total > 0);
  assert(c.todo.some((x) => x.kind === 'receive') && c.todo.some((x) => x.kind === 'bolt') && c.todo.some((x) => x.kind === 'nut'));
});

await test('the timeline: a drop lands before the bar it is over, after the last, or alongside one', () => {
  const t = (id, along) => ({ id, kind: 'other', builder: 'b', duration: 10, ...(along ? { along: true } : {}) });
  const plan = { tasks: [t('a'), t('b'), t('c')], assemblies: [] };
  const sim = { taskTimes: { a: { start: 0, end: 10 }, b: { start: 10, end: 20 }, c: { start: 20, end: 30 } }, segments: [] };
  const blocks = taskBlocks(plan, sim);
  assert(dropSlot(blocks, 'b', 2).before === 'a');
  assert(dropSlot(blocks, 'b', 16).before === 'c');
  const end = dropSlot(blocks, 'b', 99);
  assert(end.before === null && !end.along);
  const on = dropSlot(blocks, 'b', 12, true);
  assert(on.along && on.with === 'b', JSON.stringify(on));
  // Off the end of the row, the lower half is just the next step.
  assert(!dropSlot(blocks, 'b', 99, true).along);
  const tasks = plan.tasks.map((x) => ({ ...x }));
  insertAtSlot(tasks, [t('n')], on);
  assert(tasks.map((x) => x.id).join() === 'a,b,n,c', tasks.map((x) => x.id).join());
  assert(tasks[2].along);
  // Moving a bar brings what's done at the same time with it.
  insertAtSlot(tasks, taskGroup(tasks, 'b'), { builder: 'other', time: 0, before: null });
  assert(tasks.map((x) => x.id).join() === 'b,n,a,c', tasks.map((x) => x.id).join());
  assert(tasks.find((x) => x.id === 'n').builder === 'other' && tasks.find((x) => x.id === 'n').along);
});

await test('making an assembly on the timeline bolts it together before it can be carried', () => {
  const p = taskProject();
  const pl = p.plans[0];
  const model = buildModel(p);
  const a = pl.assemblies[0];
  const inner = model.contacts.filter((c) => c.bolts > 0 && a.memberIds.includes(c.a) && a.memberIds.includes(c.b));
  const innerBolts = new Set(inner.flatMap((c) => c.boltIds));
  const byHand = pl.tasks.filter((t) => (t.kind === 'bolt' || t.kind === 'nut') && t.where === 'staging' && t.boltIds.some((id) => innerBolts.has(id)));
  const maker = byHand[0].builder;
  const first = pl.tasks.indexOf(byHand[0]);
  pl.tasks = pl.tasks.filter((t) => !byHand.includes(t));
  pl.tasks.splice(first, 0, { id: 'mk', kind: 'assembly', builder: maker, assemblyId: a.id });
  const r = simulate(p);
  assert(!r.aborted && !r.errors.length, r.errors.map((e) => e.msg).slice(0, 2).join(' | '));
  assert(r.taskTimes.mk.end > r.taskTimes.mk.start, 'it takes time');
  const run = pl.tasks.find((t) => t.unit?.type === 'assembly' && t.unit.id === a.id);
  assert(r.taskTimes[run.id].end >= r.taskTimes.mk.end, 'carried only once it is made');
  assert(r.segments.some((s) => s.taskId === 'mk' && s.kind === 'assemble'));
  const c = planChecks(p, model, pl, r);
  assert(c.bolts.done === c.bolts.total && c.nuts.done === c.nuts.total, 'its bolts count as planned');

  // Without the step, nothing makes it: the carrying step is reported as stuck.
  pl.tasks = pl.tasks.filter((t) => t.id !== 'mk');
  const stuck = simulate(p);
  assert(stuck.aborted && stuck.stuckTasks[run.id], JSON.stringify(stuck.stuckTasks));
  assert(taskBlocks(pl, stuck, p).get(run.builder).some((b) => b.ghost && b.task.id === run.id), 'drawn as a ghost');
  assert(planChecks(p, model, pl, stuck).todo.some((x) => x.kind === 'assembly' && x.preset.assemblyId === a.id), 'listed as still to do');
});

await test('an assembly made from pieces already on the timeline takes over their steps', () => {
  const p = taskProject();
  const pl = p.plans[0];
  pl.assemblies = [];
  const model = buildModel(p);
  const c = model.contacts.find((x) => x.bolts > 0);
  const [x, y] = [c.a, c.b];
  pl.tasks = [
    { id: 'r1', kind: 'run', builder: p.builders[2].id, unit: { type: 'member', id: x } },
    { id: 'r2', kind: 'run', builder: p.builders[3].id, unit: { type: 'member', id: y } },
    { id: 'n1', kind: 'nut', builder: p.builders[3].id, jointId: c.id, boltIds: [...c.boltIds], where: 'bridge', member: x },
  ];
  const made = applyAssembly(pl, model, [x, y], { name: 'Pair' });
  assert(pl.assemblies.length === 1 && made.name === 'Pair');
  assert(pl.tasks.filter((t) => t.kind === 'run').length === 1, 'one run for the pair');
  assert(pl.tasks.find((t) => t.id === 'r1').unit.id === made.id);
  assert(pl.tasks.find((t) => t.id === 'n1').where === 'staging', 'its bolts are done in the yard');
  pl.tasks.push({ id: 'mk', kind: 'assembly', builder: p.builders[2].id, assemblyId: made.id });
  removeTask(pl, model, 'mk');
  assert(!pl.assemblies.length && !pl.tasks.some((t) => t.unit?.type === 'assembly'), 'taking the step off undoes the assembly');
  assert(pl.tasks.find((t) => t.id === 'n1').where === 'bridge');
});

await test('pop-ups offer what a builder can get at by then', () => {
  const p = taskProject();
  const pl = p.plans[0];
  pl.assemblies = [];
  const model = buildModel(p);
  const near = p.builders.find((b) => onStagingSide(p.site, b));
  const far = p.builders.find((b) => !onStagingSide(p.site, b));
  assert(near && far, 'both sides of the river');
  const [m1, m2] = [model.contacts.find((c) => c.bolts > 0).a, model.contacts.find((c) => c.bolts > 0).b];
  pl.tasks = [];
  let r = simulate(p);
  assert(pieceChoices(p, model, pl, r, 'run', near.id, 0).get(m1).status === 'ready');
  assert(pieceChoices(p, model, pl, r, 'receive', near.id, 0).get(m1).status === 'ready', 'nearby: from the yard');
  assert(pieceChoices(p, model, pl, r, 'receive', far.id, 0).get(m1).status === 'later', 'across the river: nobody brings it');
  assert(pieceChoices(p, model, pl, r, 'support', far.id, 0).get(m1).status === 'no', 'not on the bridge');
  pl.tasks = [
    { id: 'a', kind: 'run', builder: near.id, unit: { type: 'member', id: m1 } },
    { id: 'b', kind: 'receive', builder: far.id, unit: { type: 'member', id: m1 } },
  ];
  r = simulate(p);
  assert(pieceChoices(p, model, pl, r, 'receive', far.id, 0).get(m1).status === 'no', 'already placed');
  assert(pieceChoices(p, model, pl, r, 'run', near.id, 0).get(m1).status === 'no', 'already run');
  assert(pieceChoices(p, model, pl, r, 'support', far.id, 9999).get(m1).status === 'ready', 'on the bridge by then');
  const row = (kind, t) => connectionChoices(model, pl, r, kind, t).find((x) => (x.joint.a === m1 && x.joint.b === m2));
  assert(row('bolt', 9999).status === 'ready', 'a bolt can go in once one piece is there');
  assert(row('nut', 9999).status === 'later', 'a nut needs its bolt first');
  pl.tasks.push({ id: 'c', kind: 'bolt', builder: far.id, member: m1, jointId: row('bolt', 0).joint.id, boltIds: [...row('bolt', 0).joint.boltIds], where: 'bridge' });
  r = simulate(p);
  assert(row('bolt', 9999).status === 'no', 'every bolt has a step');
  assert(row('nut', 9999).left.length === row('nut', 9999).joint.bolts);
  assert(planChecks(p, model, pl, r).marks.get('c')?.some((x) => x.icon === '🔧'), 'the bolt is marked until its nut has a step');
});

await test('a piece nobody supports is reported where it falls', () => {
  const p = taskProject();
  const pl = p.plans[0];
  pl.assemblies = [];
  const model = buildModel(p);
  const m = model.members.find((x) => !x.bearing && model.contacts.some((c) => c.a === x.id || c.b === x.id));
  const near = p.builders.find((b) => onStagingSide(p.site, b));
  pl.tasks = [{ id: 'a', kind: 'receive', builder: near.id, unit: { type: 'member', id: m.id } }];
  const r = simulate(p);
  if (!r.falls.length) return; // (if this piece happened to rest on a footing)
  const c = planChecks(p, model, pl, r);
  assert(c.falls === 1 && c.todo[0].kind === 'support' && c.todo[0].preset.member === m.id, JSON.stringify(c.todo[0]));
  assert(c.marks.get('a').some((x) => x.bad), 'marked on the bar');
});

await test('the tutorial: the intro first, each tab once, and again only when it changes', () => {
  assert(dueTour('design', {}) === 'intro', 'intro first, whichever tab is open');
  const seen = { intro: TOURS.intro.v };
  assert(dueTour('design', seen) === 'design');
  seen.design = TOURS.design.v;
  assert(dueTour('design', seen) === null, 'not twice');
  assert(dueTour('crew', seen) === 'crew', 'another tab still has its tips');
  seen.design = TOURS.design.v - 1;
  assert(dueTour('design', seen) === 'design', 'shown again after an update');
  for (const [id, t] of Object.entries(TOURS)) assert(t.steps.length >= 1 && t.steps.length <= 3, id + ' stays brief');
});

await test('site zones snap to the site edges and to each other, and lengths can be typed in feet', () => {
  const site = { width: 720, depth: 180, zones: [
    { id: 'a', x: 0, y: 0, w: 60, h: 180 },
    { id: 'b', x: 100, y: 20, w: 50, h: 40 },
  ] };
  const b = site.zones[1];
  let m = snapZoneMove(site, b, 64, 3, 6);
  assert(m.x === 60 && m.y === 0, 'west edge onto zone a, north edge onto the site: ' + JSON.stringify(m));
  assert(m.guides.length === 2, 'both lines shown');
  m = snapZoneMove(site, b, 667, 137, 6);
  assert(m.x === 670 && m.y === 140, 'east edge onto the site east edge, south edge onto the site south edge: ' + JSON.stringify(m));
  m = snapZoneMove(site, b, 300, 70, 6);
  assert(m.x === 300 && m.y === 70 && !m.guides.length, 'nothing near: stays put');
  assert(snapZoneMove(site, b, 64, 3, 0).x === 64, 'no snapping with no tolerance (Alt held)');
  assert(snapZoneEdge(site, b, 'x', 716, 6).at === 720 && snapZoneEdge(site, b, 'y', 176, 6).at === 180, 'resized edges snap to the site');
  assert(snapZoneEdge(site, b, 'x', 57, 6).at === 60, 'and to other zones');
  assert(parseLength('150') === 150 && parseLength('150 in') === 150 && parseLength('150"') === 150, 'inches');
  assert(parseLength("12'") === 144 && parseLength("12' 6\"") === 150 && parseLength('12 ft 6 in') === 150 && parseLength('2.5ft') === 30, 'feet and inches');
  assert(parseLength('abc') === null && parseLength('') === null, 'not a length');
  assert(feetInches(150) === "12' 6\"" && feetInches(144) === "12'" && feetInches(8) === '8"', feetInches(150) + ' ' + feetInches(144) + ' ' + feetInches(8));
});

// ---------- Over Engineered (the game) ----------
function game({ players = [['p1', 'west'], ['p2', 'east']], npcs = {}, edit } = {}) {
  const project = normalizeProject(createExampleProject());
  const order = defaultOrder(project);
  if (edit) edit(order);
  const settings = { ...defaultSettings(project, 2), fallPenalty: 30 };
  const S = createGame({ project, order, settings, players: players.map(([id, side]) => ({ id, name: id, color: '#000', side })), npcs });
  const input = new Map(players.map(([id]) => [id, { mx: 0, my: 0 }]));
  const tick = (secs = 1 / 60) => { for (let i = 0; i < Math.round(secs * 60); i++) stepGame(S, input, 1 / 60); };
  const actor = (id) => S.actors.find((a) => a.id === id);
  const press = (id, btn) => { input.get(id)[btn] = true; tick(); input.get(id)[btn] = false; tick(); };
  const hold = (id, btn, on) => { input.get(id)[btn] = on; };
  const put = (id, x, y) => { const a = actor(id); const p = clampPos(S, a.side, x, y); a.x = p.x; a.y = p.y; };
  // Hand an item to a builder and place it from the nearest spot on their side.
  const place = (id, item) => {
    const a = actor(id);
    const pts = item.memberIds.flatMap((m) => S.members.get(m).poly);
    put(id, pts.reduce((s, q) => s + q[0], 0) / pts.length, pts.reduce((s, q) => s + q[1], 0) / pts.length - 25);
    if (itemDist(S, item, a.x, a.y) > S.settings.reach) put(id, pts.reduce((s, q) => s + q[0], 0) / pts.length, pts.reduce((s, q) => s + q[1], 0) / pts.length);
    a.carrying = item.id;
    item.status = 'carried';
    press(id, 'a');
  };
  // Put in every needed bolt a builder on this side can reach.
  const boltAll = (id, state = 'needed', btn = 'a') => {
    for (const b of S.bolts) {
      if (b.state !== state) continue;
      const a = actor(id);
      if (!a.anchor) put(id, b.x, b.y - 10);
      if (Math.hypot(a.x - b.x, a.y - b.y) > S.settings.reach) continue;
      if (btn === 'a') for (let i = 0; i < 6 && b.state === 'needed'; i++) press(id, 'a');
      else { hold(id, 'x', true); for (let i = 0; i < 400 && b.state === 'placed'; i++) tick(); hold(id, 'x', false); tick(); }
    }
  };
  return { S, project, order, input, tick, actor, press, hold, put, place, boltAll };
}

await test('game: the default order starts with a three-piece assembly, and must', () => {
  const { S, project } = game();
  assert(S.items[0].memberIds.length === 3, S.items[0].memberIds.join());
  const model = buildModel(project);
  assert(!orderProblems(defaultOrder(project, model), model).length, JSON.stringify(orderProblems(defaultOrder(project, model), model)));
  const bad = defaultOrder(project, model).slice(2);
  assert(orderProblems(bad, model).some((p) => p.msg.includes('three pieces')), 'a single first piece is flagged');
  assert(orderProblems(bad, model).some((p) => p.msg.includes('not in the order')), 'missing pieces are flagged');
});

await test('game: assemblies come out when made, single pieces once every assembly before them is', () => {
  const { S, hold, put, tick } = game();
  assert(!shelfItems(S).length, 'nothing ready at the start: the first item is an assembly');
  const b = S.assembly;
  put('p2', b.x + b.w / 2, b.y + b.h / 2);
  hold('p2', 'x', true);
  tick(S.items[0].time + 0.2);
  assert(S.items[0].status === 'shelf', 'first assembly made: ' + S.items[0].status);
  assert(S.items[1].status === 'building', 'still holding X: on to the next one');
  assert(S.items[2].status === 'waiting', 'a single piece after an unmade assembly waits');
  tick(S.items[1].time + 0.2);
  hold('p2', 'x', false); tick();
  assert(S.items[1].status === 'shelf' && S.items[2].status === 'shelf' && S.items[3].status === 'shelf', S.items.slice(0, 4).map((i) => i.status).join());
  assert(S.actors.find((a) => a.id === 'p2').stats.assemblies === 2);
});

await test('game: staging is split north and south, and ready items stand at full size inside the ready area', () => {
  const { S } = game();
  assert(S.ready.x === S.assembly.x && S.ready.w === S.assembly.w && S.ready.y + S.ready.h === S.assembly.y, 'north/south halves: ' + JSON.stringify([S.ready, S.assembly]));
  for (const it of S.items.slice(0, 8)) it.status = 'shelf';
  const lay = readyLayout(S);
  assert(lay.size === 8, 'every ready item has a place');
  for (const [it, sl] of lay) {
    const b = itemBox(S, it);
    const x0 = b.x0 + sl.dx, x1 = b.x1 + sl.dx, y1 = b.y1 + sl.dy;
    assert(x0 >= S.ready.x - 0.01 && x1 <= S.ready.x + S.ready.w + 0.01, `#${it.idx + 1} fits across: ${x0.toFixed(1)}..${x1.toFixed(1)}`);
    assert(y1 <= S.ready.y + S.ready.h + 0.01 && b.y0 + sl.dy >= S.ready.y - 0.01, `#${it.idx + 1} fits from north to south`);
    assert(Math.abs(b.x1 - b.x0 - (x1 - x0)) < 1e-9 && Math.abs(b.z0 + sl.dz) < 1e-9, 'full size, standing on the ground');
  }
  assert(S.settings.walkSpeed > 54 && S.items[0].time < 20, 'quicker than real life by default: ' + S.items[0].time);
});

await test('game: several builders work in the one assembly area, apart or together', () => {
  const { S, hold, put, tick, actor } = game({ players: [['p1', 'east'], ['p2', 'east'], ['p3', 'east']] });
  const z = S.assembly;
  put('p1', z.x + 20, z.y + 20); put('p2', z.x + 110, z.y + 70);
  hold('p1', 'x', true); hold('p2', 'x', true); tick(0.5);
  assert(S.items[0].status === 'building' && S.items[1].status === 'building', 'two builders, two assemblies at once');
  hold('p1', 'x', false); hold('p2', 'x', false); tick();
  hold('p1', 'x', true); tick(0.1);
  assert(actor('p1').work.target === S.items[0], 'resumes the earliest half-made assembly');
  hold('p2', 'x', true); tick(0.1);
  assert(actor('p2').work.target === S.items[1], 'the other picks up the other one');
  hold('p2', 'x', false); tick();
  put('p3', z.x + 60, z.y + 45); hold('p3', 'x', true); tick(0.1);
  assert(actor('p3').work.target === S.items[1], 'a third builder takes the unattended one');
  hold('p3', 'x', false); tick();
  // Nothing else to make: help.
  for (const it of S.items) if (it.multi && it.status === 'waiting') it.status = 'shelf';
  S.items[1].status = 'shelf';
  const left = S.items[0].time - S.items[0].progress;
  put('p2', z.x + 30, z.y + 50); hold('p2', 'x', true); tick(0.1);
  assert(actor('p2').work.target === S.items[0], 'nothing else to make: helps with #1');
  tick(left / 2 + 0.2);
  assert(S.items[0].status === 'shelf', 'two builders on one assembly make it about twice as fast');
});

await test('game: pieces are passed across the river by holding A', () => {
  const { S, press, hold, put, tick, actor } = game();
  S.items[0].status = 'shelf';
  S.items[1].status = 'shelf';
  const far = shelfSlot(S, S.items[1]);
  put('p2', far.x, far.y);
  press('p2', 'a');
  assert(actor('p2').carrying === S.items[0].id, 'grabbed the next item in the order, wherever they stood in the ready area');
  assert(!S.obstacles.length, 'the ready and assembly areas are open ground');
  put('p2', S.river.x + S.river.w, 90);
  put('p1', S.river.x, 90);
  hold('p2', 'a', true); tick(0.2);
  assert(actor('p2').extending, 'holding A while carrying away from its spot: passing');
  press('p1', 'a');
  assert(actor('p1').carrying === S.items[0].id && !actor('p2').carrying, 'taken across the river');
});

await test('game: the bridge falls if nobody holds it, or the holder lets go', () => {
  const { S, place, hold, tick, press, actor, put } = game({ players: [['p1', 'west'], ['p2', 'west'], ['p3', 'east']] });
  place('p1', S.items[0]);
  assert(S.items[0].status === 'placed', 'placed on its footing');
  assert(S.support.needed, 'the first assembly hangs past the footing, so it needs holding');
  tick(S.settings.grace + 0.1);
  assert(S.falls.length === 1 && S.penalties === 30 && S.support.fallen, 'nobody took hold in time');
  const pt = holdPoints(S)[0];
  assert(pt.key === 'start', 'before any lateral, hold the first assembly');
  put('p2', pt.x, pt.y);
  hold('p2', 'lb', true); tick();
  assert(S.support.holders.has('p2') && !S.support.fallen, 'held again');
  tick(5);
  assert(S.falls.length === 1, 'holding: no more falls');
  hold('p2', 'lb', false); tick();
  assert(S.falls.length === 2, 'let go with nobody else holding');
  hold('p2', 'lb', true); tick();
  put('p1', pt.x + 10, pt.y);
  hold('p1', 'lb', true); tick();
  hold('p2', 'lb', false); tick();
  assert(S.falls.length === 2, 'someone else was holding');
});

await test('game: one place touching needs one bolt, two or more places need two', () => {
  const { S, place, hold, tick, put, press, actor } = game({ players: [['p1', 'west'], ['p2', 'west'], ['p3', 'east']] });
  place('p1', S.items[0]);
  const pt = holdPoints(S)[0];
  put('p2', pt.x, pt.y); hold('p2', 'lb', true); tick();
  place('p1', S.items[1]);
  assert(!S.items[1].loose && !actor('p1').anchor, 'the other end assembly stands on its footing: nothing to hold');
  const lat = S.items[2];
  assert(lat.memberIds.every((id) => S.members.get(id).m.plane === 'L'), 'the third item is a lateral');
  place('p1', lat);
  assert(lat.loose && lat.loose.need === 2, 'touching both trusses: two bolts: ' + JSON.stringify(lat.loose));
  assert(S.bolts.filter((b) => b.state === 'placed').length === 1, 'placing it put in one bolt');
  assert(actor('p1').anchor?.kind === 'piece', 'whoever placed it holds it');
  // Shuffle along it to the far truss (but not away from it), then bolt.
  const far = S.bolts.find((b) => b.state === 'needed' && lat.loose.contacts.some((j) => b.jointIds.includes(j)));
  hold('p1', 'my', 1); tick(3); hold('p1', 'my', 0);
  assert(itemDist(S, lat, actor('p1').x, actor('p1').y) <= S.settings.reach + 1e-6, 'stays within reach of the piece');
  assert(Math.hypot(actor('p1').x - far.x, actor('p1').y - far.y) <= S.settings.reach, 'reached the far bolt');
  press('p1', 'a');
  assert(!lat.loose && !actor('p1').anchor, 'second bolt: it stands, and they let go');
  assert(S.support.holders.get('p2').key === lat.memberIds[0], 'the holder moved to the first lateral');
  // A vertical touching one chord at one place.
  const v = S.items.find((it) => it.memberIds.length === 1 && S.members.get(it.memberIds[0]).m.name === 'A-V1');
  const c = buildModel(S.project).contacts.filter((x) => x.bolts && (x.a === v.memberIds[0] || x.b === v.memberIds[0]) && S.installed.has(x.a === v.memberIds[0] ? x.b : x.a));
  place('p1', v);
  assert(v.loose === null || (c.length >= 2 ? v.loose.need === 2 : !v.loose), JSON.stringify(v.loose) + ' / ' + c.length);
});

await test('game: a buddy piece is held by whoever placed it and bolted by someone else', () => {
  const { S, place, hold, tick, put, press, actor } = game({ players: [['p1', 'west'], ['p2', 'west'], ['p3', 'west']], edit: (o) => { o[2].buddy = true; } });
  place('p1', S.items[0]);
  const pt = holdPoints(S)[0];
  put('p2', pt.x, pt.y); hold('p2', 'lb', true); tick();
  place('p1', S.items[1]);
  place('p1', S.items[2]);
  const lat = S.items[2];
  assert(lat.loose && S.bolts.filter((b) => b.state === 'placed').length === 0, 'set in place, no bolt');
  assert(actor('p1').anchor?.locked, 'its carrier can only hold it');
  press('p1', 'a');
  assert(S.bolts.filter((b) => b.state === 'placed').length === 0, 'and cannot bolt it');
  for (const b of S.bolts.filter((x) => x.state === 'needed')) { put('p3', b.x, b.y - 10); press('p3', 'a'); }
  assert(!lat.loose && !actor('p1').anchor, 'a buddy bolted it, so the carrier is free');
});

await test('game: if the bridge grows twice and nobody moves out to hold it, it falls', () => {
  const { S, place, hold, tick, put, press, actor } = game({ players: [['p1', 'west'], ['p2', 'west'], ['p3', 'west']] });
  place('p1', S.items[0]);
  const pt = holdPoints(S)[0];
  put('p2', pt.x, pt.y); hold('p2', 'lb', true); tick();
  place('p1', S.items[1]); // both trusses now reach the same length: grown once
  assert(S.support.grown === 1 && S.support.holders.get('p2').stale === 1, JSON.stringify({ g: S.support.grown, h: [...S.support.holders.values()] }));
  const name = (n) => S.items.find((it) => it.memberIds.length === 1 && S.members.get(it.memberIds[0]).m.name === n);
  for (const n of ['A-V1', 'A-BC2']) { place('p1', name(n)); for (let i = 0; i < 3 && name(n).loose; i++) press('p1', 'a'); }
  assert(S.support.grown === 1, 'one truss longer than the other: not grown yet');
  place('p1', name('B-BC2'));
  assert(S.support.grown === 2, 'grown twice');
  assert(S.falls.length === 1 && /nobody moved out/.test(S.falls[0].why), JSON.stringify(S.falls));
});

await test('game: NPCs make assemblies at their set time and hold the bridge until it stands', () => {
  const { S, tick } = game({ players: [['p1', 'west']], npcs: { assembler: true } });
  const t0 = S.items[0].time;
  tick(t0 + 6); // time to walk to the bench first
  assert(S.items[0].status === 'shelf', 'assembler made the first one: ' + S.items[0].status + ' ' + S.items[0].progress);

  const g = game({ players: [['p1', 'west'], ['p2', 'east']], npcs: { holder: true } });
  const holder = g.actor('npc-holder');
  assert(holder.side === 'west', 'holds from the first assembly\'s side');
  g.place('p1', g.S.items[0]);
  g.tick(2.5);
  assert(g.S.support.holders.has('npc-holder') && !g.S.falls.length, 'took hold in time');
  // Build the whole bridge (teleporting whoever is on the right side), bolting as we go.
  for (const it of g.S.items.slice(1)) {
    const ms = it.memberIds.map((id) => g.S.members.get(id));
    const x = ms.reduce((s, m) => s + m.poly[0][0], 0) / ms.length;
    const who = g.S.sideOfX(x) === 'west' ? 'p1' : 'p2';
    // (This order lets the bridge fall now and then; the holder takes hold again.)
    for (let i = 0; i < 20 && g.S.support.fallen; i++) g.tick(0.5);
    g.place(who, it);
    assert(it.status === 'placed', it.idx + ' not placed');
    // Walk along it to each bolt it still needs.
    for (const b of g.S.bolts) {
      if (!it.loose || b.state !== 'needed' || !it.loose.contacts.some((j) => b.jointIds.includes(j))) continue;
      for (let i = 0; i < 20 && g.S.support.fallen; i++) g.tick(0.5);
      g.put(who, b.x, b.y);
      for (let i = 0; i < 6 && b.state === 'needed'; i++) g.press(who, 'a'); // (the nearest bolt goes in first)
    }
    assert(!it.loose, it.idx + ' still loose');
    g.tick(1.5);
  }
  assert(g.S.items.every((it) => it.status === 'placed'), 'all placed');
  for (let i = 0; i < 20 && g.S.support.fallen; i++) g.tick(0.5);
  for (const id of ['p1', 'p2']) g.boltAll(id);
  assert(g.S.support.standing, 'reaches both footings with the trusses tied: stands on its own');
  assert(!g.S.support.holders.size && !holder.anchor, 'the holder lets go');
  for (const id of ['p1', 'p2']) g.boltAll(id, 'placed', 'x');
  assert(g.S.bolts.every((b) => b.state === 'fastened' || b.state === 'internal'), g.S.bolts.filter((b) => b.state !== 'fastened' && b.state !== 'internal').length + ' bolts left');
  assert(g.S.allBuilt && !g.S.done, 'built, but not everyone is back in a staging yard');
  for (const id of ['p1', 'p2']) { const a = g.actor(id); const z = g.S.stageZones.find((q) => g.S.sideOfX(q.x + q.w / 2) === a.side); g.put(id, z.x + 20, z.y + 20); }
  g.tick(30);
  assert(g.S.done, 'everyone back: done (the holder walks back too)');
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
