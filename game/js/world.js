// Over Engineered: the game's rules, kept apart from drawing and input so they can be tested.
//
// The site is the year's layout (inches, x west → east, y north → south). The staging yard with
// the members is split in half, north and south: an assembly area anyone can work in, and a
// ready area where finished items wait at full size. Builders can't cross the river or leave the site.
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
//     (hold LB) once anything hangs past a footing. A holder can walk along any part of the bridge
//     on their side of the river while holding it. Letting go with nobody else holding, nobody
//     taking hold in time, or every holder staying put while the bridge grows longer twice drops
//     the bridge: a time penalty, and someone has to hold it again before work goes on.
//   - Done when every piece is in, every nut is fastened and everyone is back in a staging yard.
//   - The score is the construction cost from the rules: minutes x builders x $ per builder-minute,
//     with the crew discount (lower is better).
//   - NPCs press the same buttons players do (see the end of this file).
import { buildModel, bridgeToSite, distToSegment2, footingRanges, pointInPoly, siteToBridge } from '../../js/model/geometry.js';
import { membersArea } from '../../js/model/plan.js';
import { gameAssemblyTime, isAssembly, startFooting } from './order.js';

export const R = 8; // builder radius (in)
const HOLD_SNAP = 80; // how far away a builder can be to take hold of the bridge
const STATION_REACH = 12; // how close to the assembly or ready area counts as in it
const HOLD_REACH = 26; // a holder stays within this of the bridge while walking along it (in)
const HOLD_RESET = 12; // moving this much farther out along the bridge counts as moving out (in)
const ANCHOR_PIECE = 12;
const GROW_MIN = 4; // the bridge has grown when it reaches at least this much farther (in)

export const ACTIVITIES = ['fasten', 'assemble', 'hold', 'brace', 'pass', 'carry', 'walk', 'idle'];
export const ACTIVITY_NAMES = { fasten: 'Fastening', assemble: 'Assembling', hold: 'Holding the bridge', brace: 'Holding a piece', pass: 'Passing', carry: 'Carrying', walk: 'Walking', idle: 'Waiting' };

export function defaultSettings(project, fastenTime) {
  const tm = project.timing;
  return {
    fastenTime, // s to fasten one nut (hold X)
    assemblyTime: 4, // s to make any assembly (hold X); 0 = use each one's time from the sequencer
    fallPenalty: 20, // s added when the bridge falls
    grace: 3, // s to take hold once the bridge needs holding
    neglect: 6, // s before an unfastened bolt starts flashing
    walkSpeed: Math.round((tm.walkSpeed || 54) * 1.35),
    carrySpeed: Math.round((tm.carrySpeed || 36) * 1.5),
    reach: tm.maxReach || 40,
    comSpeed: 80, // % of players' speeds that computers work at once they're roaming (see pace)
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

  // Staging: the yard with the members is split in half across its depth, the assembly area to
  // the north and the ready area to the south. Both are open ground: walk in and out freely.
  const area = membersArea(site);
  const cx = area.x + area.w / 2, cy = area.y + area.h / 2;
  const yard = site.zones.find((z) => z.type === 'staging' && cx >= z.x && cx <= z.x + z.w && cy >= z.y && cy <= z.y + z.h) || area;
  const half = yard.h / 2;
  const assembly = { x: yard.x, y: yard.y, w: yard.w, h: half };
  const ready = { x: yard.x, y: yard.y + half, w: yard.w, h: yard.h - half };
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
    time: gameAssemblyTime(it, project, model, settings), loose: null,
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
    // In the yard, spread out along the line between the ready and assembly areas.
    if (z === yard) return clampPos(S, side, z.x + ((i + 1) * z.w) / (n + 1), yard.y + half);
    return clampPos(S, side, z.x + z.w / 2, z.y + ((i + 1) * z.h) / (n + 1));
  };
  const bySide = { west: players.filter((p) => p.side === 'west'), east: players.filter((p) => p.side === 'east') };
  for (const p of players) {
    const list = bySide[p.side];
    const pos = spawn(p.side, list.indexOf(p), list.length);
    S.actors.push(newActor(p, pos));
  }
  if (npcs.assembler) {
    S.actors.push(newActor({ id: 'npc-assembler', name: 'Assembler (NPC)', color: '#64748b', side: stagingSide, npc: 'assembler' }, clampPos(S, stagingSide, assembly.x + assembly.w * 0.8, assembly.y + assembly.h * 0.5)));
  }
  if (npcs.holder) {
    const side = F.length ? sideOfX(toSite((F[sf][0] + F[sf][1]) / 2, 0)[0]) : 'west';
    const fx = F.length ? toSite(dir > 0 ? F[sf][0] - 20 : F[sf][1] + 20, 0)[0] : 100;
    S.actors.push(newActor({ id: 'npc-holder', name: 'Holder (NPC)', color: '#475569', side, npc: 'holder' }, clampPos(S, side, fx, site.depth - 30)));
  }
  // Extra computer builders filling empty player spots: they take whatever job is nearest.
  (npcs.helpers || []).forEach((h, k) => {
    const same = (npcs.helpers || []).filter((q) => q.side === h.side);
    const pos = spawn(h.side, same.indexOf(h) + (bySide[h.side]?.length || 0), same.length + (bySide[h.side]?.length || 0));
    S.actors.push(newActor({ id: 'npc-com-' + (k + 1), name: 'COM ' + (k + 1), color: COM_COLORS[k % COM_COLORS.length], side: h.side, npc: 'helper', label: 'C' + (k + 1) }, pos));
  });
  releaseItems(S);
  return S;
}
const COM_COLORS = ['#94a3b8', '#7c8aa0', '#a3b1c4', '#6b7a90'];

function newActor(p, pos) {
  return {
    id: p.id, name: p.name, color: p.color, side: p.side, npc: p.npc || null, label: p.label || null, task: null, x: pos.x, y: pos.y, face: [1, 0],
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
// An item at full size: its outline as it sits in the bridge, as a box on the site (in, z up).
export function itemBox(S, it) {
  if (it.box) return it.box;
  const b = { x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity, z0: Infinity, z1: -Infinity };
  for (const id of it.memberIds) {
    const mm = S.members.get(id);
    if (!mm) continue;
    const h = mm.m.thick / 2, lat = mm.m.plane === 'L';
    for (const c of mm.m.corners3) {
      for (const sg of [-1, 1]) {
        const [x, y] = mm.toSite(c[0], c[1] + (lat ? 0 : sg * h));
        const z = c[2] + (lat ? sg * h : 0);
        b.x0 = Math.min(b.x0, x); b.x1 = Math.max(b.x1, x);
        b.y0 = Math.min(b.y0, y); b.y1 = Math.max(b.y1, y);
        b.z0 = Math.min(b.z0, z); b.z1 = Math.max(b.z1, z);
      }
    }
  }
  return (it.box = b);
}
// Roughly how much ground depth one inch of height covers on screen.
const LIFT = 1.2;
// Lay items out at full size, the way they'd stand in the bridge, in build order in rows across an
// area. Rows are squeezed together (overlapping) if they don't all fit. Each item gets the shift
// to draw it there ({dx, dy, dz}) and where its middle is on the ground ({x, y}).
function layout(S, area, list) {
  const pad = 4, out = new Map(), rows = [];
  let row = null;
  for (const it of list) {
    const b = itemBox(S, it), w = b.x1 - b.x0, h = b.y1 - b.y0 + (b.z1 - b.z0) * LIFT;
    if (!row || (row.items.length && row.w + w > area.w - 2 * pad)) { row = { items: [], w: 0, h: 0 }; rows.push(row); }
    row.items.push({ it, b, w });
    row.w += w + pad;
    row.h = Math.max(row.h, h);
  }
  const avail = area.h - 2 * pad - 12; // leave room for the area's name
  const last = rows.length ? rows[rows.length - 1].h : 0;
  const total = rows.reduce((t, r) => t + r.h + pad, -pad);
  const squeeze = rows.length > 1 && total > avail ? Math.max(0.15, (avail - last) / (total - last)) : 1;
  let y = area.y + pad;
  for (const r of rows) {
    let x = area.x + pad + Math.max(0, (area.w - 2 * pad - (r.w - pad)) / 2);
    const ground = y + r.h; // everything in a row stands on the same line
    for (const q of r.items) {
      const dx = x - q.b.x0, dy = ground - q.b.y1;
      out.set(q.it, { dx, dy, dz: -q.b.z0, x: x + q.w / 2, y: ground - (q.b.y1 - q.b.y0) / 2 });
      x += q.w + pad;
    }
    y += (r.h + pad) * squeeze;
  }
  return out;
}
export const readyLayout = (S) => layout(S, S.ready, shelfItems(S));
export const buildingItems = (S) => S.items.filter((it) => it.status === 'building');
export const benchLayout = (S) => layout(S, S.assembly, buildingItems(S));
export const shelfSlot = (S, item) => readyLayout(S).get(item);
export const benchSlot = (S, item) => benchLayout(S).get(item);

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

// How far a point on the site is from the nearest installed piece of the bridge.
export function bridgeDist(S, x, y) {
  let best = Infinity;
  for (const id of S.installed) { const mm = S.members.get(id); if (mm) best = Math.min(best, distToPoly(x, y, mm.poly)); }
  return best;
}
// How far out along the bridge (from the starting footing) a point on the site is.
const outAt = (S, x, y) => S.out(siteToBridge(S.site, x, y).x);

// Installed pieces joined to the starting end (the first item, or anything resting on the starting
// footing, so each truss counts before a lateral ties them), through pieces touching each other.
function joinedToStart(S) {
  if (!S.adj) {
    S.adj = new Map();
    for (const c of S.model.contacts) {
      if (!S.adj.has(c.a)) S.adj.set(c.a, []);
      if (!S.adj.has(c.b)) S.adj.set(c.b, []);
      S.adj.get(c.a).push(c.b); S.adj.get(c.b).push(c.a);
    }
  }
  const seen = new Set([...(S.items[0]?.memberIds || []), ...[...S.members].filter(([, mm]) => mm.foot === S.startFooting).map(([id]) => id)].filter((id) => S.installed.has(id)));
  const queue = [...seen];
  while (queue.length) {
    for (const o of S.adj.get(queue.pop()) || []) if (S.installed.has(o) && !seen.has(o)) { seen.add(o); queue.push(o); }
  }
  return seen;
}

// Recompute what holds the bridge up after anything changes.
function updateBridge(S) {
  const sup = S.support;
  // How far each truss reaches from the starting footing; the bridge is as long as the shorter.
  // Only pieces joined (through other installed pieces) to the first one count: a piece standing
  // on its own on the far footing doesn't make the bridge any longer.
  const joined = joinedToStart(S);
  const reach = { A: 0, B: 0 };
  let hasB = false;
  for (const [id, mm] of S.members) {
    if (mm.m.plane === 'B') hasB = true;
    if (mm.m.plane === 'L' || !joined.has(id)) continue;
    const far = Math.max(S.out(mm.xs[0]), S.out(mm.xs[1]));
    reach[mm.m.plane] = Math.max(reach[mm.m.plane], far);
  }
  const length = hasB ? Math.min(reach.A, reach.B) : reach.A;
  // Once each truss's joined pieces rest on another footing, the span has landed: growing onto it
  // isn't hanging farther out, so it doesn't count against the holders.
  const landed = ['A', ...(hasB ? ['B'] : [])].every((pl) => [...joined].some((id) => { const mm = S.members.get(id); return mm.m.plane === pl && mm.foot >= 0 && mm.foot !== S.startFooting; }));
  if (length > sup.length + GROW_MIN) {
    sup.length = length;
    sup.grown++;
    if (!landed) for (const h of sup.holders.values()) h.stale++;
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

// Take hold where you stand (next to the bridge), or step to a nearby hold point.
export function takeHold(S, a, pt) {
  const s = pt.here ? { x: a.x, y: a.y } : standAt(S, a, pt);
  if (!s) return false;
  a.anchor = { kind: 'bridge', x: s.x, y: s.y };
  a.x = s.x; a.y = s.y;
  a.work = null;
  S.support.holders.set(a.id, { stale: 0, best: outAt(S, s.x, s.y) });
  if (S.support.fallen) { S.support.fallen = false; S.events.push({ kind: 'held' }); }
  S.support.grace = 0;
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
  if (bridgeDist(S, a.x, a.y) <= HOLD_REACH) return { kind: 'hold', label: 'Hold bridge', target: { here: true } };
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
    b.progress += dt * pace(S, a);
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
  it.progress += dt * pace(S, a);
  if (it.progress >= it.time) {
    it.status = 'shelf';
    a.work = null;
    a.stats.assemblies++;
    S.events.push({ kind: 'ready', item: it.id, made: true });
    releaseItems(S);
  }
  return true;
}

// How fast someone works, as a share of the speed settings: 1 for players and for computers on
// their main job (the holder until the bridge stands, the assembler while assemblies are left);
// the computer speed factor for computers roaming (COMs always, the others once that job is done).
export function roaming(S, a) {
  if (!a.npc) return false;
  if (a.npc === 'holder') return S.support.standing;
  if (a.npc === 'assembler') return !S.items.some((it) => it.multi && (it.status === 'waiting' || it.status === 'building'));
  return true;
}
export const pace = (S, a) => (roaming(S, a) ? Math.max(0.05, (S.settings.comSpeed ?? 80) / 100) : 1);

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
    const v = S.settings.carrySpeed * pace(S, a);
    const p = clampPos(S, a.side, a.x + mx * v * dt, a.y + my * v * dt);
    if (!item || itemDist(S, item, p.x, p.y) <= S.settings.reach) { a.x = p.x; a.y = p.y; }
    return;
  }
  if (a.anchor?.kind === 'bridge') {
    // Holding the bridge: walk along it (slowly), anywhere on your side, staying right next to it.
    if (!a.moving) return;
    const v = S.settings.carrySpeed * 0.8 * pace(S, a);
    const tryAt = (x, y) => {
      const p = clampPos(S, a.side, x, y);
      if (bridgeDist(S, p.x, p.y) > HOLD_REACH) return false;
      a.x = p.x; a.y = p.y; a.anchor.x = p.x; a.anchor.y = p.y;
      return true;
    };
    const nx = a.x + mx * v * dt, ny = a.y + my * v * dt;
    if (!tryAt(nx, ny) && !tryAt(nx, a.y)) tryAt(a.x, ny);
    return;
  }
  if (a.anchor) {
    // Holding a buddy piece: lean a little around it.
    a.x = a.anchor.x + mx * a.anchor.r;
    a.y = a.anchor.y + my * a.anchor.r;
    const p = clampPos(S, a.side, a.x, a.y);
    a.x = p.x; a.y = p.y;
    return;
  }
  if (!a.moving) return;
  const v = (a.carrying ? S.settings.carrySpeed : S.settings.walkSpeed) * pace(S, a);
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

    // A holder who walks out along the bridge keeps up with it.
    const hd = S.support.holders.get(a.id);
    if (hd) { const o = outAt(S, a.x, a.y); if (o > hd.best + HOLD_RESET) { hd.best = o; hd.stale = 0; } }

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
    if (f && !b.flashing) { S.neglected++; S.events.push({ kind: 'flash', bolt: b.id }); }
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
// NPCs press the same buttons players do. Each has a main job: the holder holds the bridge (and
// puts in and fastens bolts it can reach while holding) until it stands; the assembler makes
// assemblies. Otherwise, and for the extra COM builders always, an NPC takes the nearest job going
// on its side of the river, working down the build order: hold the bridge if nobody is, take a
// piece being passed across, deliver what it carries (passing it over the river if it goes on the
// other side), put in and fasten bolts, run the next ready piece, help make assemblies. When
// everything is built it walks back to a staging yard.
function goTo(S, a, x, y, tol = 4) {
  const dx = x - a.x, dy = y - a.y, d = Math.hypot(dx, dy);
  if (d <= tol) return { mx: 0, my: 0, there: true };
  return { mx: dx / d, my: dy / d, there: false };
}
const NONE = { mx: 0, my: 0, a: false, x: false, lb: false };
const tapA = (a) => !a.prev.a; // press A this frame (a tap needs A up the frame before)
// Where on its side an NPC can stand to reach a point, if anywhere.
function reachSpot(S, side, x, y, reach) {
  const q = clampPos(S, side, x, y);
  return dist(q.x, q.y, x, y) <= reach ? q : null;
}
// Where on a side an NPC can stand to place an item, nearest to `from`, if anywhere.
function itemSpot(S, side, item, from) {
  const reach = S.settings.reach - 3;
  let best = null, bd = Infinity;
  for (const id of item.memberIds) {
    const mm = S.members.get(id);
    if (!mm) continue;
    const c = mm.poly.reduce((t, q) => [t[0] + q[0] / mm.poly.length, t[1] + q[1] / mm.poly.length], [0, 0]);
    for (const [x, y] of [c, ...mm.poly]) {
      for (const dy of [0, -14, 14]) {
        const q = clampPos(S, side, x, y + dy);
        if (itemDist(S, item, q.x, q.y) > reach) continue;
        const d = dist(q.x, q.y, from.x, from.y);
        if (d < bd) { bd = d; best = q; }
      }
    }
  }
  return best;
}
// Could this item go in now (it stands on a footing or touches something already in)?
const placeableNow = (S, item) => item.memberIds.some((id) => S.members.get(id)?.m.bearing) || contactsWithBridge(S, item).length > 0;
// The river-edge spot on a side facing a point.
function edgeSpot(S, side, y) {
  const [x0, x1] = S.sides[side];
  return clampPos(S, side, side === 'west' ? x1 : x0, y);
}
// The farthest-out spot along the bridge an NPC holding it can reach on its side (worked out
// again only when pieces go in).
function farHoldSpot(S, a) {
  const key = a.side + ':' + S.installed.size;
  S.farHold = S.farHold || new Map();
  if (S.farHold.has(key)) return S.farHold.get(key);
  let best = null, bo = -Infinity;
  for (const id of S.installed) {
    const mm = S.members.get(id);
    for (const [x, y] of mm.poly) {
      const q = clampPos(S, a.side, x, y);
      if (bridgeDist(S, q.x, q.y) > HOLD_REACH - 4) continue;
      const o = outAt(S, q.x, q.y);
      if (o > bo) { bo = o; best = q; }
    }
  }
  S.farHold.set(key, best);
  return best;
}
// Is a job an NPC picked a moment ago still there to do?
function stillOn(S, a, job) {
  switch (job.kind) {
    case 'deliver': case 'pass': return a.carrying === job.item.id;
    case 'take': return !a.carrying && !!job.from.carrying;
    case 'bolt': return !a.carrying && job.bolt.state === 'needed' && !S.support.fallen;
    case 'fasten': return !a.carrying && job.bolt.state === 'placed' && !S.support.fallen;
    case 'grab': return !a.carrying && shelfItems(S).length > 0;
    case 'hold': return !S.support.holders.size && (S.support.needed || S.support.fallen) && !S.support.standing;
    case 'assemble': return !a.carrying && S.items.some((it) => it.multi && (it.status === 'waiting' || it.status === 'building'));
  }
  return false;
}

// Bolt jobs on this side: put in needed bolts and fasten placed ones, nearest first.
function boltJob(S, a, taken, near = null) {
  if (S.support.fallen) return null;
  const reach = S.settings.reach - 3;
  let best = null, bd = Infinity;
  for (const b of S.bolts) {
    if (b.state !== 'needed' && b.state !== 'placed') continue;
    if (taken.has('bolt:' + b.id)) continue;
    if (near && !near(b)) continue;
    const q = reachSpot(S, a.side, b.x, b.y, reach);
    if (!q) continue;
    const d = dist(q.x, q.y, a.x, a.y) + (b.flashing ? -40 : 0);
    if (d < bd) { bd = d; best = { kind: b.state === 'needed' ? 'bolt' : 'fasten', key: 'bolt:' + b.id, bolt: b, spot: q, cost: d }; }
  }
  return best;
}
// Do a bolt job: walk there, then tap A (put in) or hold X (fasten).
function doBolt(S, a, job, base = NONE) {
  const b = job.bolt;
  const close = dist(b.x, b.y, a.x, a.y) <= S.settings.reach - 1;
  if (!close) return { ...base, ...goTo(S, a, job.spot.x, job.spot.y, 2) };
  if (job.kind === 'bolt') return { ...base, a: tapA(a) };
  return { ...base, x: true };
}

// All the jobs an NPC could do now on its side, cheapest first (cost ~ distance, minus urgency).
function jobs(S, a) {
  const out = [];
  const sup = S.support;
  const taken = new Set(S.actors.filter((o) => o !== a && o.npc && o.task).map((o) => o.task.key));
  const item = a.carrying && S.items.find((it) => it.id === a.carrying);
  if (item) {
    // Deliver it: to its spot if it goes in on this side, else to the river to pass it over.
    const spot = itemSpot(S, a.side, item, a);
    if (spot) out.push({ kind: 'deliver', key: 'item:' + item.id, item, spot, cost: -500 });
    else out.push({ kind: 'pass', key: 'item:' + item.id, item, spot: edgeSpot(S, a.side, itemBox(S, item) ? (itemBox(S, item).y0 + itemBox(S, item).y1) / 2 : a.y), cost: -500 });
    return out;
  }
  // Hold the bridge up if it needs it and nobody (or no other NPC on its way) is.
  if ((sup.needed || sup.fallen) && !sup.standing && !sup.holders.size && !taken.has('hold')) {
    const q = farHoldSpot(S, a);
    if (q) out.push({ kind: 'hold', key: 'hold', spot: q, cost: dist(q.x, q.y, a.x, a.y) - 2000 });
  }
  // Take a piece someone across the river is holding out, or is bringing to the river for this side.
  for (const o of S.actors) {
    if (o === a || o.side === a.side || !o.carrying) continue;
    const it = S.items.find((x) => x.id === o.carrying);
    if (!o.extending && (itemSpot(S, o.side, it, o) || !itemSpot(S, a.side, it, a))) continue;
    const q = edgeSpot(S, a.side, o.y);
    if (!taken.has('take:' + o.id)) out.push({ kind: 'take', key: 'take:' + o.id, from: o, spot: q, cost: dist(q.x, q.y, a.x, a.y) - 300 });
  }
  const bj = boltJob(S, a, taken);
  if (bj) out.push(bj);
  // Run the next ready piece, in build order, if it can go in now (or it's simply next).
  if (a.side === S.stagingSide && !taken.has('grab')) {
    const next = shelfItems(S)[0];
    const firstOpen = S.items.find((it) => it.status !== 'placed' && it.status !== 'carried');
    if (next && (placeableNow(S, next) || next === firstOpen)) {
      const r0 = S.ready;
      const q = clampPos(S, a.side, Math.max(r0.x + 6, Math.min(r0.x + r0.w - 6, a.x)), Math.max(r0.y + 6, Math.min(r0.y + r0.h - 6, a.y)));
      out.push({ kind: 'grab', key: 'grab', spot: q, cost: dist(q.x, q.y, a.x, a.y) + 30 });
    }
  }
  // Make assemblies (the assembler's main job; others pitch in when nothing's closer).
  if (a.side === S.stagingSide && S.items.some((it) => it.multi && (it.status === 'waiting' || it.status === 'building'))) {
    const z = S.assembly;
    const q = clampPos(S, a.side, Math.max(z.x + 8, Math.min(z.x + z.w - 8, a.x)), Math.max(z.y + 8, Math.min(z.y + z.h - 8, a.y)));
    out.push({ kind: 'assemble', key: 'asm:' + a.id, spot: q, cost: dist(q.x, q.y, a.x, a.y) + (a.npc === 'assembler' ? -1000 : 60) });
  }
  return out.sort((p, q) => p.cost - q.cost);
}

// Where an NPC waits with nothing to do: a staging yard once it's all built, else somewhere handy.
function idle(S, a) {
  if (S.allBuilt || S.items.every((it) => it.status === 'placed')) {
    const z = S.stageZones.filter((q) => S.sideOfX(q.x + q.w / 2) === a.side).sort((p, q) => Math.abs(p.x + p.w / 2 - a.x) - Math.abs(q.x + q.w / 2 - a.x))[0];
    if (z) { const p = clampPos(S, a.side, Math.max(z.x + 10, Math.min(z.x + z.w - 10, a.x)), Math.max(z.y + 10, Math.min(z.y + z.h - 10, a.y))); return { ...NONE, ...goTo(S, a, p.x, p.y) }; }
  }
  // Wait by the river, ready to take pieces across, if the pieces come from the other side.
  if (a.side !== S.stagingSide) { const q = edgeSpot(S, a.side, S.site.depth / 2); return { ...NONE, ...goTo(S, a, q.x, q.y, 10) }; }
  return NONE;
}

function npcThink(S, a, dt) {
  const sup = S.support;
  a.task = null;
  if (a.anchor?.locked) return NONE; // holding a buddy piece: someone else bolts it
  // Holding a piece in place: put in its bolts.
  if (a.anchor?.kind === 'piece') {
    const it = S.items.find((x) => x.id === a.anchor.itemId);
    const job = it && boltJob(S, a, new Set(), (b) => b.state === 'needed' && b.memberIds.some((id) => it.memberIds.includes(id)));
    if (job) { a.task = job; return doBolt(S, a, job); }
    return NONE;
  }
  // Holding the bridge: keep holding; move out when it grows, and bolt what's in reach meanwhile.
  if (sup.holders.has(a.id)) {
    const hold = { ...NONE, lb: true };
    const h = sup.holders.get(a.id);
    const far = farHoldSpot(S, a);
    if (far && h.stale >= 1 && dist(far.x, far.y, a.x, a.y) > 6) return { ...hold, ...goTo(S, a, far.x, far.y, 4) };
    let job = a.plan && S.t < a.planUntil && (a.plan.kind === 'bolt' || a.plan.kind === 'fasten') && stillOn(S, a, a.plan) ? a.plan : null;
    if (!job) {
      job = boltJob(S, a, new Set(S.actors.filter((o) => o !== a && o.npc && o.task).map((o) => o.task.key)),
        (b) => { const q = clampPos(S, a.side, b.x, b.y); return bridgeDist(S, q.x, q.y) <= HOLD_REACH - 2; });
      a.plan = job; a.planUntil = S.t + 0.3;
    }
    if (job) { a.task = job; return doBolt(S, a, job, hold); }
    if (far && dist(far.x, far.y, a.x, a.y) > 6) return { ...hold, ...goTo(S, a, far.x, far.y, 4) };
    return hold;
  }
  // The holder's main job until the bridge stands: be there to hold it.
  if (a.npc === 'holder' && !sup.standing) {
    if (sup.needed || sup.fallen) {
      const q = farHoldSpot(S, a);
      if (q) {
        a.task = { kind: 'hold', key: 'hold' };
        const g = goTo(S, a, q.x, q.y, 8);
        return { ...NONE, mx: g.mx, my: g.my, lb: g.there && !a.prev.lb };
      }
    }
    const fx = S.F.length ? S.toSite((S.F[S.startFooting][0] + S.F[S.startFooting][1]) / 2 + S.dir * 30, 0)[0] : a.x;
    const p = clampPos(S, a.side, fx, S.site.depth - 30);
    return { ...NONE, ...goTo(S, a, p.x, p.y, 8) };
  }
  // Everyone else (and the holder once the bridge stands): the nearest job going, chosen again a
  // few times a second (or as soon as the one in hand is done).
  let job = a.plan && S.t < a.planUntil && stillOn(S, a, a.plan) ? a.plan : null;
  if (!job) { job = jobs(S, a)[0] || null; a.plan = job; a.planUntil = S.t + 0.3; }
  if (!job) return idle(S, a);
  a.task = job;
  const there = (tol = 3) => dist(job.spot.x, job.spot.y, a.x, a.y) <= tol;
  switch (job.kind) {
    case 'deliver':
      if (canPlace(S, a, job.item)) return { ...NONE, a: tapA(a) };
      return { ...NONE, ...goTo(S, a, job.spot.x, job.spot.y, 2) };
    case 'pass':
      // At the river, hold it out (hold A) until someone takes it.
      // (right up to the water, so the pass reaches across)
      if (!there(0.5)) return { ...NONE, ...goTo(S, a, job.spot.x, job.spot.y, 0.2) };
      return { ...NONE, a: a.extending || tapA(a) };
    case 'take':
      if (passer(S, a)) return { ...NONE, a: tapA(a) }; // take whatever is held out to us
      return { ...NONE, ...goTo(S, a, job.spot.x, job.spot.y, 0.2) };
    case 'hold': {
      const g = goTo(S, a, job.spot.x, job.spot.y, 8);
      return { ...NONE, mx: g.mx, my: g.my, lb: g.there && !a.prev.lb };
    }
    case 'bolt': case 'fasten': return doBolt(S, a, job);
    case 'grab':
      if (inReady(S, a)) return { ...NONE, a: tapA(a) };
      return { ...NONE, ...goTo(S, a, job.spot.x, job.spot.y, 3) };
    case 'assemble':
      if (distToRect(a.x, a.y, S.assembly) <= STATION_REACH - 2 && assemblyFor(S, a)) return { ...NONE, x: true };
      return { ...NONE, ...goTo(S, a, job.spot.x, job.spot.y, 3) };
  }
  return NONE;
}

// ---------- results ----------
// Construction cost from the rules (6.2.5 in 2027): minutes x builders x $ per builder-minute,
// times the crew factor with enough builders; over the time limit counts as 180 minutes.
export function constructionCost(rules, seconds, builders) {
  const r = rules || {};
  if (!r.costPerBuilderMin) return null;
  const gamma = builders >= (r.crewFactorMinBuilders ?? Infinity) ? r.crewFactor ?? 1 : 1;
  const minutes = r.timeLimitMin && seconds > r.timeLimitMin * 60 ? 180 : seconds / 60;
  return minutes * builders * r.costPerBuilderMin * gamma;
}
export function results(S) {
  const time = S.finishT ?? S.t;
  const total = time + S.penalties;
  return {
    done: S.done, time, penalties: S.penalties, total, falls: S.falls, neglected: S.neglected,
    builders: S.actors.length, cost: constructionCost(S.project.site.rules, total, S.actors.length),
    players: S.actors.map((a) => ({ id: a.id, name: a.name, color: a.color, side: a.side, npc: a.npc, ...a.stats })),
  };
}
