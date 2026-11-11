// Over Engineered: the game's rules, kept apart from drawing and input so they can be tested.
//
// The site is the year's layout (inches, x west → east, y north → south). The staging yard with
// the members is split in half: an assembly area anyone can work in, and a ready area on the half
// facing the bridge where finished items wait. Builders can't cross the river or leave the site.
//
// Rules, in short:
//   - Items (assemblies and single pieces) appear in the ready area in the build order: an
//     assembly once it's made, a single piece as soon as every assembly before it is. Grabbing
//     from anywhere in or near the ready area always takes the next item in the order.
//   - A piece is placed where it goes in the bridge (tap A within reach). It needs one bolt if it
//     touches the bridge at one place, two bolts at two different places if it touches at two or
//     more. Placing it puts in the first bolt. Until it has its bolts, whoever placed it holds it.
//     A "buddy" piece can only be held by the one who placed it; someone else bolts it.
//   - Until the bridge reaches both footings with the trusses tied together, it must be held up
//     (hold LB) once anything hangs past a footing. Holders hold at a lateral (or, before the
//     first lateral, at the outer end of the first assembly). Letting go with nobody else holding,
//     nobody taking hold in time, or every holder staying put while the bridge grows longer twice
//     drops the bridge: a time penalty, and someone has to hold it again before work goes on.
//   - Done when every piece is in, every nut is fastened and everyone is back in a staging yard.
import { buildModel, bridgeToSite, distToSegment2, footingRanges, pointInPoly } from '../../js/model/geometry.js';
import { membersArea } from '../../js/model/plan.js';
import { assemblyTime, isAssembly, startFooting } from './order.js';

export const R = 8; // builder radius (in)
const HOLD_SNAP = 80; // how far away a builder can be to take hold of the bridge
const STATION_REACH = 12; // how close to the assembly or ready area counts as in it
const ANCHOR_BRIDGE = 16; // how far a holder can lean while holding the bridge
const ANCHOR_PIECE = 12;
const SNAP_PUSH = 0.6; // stick push (0..1) that moves a holder to the next lateral...
const SNAP_TIME = 0.4; // ...when held this long (s)
const GROW_MIN = 4; // the bridge has grown when it reaches at least this much farther (in)

export const ACTIVITIES = ['fasten', 'assemble', 'hold', 'brace', 'pass', 'carry', 'walk', 'idle'];
export const ACTIVITY_NAMES = { fasten: 'Fastening', assemble: 'Assembling', hold: 'Holding the bridge', brace: 'Holding a piece', pass: 'Passing', carry: 'Carrying', walk: 'Walking', idle: 'Waiting' };

export function defaultSettings(project, fastenTime) {
  const tm = project.timing;
  return {
    fastenTime, // s to fasten one nut (hold X)
    fallPenalty: 30, // s added when the bridge falls
    grace: 3, // s to take hold once the bridge needs holding
    neglect: 6, // s before an unfastened bolt starts flashing
    walkSpeed: tm.walkSpeed || 54,
    carrySpeed: tm.carrySpeed || 36,
    reach: tm.maxReach || 40,
    passReach: tm.passReach || 90,
  };
}

/**
 * @param {object} args
 * @param {object} args.project a normalized sequencer project
 * @param {{id, memberIds, buddy, time}[]} args.order
 * @param {object} args.settings see defaultSettings
 * @param {{id, name, color, side: 'west'|'east'}[]} args.players
 * @param {{holder?: boolean, assembler?: boolean}} [args.npcs]
 */
export function createGame({ project, order, settings, players, npcs = {} }) {
  const model = buildModel(project);
  const site = project.site;
  const F = footingRanges(project);
  const toSite = (x, y) => { const p = bridgeToSite(site, x, y); return [p.x, p.y]; };

  // The river splits the site into two sides.
  const river = site.zones.filter((z) => z.type === 'nogo').sort((a, b) => b.h - a.h)[0] || null;
  const sides = river
    ? { west: [R, river.x - 2], east: [river.x + river.w + 2, site.width - R] } // toes right up to the water
    : { west: [R, site.width / 2], east: [site.width / 2, site.width - R] };
  const sideOfX = (x) => (river ? (x < river.x + river.w / 2 ? 'west' : 'east') : x < site.width / 2 ? 'west' : 'east');

  // Staging: the yard with the members is split in half, the ready area on the half facing the
  // bridge and the assembly area behind it. Both are open ground: walk in and out freely.
  const area = membersArea(site);
  const cx = area.x + area.w / 2, cy = area.y + area.h / 2;
  const yard = site.zones.find((z) => z.type === 'staging' && cx >= z.x && cx <= z.x + z.w && cy >= z.y && cy <= z.y + z.h) || area;
  const facesWest = yard.x + yard.w / 2 > site.width / 2;
  const half = yard.w / 2;
  const ready = { x: facesWest ? yard.x : yard.x + half, y: yard.y, w: half, h: yard.h };
  const assembly = { x: facesWest ? yard.x + half : yard.x, y: yard.y, w: half, h: yard.h };
  const stagingSide = sideOfX(yard.x + yard.w / 2);
  const obstacles = [];
  const stageZones = site.zones.filter((z) => z.type === 'staging');

  // Members, with their outlines on the site.
  const members = new Map();
  for (const m of model.members) {
    const xs = m.corners3.map((c) => c[0]);
    const over = F.some(([a, b]) => Math.min(...xs) >= a - 0.5 && Math.max(...xs) <= b + 0.5);
    const foot = m.bearing ? F.findIndex(([a, b]) => m.bearingPoint[0] >= a - 0.5 && m.bearingPoint[0] <= b + 0.5) : -1;
    members.set(m.id, { m, poly: m.footprint.map(([x, y]) => toSite(x, y)), over, foot, xs: [Math.min(...xs), Math.max(...xs)], toSite });
  }

  const items = order.map((it, i) => ({
    ...it, idx: i, multi: isAssembly(it), status: 'waiting', progress: 0,
    time: assemblyTime(it, project, model, settings.fastenTime), loose: null,
  }));
  const itemOf = new Map();
  for (const it of items) for (const id of it.memberIds) itemOf.set(id, it);

  const bolts = model.bolts.map((b) => {
    const its = new Set(b.memberIds.map((id) => itemOf.get(id)?.id));
    const [x, y] = toSite(b.pos[0], b.pos[1]);
    return { id: b.id, x, y, z: b.pos[2], memberIds: b.memberIds, jointIds: b.jointIds, state: its.size <= 1 ? 'internal' : 'hidden', progress: 0, placedAt: 0, workedAt: 0, flashing: false };
  });

  const sf = startFooting(project, model, items[0]);
  const dir = F.length > 1 && sf === F.length - 1 ? -1 : 1;
  const startEdge = F.length ? (dir > 0 ? F[sf][0] : F[sf][1]) : 0;

  const S = {
    t: 0, project, model, site, settings, F, toSite, river, sides, sideOfX, ready, assembly, obstacles, stageZones, stagingSide, yard,
    members, items, itemOf, bolts, installed: new Set(),
    out: (x) => (dir > 0 ? x - startEdge : startEdge - x), dir, startFooting: sf,
    support: { needed: false, standing: false, fallen: false, grace: 0, holders: new Map(), length: 0, grown: 0 },
    penalties: 0, falls: [], neglected: 0, events: [], done: false, allBuilt: false, finishT: null,
    actors: [],
  };

  // Builders start in a staging yard on their side (or the nearest open ground there).
  const spawn = (side, i, n) => {
    const yards = stageZones.filter((z) => sideOfX(z.x + z.w / 2) === side);
    const z = yards[0] || { x: side === 'west' ? sides.west[0] : sides.east[0], y: 0, w: 60, h: site.depth };
    const x = z === yard ? yard.x + half : z.x + z.w / 2; // between the ready and assembly areas
    return clampPos(S, side, x, z.y + ((i + 1) * z.h) / (n + 1));
  };
  const bySide = { west: players.filter((p) => p.side === 'west'), east: players.filter((p) => p.side === 'east') };
  for (const p of players) {
    const list = bySide[p.side];
    const pos = spawn(p.side, list.indexOf(p), list.length);
    S.actors.push(newActor(p, pos));
  }
  if (npcs.assembler) {
    S.actors.push(newActor({ id: 'npc-assembler', name: 'Assembler (NPC)', color: '#64748b', side: stagingSide, npc: 'assembler' }, clampPos(S, stagingSide, assembly.x + assembly.w / 2, assembly.y + assembly.h * 0.75)));
  }
  if (npcs.holder) {
    const side = F.length ? sideOfX(toSite((F[sf][0] + F[sf][1]) / 2, 0)[0]) : 'west';
    const fx = F.length ? toSite(dir > 0 ? F[sf][0] - 20 : F[sf][1] + 20, 0)[0] : 100;
    S.actors.push(newActor({ id: 'npc-holder', name: 'Holder (NPC)', color: '#475569', side, npc: 'holder' }, clampPos(S, side, fx, site.depth - 30)));
  }
  releaseItems(S);
  return S;
}

function newActor(p, pos) {
  return {
    id: p.id, name: p.name, color: p.color, side: p.side, npc: p.npc || null, x: pos.x, y: pos.y, face: [1, 0],
    carrying: null, extending: false, anchor: null, work: null, prev: { a: false, x: false, lb: false }, push: { dir: 0, t: 0 },
    moving: false, activity: 'idle', prompt: null,
    stats: { time: Object.fromEntries(ACTIVITIES.map((k) => [k, 0])), holdTotal: 0, boltsPlaced: 0, nutsFastened: 0, piecesPlaced: 0, assemblies: 0, handoffs: 0, drops: 0 },
  };
}

// ---------- geometry helpers ----------
const dist = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by);
function distToPoly(px, py, poly) {
  if (pointInPoly([px, py], poly)) return 0;
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) best = Math.min(best, distToSegment2([px, py], poly[i], poly[(i + 1) % poly.length]).d);
  return best;
}
function distToRect(px, py, r) {
  const dx = Math.max(r.x - px, 0, px - (r.x + r.w)), dy = Math.max(r.y - py, 0, py - (r.y + r.h));
  return Math.hypot(dx, dy);
}
export function itemDist(S, item, x, y) {
  let best = Infinity;
  for (const id of item.memberIds) { const mm = S.members.get(id); if (mm) best = Math.min(best, distToPoly(x, y, mm.poly)); }
  return best;
}
// Closest spot a builder on `side` can stand to (x, y).
export function clampPos(S, side, x, y) {
  const [x0, x1] = S.sides[side];
  return { x: Math.max(x0, Math.min(x1, x)), y: Math.max(R, Math.min(S.site.depth - R, y)) };
}
const inStaging = (S, a) => S.stageZones.some((z) => a.x >= z.x - 1 && a.x <= z.x + z.w + 1 && a.y >= z.y - 1 && a.y <= z.y + z.h + 1);

// ---------- the ready area ----------
// Single pieces come out as soon as every assembly before them is made; assemblies once they're made.
export function releaseItems(S) {
  let blocked = false;
  for (const it of S.items) {
    if (it.multi) {
      if (it.status === 'waiting' || it.status === 'building') blocked = true;
      continue;
    }
    if (!blocked && it.status === 'waiting') { it.status = 'shelf'; S.events.push({ kind: 'ready', item: it.id }); }
  }
}
export const shelfItems = (S) => S.items.filter((it) => it.status === 'shelf');
// Where an item sits in an area: a grid in build order, squeezed together if there are many.
function gridSlot(r, i, n) {
  const cell = 22, cols = Math.max(1, Math.floor((r.w - 8) / cell));
  const rows = Math.max(1, Math.ceil(n / cols));
  const dy = Math.min(cell, (r.h - 16) / rows);
  return { x: r.x + 4 + cell * ((i % cols) + 0.5), y: r.y + 12 + dy * (Math.floor(i / cols) + 0.5) };
}
export function shelfSlot(S, item) {
  const list = shelfItems(S);
  return gridSlot(S.ready, list.indexOf(item), list.length);
}
export const buildingItems = (S) => S.items.filter((it) => it.status === 'building');
export function benchSlot(S, item) {
  const list = buildingItems(S);
  return gridSlot(S.assembly, list.indexOf(item), list.length);
}

// ---------- the bridge ----------
const isOn = (S, b) => b.memberIds.filter((id) => S.installed.has(id)).length >= 2;

// Distinct connections between an item and what's already in the bridge, with the bolts there.
function contactsWithBridge(S, item) {
  const ids = new Set(item.memberIds);
  const out = [];
  for (const c of S.model.contacts) {
    if (!c.bolts) continue;
    const mine = ids.has(c.a) ? c.b : ids.has(c.b) ? c.a : null;
    if (!mine || ids.has(mine) || !S.installed.has(mine)) continue;
    out.push(c.id);
  }
  return out;
}

export function canPlace(S, a, item) {
  if (S.support.fallen || a.anchor?.locked) return false;
  if (itemDist(S, item, a.x, a.y) > S.settings.reach) return false;
  const footed = item.memberIds.some((id) => S.members.get(id)?.m.bearing);
  return footed || contactsWithBridge(S, item).length > 0;
}

function placeItem(S, a) {
  const item = S.items.find((it) => it.id === a.carrying);
  const contacts = contactsWithBridge(S, item);
  for (const id of item.memberIds) S.installed.add(id);
  item.status = 'placed';
  a.carrying = null;
  a.extending = false;
  a.stats.piecesPlaced++;
  for (const b of S.bolts) if (b.state === 'hidden' && isOn(S, b)) b.state = 'needed';
  const need = Math.min(2, contacts.length);
  if (need && !item.buddy) {
    const mine = S.bolts.filter((b) => b.state === 'needed' && b.jointIds.some((j) => contacts.includes(j)));
    mine.sort((p, q) => dist(p.x, p.y, a.x, a.y) - dist(q.x, q.y, a.x, a.y));
    if (mine[0]) placeBolt(S, a, mine[0], false);
  }
  item.loose = { contacts, need, holder: a.id };
  S.events.push({ kind: 'place', item: item.id, by: a.id });
  if (!checkLoose(S, item)) {
    if (!a.anchor) a.anchor = { kind: 'piece', itemId: item.id, x: a.x, y: a.y, r: ANCHOR_PIECE, locked: !!item.buddy };
    else if (item.buddy) a.anchor.locked = true;
  }
  updateBridge(S);
}

// A placed piece is secure once it has its bolts. Returns true if it is.
function checkLoose(S, item) {
  const L = item.loose;
  if (!L) return true;
  const done = new Set();
  for (const b of S.bolts) if ((b.state === 'placed' || b.state === 'fastened') && b.memberIds.some((id) => item.memberIds.includes(id))) for (const j of b.jointIds) if (L.contacts.includes(j)) done.add(j);
  if (done.size < L.need) return false;
  item.loose = null;
  const h = S.actors.find((x) => x.id === L.holder);
  if (h && h.anchor?.kind === 'piece' && h.anchor.itemId === item.id) h.anchor = null;
  else if (h && h.anchor?.locked) h.anchor.locked = false;
  if (L.need) S.events.push({ kind: 'secure', item: item.id });
  return true;
}

function placeBolt(S, a, b, update = true) {
  b.state = 'placed';
  b.placedAt = b.workedAt = S.t;
  a.stats.boltsPlaced++;
  S.events.push({ kind: 'bolt', bolt: b.id, by: a.id });
  for (const it of S.items) if (it.loose) checkLoose(S, it);
  if (update) updateBridge(S);
}

// Hold points: installed laterals, or before the first one, the outer end of the first assembly.
export function holdPoints(S) {
  const pts = [];
  const S2 = S.project.design.trussSpacing / 2;
  for (const [id, mm] of S.members) {
    if (mm.m.plane !== 'L' || !S.installed.has(id)) continue;
    const [x, y] = S.toSite(mm.m.centroid[0], mm.m.centroid[1]);
    pts.push({ key: id, x, y, z: mm.m.centroid[2], out: S.out(mm.m.centroid[0]) });
  }
  if (!pts.length) {
    const first = S.items[0];
    if (first && first.status === 'placed') {
      const xs = first.memberIds.flatMap((id) => S.members.get(id)?.m.corners3.map((c) => c[0]) || []);
      const xEnd = S.dir > 0 ? Math.max(...xs) : Math.min(...xs);
      const [x, y] = S.toSite(xEnd - S.dir * 3, S2);
      pts.push({ key: 'start', x, y, z: 0, out: S.out(xEnd) });
    }
  }
  return pts.sort((p, q) => p.out - q.out);
}
export function standAt(S, a, pt) {
  const p = clampPos(S, a.side, pt.x, pt.y);
  return dist(p.x, p.y, pt.x, pt.y) <= S.settings.reach ? p : null;
}

// Recompute what holds the bridge up after anything changes.
function updateBridge(S) {
  const sup = S.support;
  // How far each truss reaches from the starting footing; the bridge is as long as the shorter.
  const reach = { A: 0, B: 0 };
  let hasB = false;
  for (const [id, mm] of S.members) {
    if (mm.m.plane === 'B') hasB = true;
    if (mm.m.plane === 'L' || !S.installed.has(id)) continue;
    const far = Math.max(S.out(mm.xs[0]), S.out(mm.xs[1]));
    reach[mm.m.plane] = Math.max(reach[mm.m.plane], far);
  }
  const length = hasB ? Math.min(reach.A, reach.B) : reach.A;
  if (length > sup.length + GROW_MIN) {
    sup.length = length;
    sup.grown++;
    for (const h of sup.holders.values()) h.stale++;
  }
  if (!sup.standing && standsAlone(S)) {
    sup.standing = true;
    for (const id of sup.holders.keys()) { const a = S.actors.find((x) => x.id === id); if (a?.anchor?.kind === 'bridge') a.anchor = null; }
    sup.holders.clear();
    sup.fallen = false;
    S.events.push({ kind: 'stands' });
  }
  const overhang = [...S.installed].some((id) => !S.members.get(id)?.over);
  sup.needed = !sup.standing && overhang;
  // The first lateral is in: anyone holding the first assembly moves to it.
  const pts = holdPoints(S);
  for (const [id, h] of sup.holders) {
    if (pts.some((p) => p.key === h.key)) continue;
    const a = S.actors.find((x) => x.id === id);
    const best = pts.map((p) => ({ p, s: a && standAt(S, a, p) })).filter((q) => q.s).sort((p, q) => dist(p.s.x, p.s.y, a.x, a.y) - dist(q.s.x, q.s.y, a.x, a.y))[0];
    if (best) { h.key = best.p.key; a.anchor = { ...a.anchor, x: best.s.x, y: best.s.y }; }
  }
}

// Self-supporting: secure pieces, bolted together, reach both footings on each truss, and the
// trusses are tied together by a lateral.
function standsAlone(S) {
  if (S.F.length < 2) return false;
  const first = S.items[0];
  if (!first || first.status !== 'placed') return false;
  const secure = (it) => it.status === 'placed' && !it.loose;
  const seen = new Set([first.id]);
  const queue = [first];
  while (queue.length) {
    const it = queue.pop();
    for (const b of S.bolts) {
      if (b.state !== 'placed' && b.state !== 'fastened') continue;
      if (!b.memberIds.some((id) => it.memberIds.includes(id))) continue;
      for (const id of b.memberIds) {
        const o = S.itemOf.get(id);
        if (o && !seen.has(o.id) && secure(o) && S.installed.has(id)) { seen.add(o.id); queue.push(o); }
      }
    }
  }
  const feet = { A: new Set(), B: new Set() };
  let lateral = false, hasB = false;
  for (const [id, mm] of S.members) if (mm.m.plane === 'B') hasB = true;
  for (const it of S.items) {
    if (!seen.has(it.id)) continue;
    for (const id of it.memberIds) {
      const mm = S.members.get(id);
      if (!mm) continue;
      if (mm.m.plane === 'L') lateral = true;
      else if (mm.foot >= 0) feet[mm.m.plane].add(mm.foot);
    }
  }
  return feet.A.size >= 2 && (!hasB || (feet.B.size >= 2 && lateral));
}

function fall(S, why) {
  const sup = S.support;
  S.penalties += S.settings.fallPenalty;
  S.falls.push({ t: S.t, why });
  sup.fallen = true;
  sup.grace = 0;
  for (const id of sup.holders.keys()) { const a = S.actors.find((x) => x.id === id); if (a?.anchor?.kind === 'bridge') a.anchor = null; }
  sup.holders.clear();
  for (const a of S.actors) if (a.work?.kind === 'fasten') a.work = null;
  S.events.push({ kind: 'fall', why });
}

export function takeHold(S, a, pt) {
  const s = standAt(S, a, pt);
  if (!s) return false;
  a.anchor = { kind: 'bridge', x: s.x, y: s.y, r: ANCHOR_BRIDGE };
  a.x = s.x; a.y = s.y;
  a.work = null;
  S.support.holders.set(a.id, { key: pt.key, stale: 0 });
  if (S.support.fallen) { S.support.fallen = false; S.events.push({ kind: 'held' }); }
  S.support.grace = 0;
  return true;
}
function moveHold(S, a, step) {
  const h = S.support.holders.get(a.id);
  const pts = holdPoints(S).filter((p) => standAt(S, a, p));
  const i = pts.findIndex((p) => p.key === h.key);
  const cur = pts[i];
  const next = pts[i + step];
  if (!next) return false;
  const s = standAt(S, a, next);
  if (cur && next.out > cur.out) h.stale = 0;
  h.key = next.key;
  a.anchor = { ...a.anchor, x: s.x, y: s.y };
  a.x = s.x; a.y = s.y;
  return true;
}
function letGo(S, a) {
  const sup = S.support;
  if (!sup.holders.has(a.id)) return;
  sup.holders.delete(a.id);
  if (a.anchor?.kind === 'bridge') a.anchor = null;
  if (sup.needed && !sup.holders.size && !sup.fallen) fall(S, a.name + ' let go with nobody else holding');
}

// ---------- what a button would do here ----------
function nearestBolt(S, a, state) {
  if (S.support.fallen) return null;
  let best = null, bd = S.settings.reach;
  for (const b of S.bolts) {
    if (b.state !== state) continue;
    const d = dist(b.x, b.y, a.x, a.y);
    if (d <= bd) { bd = d; best = b; }
  }
  return best;
}
function passer(S, a) {
  let best = null, bd = S.settings.passReach;
  for (const o of S.actors) {
    if (o === a || !o.extending || !o.carrying) continue;
    const d = dist(o.x, o.y, a.x, a.y);
    if (d <= bd) { bd = d; best = o; }
  }
  return best;
}
// Anywhere in or near the ready area, grabbing takes the next item in the build order.
const inReady = (S, a) => distToRect(a.x, a.y, S.ready) <= STATION_REACH;
function shelfPick(S, a) {
  return inReady(S, a) ? shelfItems(S)[0] || null : null;
}
// In the assembly area, X works on: what you were making, else one someone left half made, else
// the next assembly in the order, else helps someone with theirs.
function assemblyFor(S, a) {
  if (distToRect(a.x, a.y, S.assembly) > STATION_REACH) return null;
  if (a.work?.kind === 'assemble' && a.work.target.status === 'building') return a.work.target;
  const busy = new Set(S.actors.filter((o) => o !== a && o.work?.kind === 'assemble').map((o) => o.work.target));
  const building = buildingItems(S);
  return building.find((it) => !busy.has(it)) || S.items.find((it) => it.multi && it.status === 'waiting') || building[0] || null;
}

export function actionA(S, a) {
  if (a.anchor?.locked) return null;
  if (a.carrying) {
    const item = S.items.find((it) => it.id === a.carrying);
    if (canPlace(S, a, item)) return { kind: 'place', label: item.buddy ? 'Set in place' : 'Place + bolt' };
    if (inReady(S, a)) return { kind: 'putback', label: 'Put back' };
    return { kind: 'extend', label: 'Hold to pass' };
  }
  const o = passer(S, a);
  if (o) return { kind: 'take', label: 'Take from ' + o.name, target: o };
  const it = shelfPick(S, a);
  if (it) return { kind: 'grab', label: 'Grab #' + (it.idx + 1), target: it };
  const b = nearestBolt(S, a, 'needed');
  if (b) return { kind: 'bolt', label: 'Place bolt', target: b };
  return null;
}
export function actionX(S, a) {
  if (a.anchor?.locked || a.carrying) return null;
  const b = nearestBolt(S, a, 'placed');
  if (b) return { kind: 'fasten', label: 'Fasten', target: b };
  const it = assemblyFor(S, a);
  if (it) {
    const helping = it.status === 'building' && S.actors.some((o) => o !== a && o.work?.kind === 'assemble' && o.work.target === it);
    return { kind: 'assemble', label: (helping ? 'Help with #' : 'Assemble #') + (it.idx + 1), target: it };
  }
  return null;
}
export function actionLB(S, a) {
  const sup = S.support;
  if (sup.holders.has(a.id)) return { kind: 'holding', label: 'Holding' };
  if (a.anchor || !(sup.needed || sup.fallen) || sup.standing) return null;
  let best = null, bd = HOLD_SNAP;
  for (const p of holdPoints(S)) {
    const s = standAt(S, a, p);
    if (!s) continue;
    const d = dist(s.x, s.y, a.x, a.y);
    if (d <= bd) { bd = d; best = p; }
  }
  return best ? { kind: 'hold', label: 'Hold bridge', target: best } : null;
}

function doA(S, a, act) {
  if (!act) return;
  if (act.kind === 'place') placeItem(S, a);
  else if (act.kind === 'putback') { const it = S.items.find((x) => x.id === a.carrying); it.status = 'shelf'; a.carrying = null; }
  else if (act.kind === 'extend') a.extending = true;
  else if (act.kind === 'take') {
    const o = act.target;
    a.carrying = o.carrying; o.carrying = null; o.extending = false;
    S.items.find((x) => x.id === a.carrying).status = 'carried';
    o.stats.handoffs++;
    S.events.push({ kind: 'pass', from: o.id, to: a.id });
  } else if (act.kind === 'grab') { a.carrying = act.target.id; act.target.status = 'carried'; S.events.push({ kind: 'grab', by: a.id }); }
  else if (act.kind === 'bolt') placeBolt(S, a, act.target);
}

// Keep working (fastening or assembling) while X is held. Returns true while busy.
function work(S, a, dt) {
  let w = a.work;
  if (w && w.kind === 'fasten' && (w.target.state !== 'placed' || S.support.fallen || dist(w.target.x, w.target.y, a.x, a.y) > S.settings.reach)) w = null;
  if (w && w.kind === 'assemble' && (w.target.status !== 'building' || distToRect(a.x, a.y, S.assembly) > STATION_REACH)) w = null;
  if (!w) {
    const act = actionX(S, a);
    if (!act) { a.work = null; return false; }
    w = { kind: act.kind, target: act.target };
  }
  a.work = w;
  a.lastWork = w.kind;
  if (w.kind === 'fasten') {
    const b = w.target;
    b.progress += dt;
    b.workedAt = S.t;
    if (b.progress >= S.settings.fastenTime) {
      b.state = 'fastened'; b.flashing = false; a.stats.nutsFastened++; a.work = null;
      S.events.push({ kind: 'fastened', bolt: b.id });
    }
    return true;
  }
  // Several builders on one assembly make it faster together.
  const it = w.target;
  if (it.status === 'waiting') it.status = 'building';
  it.progress += dt;
  if (it.progress >= it.time) {
    it.status = 'shelf';
    a.work = null;
    a.stats.assemblies++;
    S.events.push({ kind: 'ready', item: it.id, made: true });
    releaseItems(S);
  }
  return true;
}

// ---------- moving ----------
function move(S, a, mx, my, dt) {
  const m = Math.hypot(mx, my);
  if (m > 1) { mx /= m; my /= m; }
  a.moving = m > 0.15;
  if (a.moving) a.face = [mx / Math.max(1e-6, Math.hypot(mx, my)), my / Math.max(1e-6, Math.hypot(mx, my))];
  if (a.anchor?.kind === 'piece' && !a.anchor.locked) {
    // Holding a piece in place: shuffle along it, but stay within reach of it.
    if (!a.moving) return;
    const item = S.items.find((it) => it.id === a.anchor.itemId);
    const p = clampPos(S, a.side, a.x + mx * S.settings.carrySpeed * dt, a.y + my * S.settings.carrySpeed * dt);
    if (!item || itemDist(S, item, p.x, p.y) <= S.settings.reach) { a.x = p.x; a.y = p.y; }
    return;
  }
  if (a.anchor) {
    // Lean a little around where you're holding.
    a.x = a.anchor.x + mx * a.anchor.r;
    a.y = a.anchor.y + my * a.anchor.r;
    const p = clampPos(S, a.side, a.x, a.y);
    a.x = p.x; a.y = p.y;
    return;
  }
  if (!a.moving) return;
  const v = a.carrying ? S.settings.carrySpeed : S.settings.walkSpeed;
  let x = a.x + mx * v * dt, y = a.y + my * v * dt;
  for (const o of S.obstacles) {
    const qx = Math.max(o.x, Math.min(o.x + o.w, x)), qy = Math.max(o.y, Math.min(o.y + o.h, y));
    const d = Math.hypot(x - qx, y - qy);
    if (d < R) {
      if (d > 1e-6) { x = qx + ((x - qx) / d) * R; y = qy + ((y - qy) / d) * R; }
      else { x = a.x; y = a.y; }
    }
  }
  const p = clampPos(S, a.side, x, y);
  a.x = p.x; a.y = p.y;
}
function separate(S) {
  for (let i = 0; i < S.actors.length; i++) {
    for (let j = i + 1; j < S.actors.length; j++) {
      const p = S.actors[i], q = S.actors[j];
      const d = dist(p.x, p.y, q.x, q.y);
      if (d >= 2 * R || d < 1e-6) continue;
      const push = (2 * R - d) / 2, ux = (q.x - p.x) / d, uy = (q.y - p.y) / d;
      if (!p.anchor) { const a = clampPos(S, p.side, p.x - ux * push, p.y - uy * push); p.x = a.x; p.y = a.y; }
      if (!q.anchor) { const b = clampPos(S, q.side, q.x + ux * push, q.y + uy * push); q.x = b.x; q.y = b.y; }
    }
  }
}

// ---------- one tick ----------
/** inputs: Map actorId -> {mx, my, a, x, lb} (buttons held down). */
export function stepGame(S, inputs, dt) {
  if (S.done) return;
  S.t += dt;
  for (const a of S.actors) {
    const inp = a.npc ? npcThink(S, a, dt) : inputs.get(a.id) || { mx: 0, my: 0, a: false, x: false, lb: false };
    a.npcInput = a.npc ? inp : null;
    move(S, a, inp.mx || 0, inp.my || 0, dt);

    // Pushing the stick along the bridge while holding it moves to the next lateral.
    if (S.support.holders.has(a.id)) {
      const along = (inp.mx || 0) * S.dir;
      const d = Math.abs(along) >= SNAP_PUSH ? Math.sign(along) : 0;
      if (d && d === a.push.dir) a.push.t += dt; else a.push = { dir: d, t: 0 };
      if (d && a.push.t >= SNAP_TIME) { moveHold(S, a, d); a.push = { dir: d, t: -1 }; }
    }
    if (inp.snap) moveHold(S, a, inp.snap);

    // A: tap to grab, place or bolt; hold while carrying to pass.
    if (inp.a && !a.prev.a) doA(S, a, actionA(S, a));
    if (!inp.a && a.extending) a.extending = false;
    // LB: hold the bridge.
    if (inp.lb && !a.prev.lb) { const act = actionLB(S, a); if (act?.kind === 'hold') takeHold(S, a, act.target); }
    if (!inp.lb && a.prev.lb) letGo(S, a);
    // X: hold to fasten or assemble.
    const busy = inp.x ? work(S, a, dt) : false;
    if (!inp.x && a.work) a.work = null;
    a.prev = { a: !!inp.a, x: !!inp.x, lb: !!inp.lb };

    a.activity = busy ? a.lastWork
      : S.support.holders.has(a.id) ? 'hold'
      : a.anchor?.kind === 'piece' ? 'brace'
      : a.extending ? 'pass'
      : a.carrying ? 'carry'
      : a.moving ? 'walk' : 'idle';
    a.stats.time[a.activity] += dt;
    if (S.support.holders.has(a.id)) a.stats.holdTotal += dt;
  }
  separate(S);

  // Holding the bridge up.
  const sup = S.support;
  updateBridge(S);
  if (sup.needed && !sup.fallen) {
    if (!sup.holders.size) {
      sup.grace += dt;
      if (sup.grace >= S.settings.grace) fall(S, 'Nobody took hold of the bridge');
    } else {
      sup.grace = 0;
      if ([...sup.holders.values()].every((h) => h.stale >= 2)) fall(S, 'The bridge grew twice and nobody moved out to hold it');
    }
  } else sup.grace = 0;

  // Bolts left unfastened start flashing.
  for (const b of S.bolts) {
    if (b.state !== 'placed') continue;
    const f = S.t - b.workedAt > S.settings.neglect;
    if (f && !b.flashing) S.neglected++;
    b.flashing = f;
  }

  for (const a of S.actors) {
    if (a.npc) continue;
    const A = actionA(S, a), X = actionX(S, a), LB = actionLB(S, a);
    a.prompt = { A, X, LB };
  }

  S.allBuilt = S.items.every((it) => it.status === 'placed' && !it.loose) && S.bolts.every((b) => b.state === 'internal' || b.state === 'fastened');
  if (S.allBuilt && S.actors.every((a) => inStaging(S, a) && !a.anchor)) {
    S.done = true;
    S.finishT = S.t;
    S.events.push({ kind: 'done' });
  }
}

// ---------- NPCs ----------
function goTo(S, a, x, y, tol = 4) {
  const dx = x - a.x, dy = y - a.y, d = Math.hypot(dx, dy);
  if (d <= tol) return { mx: 0, my: 0, there: true };
  return { mx: dx / d, my: dy / d, there: false };
}
function npcThink(S, a, dt) {
  const none = { mx: 0, my: 0, a: false, x: false, lb: false };
  if (a.npc === 'assembler') {
    const z = S.assembly;
    const spot = clampPos(S, a.side, z.x + z.w / 2, z.y + z.h * 0.75);
    const g = goTo(S, a, spot.x, spot.y);
    if (!g.there) return { ...none, ...g };
    return { ...none, x: !!assemblyFor(S, a) };
  }
  // Holder: holds the bridge at the newest lateral it can reach until it stands, then bolts and
  // fastens the buddy pieces.
  const sup = S.support;
  if (!sup.standing) {
    const pts = holdPoints(S).filter((p) => standAt(S, a, p));
    const far = pts[pts.length - 1];
    if (sup.holders.has(a.id)) {
      const h = sup.holders.get(a.id);
      const cur = pts.findIndex((p) => p.key === h.key);
      return { ...none, lb: true, snap: far && cur >= 0 && cur < pts.length - 1 ? 1 : 0 };
    }
    if ((sup.needed || sup.fallen) && far) {
      const s = standAt(S, a, far);
      const g = goTo(S, a, s.x, s.y, 10);
      return { ...none, mx: g.mx, my: g.my, lb: g.there && !a.prev.lb ? true : false };
    }
    // Wait near the starting footing.
    const fx = S.F.length ? S.toSite((S.F[S.startFooting][0] + S.F[S.startFooting][1]) / 2 + S.dir * 30, 0)[0] : a.x;
    const p = clampPos(S, a.side, fx, S.site.depth - 30);
    return { ...none, ...goTo(S, a, p.x, p.y, 8) };
  }
  // Buddy pieces' bolts within its side.
  const buddyIds = new Set(S.items.filter((it) => it.buddy && it.status === 'placed').flatMap((it) => it.memberIds));
  const jobs = S.bolts.filter((b) => (b.state === 'needed' || b.state === 'placed') && b.memberIds.some((id) => buddyIds.has(id)));
  let best = null, bd = Infinity;
  for (const b of jobs) {
    const s = clampPos(S, a.side, b.x, b.y);
    if (dist(s.x, s.y, b.x, b.y) > S.settings.reach - 2) continue;
    const d = dist(s.x, s.y, a.x, a.y);
    if (d < bd) { bd = d; best = { b, s }; }
  }
  if (best) {
    const near = dist(best.b.x, best.b.y, a.x, a.y) <= S.settings.reach - 4;
    if (!near) return { ...none, ...goTo(S, a, best.s.x, best.s.y, 2) };
    if (best.b.state === 'needed') return { ...none, a: !a.prev.a };
    return { ...none, x: true };
  }
  if (S.allBuilt) {
    const z = S.stageZones.filter((q) => S.sideOfX(q.x + q.w / 2) === a.side).sort((p, q) => Math.abs(p.x + p.w / 2 - a.x) - Math.abs(q.x + q.w / 2 - a.x))[0];
    if (z) { const p = clampPos(S, a.side, Math.max(z.x + 10, Math.min(z.x + z.w - 10, a.x)), Math.max(z.y + 10, Math.min(z.y + z.h - 10, a.y))); return { ...none, ...goTo(S, a, p.x, p.y) }; }
  }
  return none;
}

// ---------- results ----------
export function results(S) {
  const time = S.finishT ?? S.t;
  return {
    done: S.done, time, penalties: S.penalties, total: time + S.penalties, falls: S.falls, neglected: S.neglected,
    players: S.actors.map((a) => ({ id: a.id, name: a.name, color: a.color, side: a.side, npc: a.npc, ...a.stats })),
  };
}
