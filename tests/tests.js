// Browser test runner: open tests/index.html (through a local server) and read the results.
import { buildModel, calibFromPoints, contact2d, boxCorners, footingPoints, imageToView, isConvex, polyFits, rectOfPoly, viewToImage } from '../js/model/geometry.js';
import { computeStability } from '../js/sim/stability.js';
import { SiteGrid } from '../js/sim/grid.js';
import { simulate } from '../js/sim/simulate.js';
import { createExampleProject } from '../js/model/example.js';
import { emptyProject, normalizeProject } from '../js/model/schema.js';
import { site2027, RULES_2027 } from '../js/model/rules2027.js';
import { autoBolts, newBox, removeMember } from '../js/model/edit.js';
import { snapBox, snapPoint, snapSize } from '../js/ui/snap.js';
import { membersArea, stagingSpots } from '../js/model/plan.js';

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
