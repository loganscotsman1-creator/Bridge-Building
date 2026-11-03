// Where everything is at time t, for drawing the animation.
import { pointAlong, polyLength } from './grid.js';

function lastAt(list, t) {
  let out = null;
  for (const e of list) { if (e.t <= t + 1e-9) out = e; else break; }
  return out;
}

export function indexResult(result) {
  if (result._index) return result._index;
  const byBuilder = new Map();
  for (const s of result.segments) {
    if (!byBuilder.has(s.builderId)) byBuilder.set(s.builderId, []);
    byBuilder.get(s.builderId).push(s);
  }
  for (const list of byBuilder.values()) list.sort((a, b) => a.t0 - b.t0 || a.t1 - b.t1);
  for (const list of result.tracks.values()) list.sort((a, b) => a.t - b.t);
  for (const list of result.unitStatus.values()) list.sort((a, b) => a.t - b.t);
  result._index = { byBuilder };
  return result._index;
}

export function stateAt(result, t) {
  const { byBuilder } = indexResult(result);
  const builders = result.builders.map((b) => {
    const list = byBuilder.get(b.id) || [];
    let pos = { x: b.start.x, y: b.start.y }, kind = 'idle', label = 'Idle', seg = null, dir = 0;
    for (const s of list) {
      if (s.t0 > t) break;
      seg = s;
      if (s.path) {
        const end = s.path[s.path.length - 1];
        pos = { x: end.x, y: end.y };
      } else pos = { x: s.x, y: s.y };
    }
    if (seg && t <= seg.t1) {
      kind = seg.kind;
      label = seg.label || kind;
      if (seg.path) {
        const total = polyLength(seg.path);
        const f = seg.t1 > seg.t0 ? (t - seg.t0) / (seg.t1 - seg.t0) : 1;
        const p = pointAlong(seg.path, total * f);
        pos = { x: p.x, y: p.y };
        dir = p.dir;
      }
    }
    return { ...b, x: pos.x, y: pos.y, kind, label, dir, seg: seg && t <= seg.t1 ? seg : null };
  });
  const builderPos = new Map(builders.map((b) => [b.id, b]));

  const working = new Set();
  for (const s of result.segments) if ((s.kind === 'align' || s.kind === 'fasten' || s.kind === 'insert') && s.t0 <= t && t < s.t1 && s.unitKey) working.add(s.unitKey);

  const members = new Map();
  for (const [id, list] of result.tracks) {
    const e = lastAt(list, t) || list[0];
    let x = e.x, y = e.y, status = null, holderDir = 0;
    if (e.kind === 'carried') {
      const b = builderPos.get(e.builderId);
      x = b.x; y = b.y; holderDir = b.dir;
    } else if (e.kind === 'bridge') {
      const key = result.unitOfMember.get(id);
      const st = lastAt(result.unitStatus.get(key) || [], t);
      status = working.has(key) ? 'working' : st ? st.status : 'held';
    }
    members.set(id, { loc: e.kind, x, y, status, dir: holderDir, builderId: e.builderId });
  }

  const supports = new Map();
  for (const ev of result.supportEvents) {
    if (ev.t > t) continue;
    if (ev.action === 'place') supports.set(ev.key, ev);
    else supports.delete(ev.key);
  }
  // Bolts: where each one is in its life, and how many each builder has used so far.
  const bolts = new Map();
  const used = new Map();
  for (const e of result.boltEvents || []) {
    if (e.t0 > t) continue;
    if (e.kind !== 'tighten') used.set(e.builderId, (used.get(e.builderId) || 0) + 1);
    if (t >= e.t1) { bolts.set(e.boltId, { state: e.kind === 'insert' ? 'inserted' : 'fastened', at: e.at }); continue; }
    // A new bolt travels from the builder's hand for the first half, then gets fastened in place.
    const f = (t - e.t0) / Math.max(1e-6, e.t1 - e.t0);
    if (e.kind !== 'tighten' && f < 0.5) bolts.set(e.boltId, { state: 'moving', f: f * 2, from: e.from, at: e.at, builderId: e.builderId });
    else bolts.set(e.boltId, { state: 'working', at: e.at, builderId: e.builderId });
  }
  let fastened = 0, inserted = 0;
  for (const b of bolts.values()) { if (b.state === 'fastened') fastened++; else if (b.state === 'inserted') inserted++; }
  for (const b of builders) b.boltsUsedNow = used.get(b.id) || 0;
  return { t, builders, members, supports: [...supports.values()], bolts, boltCounts: { fastened, inserted } };
}
