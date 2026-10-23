// Editing helpers that keep the project consistent (deleting a node also removes the member
// segments, bolts and plan references that depended on it). All of these mutate the project
// passed in, so call them inside updateProject(p => ...).
import { MIRROR_SUFFIX, uid } from './ids.js';

const baseId = (id) => (id.endsWith(MIRROR_SUFFIX) ? id.slice(0, -MIRROR_SUFFIX.length) : id);

export function removeMemberRefs(project, memberIds) {
  const ids = new Set(memberIds);
  for (const id of memberIds) ids.add(id + MIRROR_SUFFIX);
  for (const plan of project.plans) {
    for (const a of plan.assemblies) a.memberIds = a.memberIds.filter((m) => !ids.has(m));
    plan.steps = plan.steps.filter((s) => !(s.kind === 'install' && s.unit.type === 'member' && ids.has(s.unit.id)));
  }
  for (const id of ids) delete project.site.staging[id];
}

export function removeMember(project, memberId) {
  const d = project.design;
  d.members = d.members.filter((m) => m.id !== memberId);
  d.bolts = d.bolts.filter((b) => b.memberId !== memberId);
  removeMemberRefs(project, [memberId]);
}

export function removeBolt(project, boltId) {
  const d = project.design;
  d.bolts = d.bolts.filter((b) => b.id !== baseId(boltId));
}

export function removeNode(project, nodeId) {
  const d = project.design;
  const gone = new Set([nodeId, nodeId + MIRROR_SUFFIX]);
  d.nodes = d.nodes.filter((n) => n.id !== nodeId);
  const emptied = [];
  for (const m of d.members) {
    const keep = [];
    const remap = new Map();
    m.segments.forEach((seg, i) => {
      if (gone.has(seg[0]) || gone.has(seg[1])) return;
      remap.set(i, keep.length);
      keep.push(seg);
    });
    if (keep.length === m.segments.length) continue;
    d.bolts = d.bolts
      .filter((b) => b.memberId !== m.id || remap.has(b.seg))
      .map((b) => (b.memberId === m.id ? { ...b, seg: remap.get(b.seg) } : b));
    m.segments = keep;
    if (!keep.length) emptied.push(m.id);
  }
  for (const id of emptied) removeMember(project, id);
  for (const plan of project.plans) plan.steps = plan.steps.filter((s) => !(s.kind === 'support' && gone.has(s.nodeId)));
}

// Turning mirroring off: write the generated truss-B copies into the design (same ids, so laterals,
// bolts and plans that refer to them keep working) so they can be edited on their own.
export function materializeMirror(project, model) {
  const d = project.design;
  for (const n of model.nodes.values()) {
    if (n.mirrorOf && !d.nodes.some((x) => x.id === n.id)) {
      const { mirrorOf, ...rest } = n;
      d.nodes.push(rest);
    }
  }
  for (const m of d.members.filter((x) => x.plane === 'A')) {
    const id = m.id + MIRROR_SUFFIX;
    if (d.members.some((x) => x.id === id)) continue;
    const mm = model.memberById.get(id);
    d.members.push({ ...m, id, name: mm ? mm.name : m.name + ' (B)', plane: 'B', segments: m.segments.map(([a, b]) => [a + MIRROR_SUFFIX, b + MIRROR_SUFFIX]) });
    for (const b of d.bolts.filter((x) => x.memberId === m.id)) d.bolts.push({ ...b, id: b.id + MIRROR_SUFFIX, memberId: id });
  }
  d.mirrorB = false;
}

// Turning mirroring on: drop the stored truss-B pieces; copies of truss A replace them.
export function enableMirror(project) {
  const d = project.design;
  const bMembers = d.members.filter((m) => m.plane === 'B').map((m) => m.id);
  d.members = d.members.filter((m) => m.plane !== 'B');
  d.bolts = d.bolts.filter((b) => !bMembers.includes(b.memberId));
  d.nodes = d.nodes.filter((n) => n.plane !== 'B');
  // References to mirrored ids (x~B) stay valid; references to hand-drawn B pieces are removed.
  removeMemberRefs(project, bMembers.filter((id) => !id.endsWith(MIRROR_SUFFIX)));
  d.mirrorB = true;
}

export function nextMemberName(project, plane) {
  const prefix = plane === 'L' ? 'L-' : plane + '-';
  let n = 1;
  const names = new Set(project.design.members.map((m) => m.name));
  while (names.has(prefix + n)) n++;
  return prefix + n;
}

export function newNode(plane, x, y, z) {
  return { id: uid('n'), plane, x, y, z, bearing: false };
}

// Put a new joint partway along a segment (fraction t from its first node), splitting it in two.
// Bolts stay where they were.
export function splitSegment(project, memberId, segIndex, nodeId, t) {
  const m = project.design.members.find((x) => x.id === memberId);
  const [a, b] = m.segments[segIndex];
  m.segments.splice(segIndex, 1, [a, nodeId], [nodeId, b]);
  for (const bolt of project.design.bolts) {
    if (bolt.memberId !== memberId) continue;
    if (bolt.seg > segIndex) bolt.seg += 1;
    else if (bolt.seg === segIndex) {
      if (bolt.s <= t) bolt.s = t ? bolt.s / t : 0;
      else { bolt.seg += 1; bolt.s = (bolt.s - t) / (1 - t); }
    }
  }
}

// Move one segment (and its bolts) from one member to another. A member left with no
// segments is deleted.
export function moveSegment(project, fromId, segIndex, toId) {
  const d = project.design;
  const from = d.members.find((x) => x.id === fromId);
  const to = d.members.find((x) => x.id === toId);
  if (!from || !to || from === to) return;
  const [seg] = from.segments.splice(segIndex, 1);
  const newIndex = to.segments.length;
  to.segments.push(seg);
  for (const bolt of d.bolts) {
    if (bolt.memberId !== fromId) continue;
    if (bolt.seg === segIndex) { bolt.memberId = toId; bolt.seg = newIndex; }
    else if (bolt.seg > segIndex) bolt.seg -= 1;
  }
  if (!from.segments.length) removeMember(project, fromId);
}

// Take one segment out of its member into a member of its own; returns the new member's id.
export function detachSegment(project, memberId, segIndex) {
  const m = project.design.members.find((x) => x.id === memberId);
  if (!m) return null;
  if (m.segments.length === 1) return memberId;
  const id = uid('m');
  project.design.members.push({ id, name: nextMemberName(project, m.plane), plane: m.plane, segments: [] });
  moveSegment(project, memberId, segIndex, id);
  return id;
}

// Give every member end that meets another member `perEnd` bolts, counting bolts that are
// already there.
export function autoBolts(project, model, plane, perEnd) {
  const d = project.design;
  const touching = new Map();
  for (const m of model.members) for (const n of m.nodeIds) touching.set(n, (touching.get(n) || 0) + 1);
  let added = 0;
  for (const m of d.members) {
    if (m.plane !== plane) continue;
    const mm = model.memberById.get(m.id);
    if (!mm) continue;
    const ends = new Map(); // nodeId -> [{seg, atStart, len}]
    m.segments.forEach(([a, b], seg) => {
      const pa = model.nodes.get(a), pb = model.nodes.get(b);
      if (!pa || !pb) return;
      const len = Math.hypot(pb.x - pa.x, pb.y - pa.y, pb.z - pa.z);
      for (const [n, atStart] of [[a, true], [b, false]]) {
        if (!ends.has(n)) ends.set(n, []);
        ends.get(n).push({ seg, atStart, len });
      }
    });
    for (const [n, list] of ends) {
      if ((touching.get(n) || 0) - 1 <= 0) continue; // nothing else connects here
      const have = d.bolts.filter((b) => b.memberId === m.id && (b.s < 0.5 ? m.segments[b.seg]?.[0] : m.segments[b.seg]?.[1]) === n).length;
      const { seg, atStart, len } = list[0];
      for (let i = have; i < perEnd; i++) {
        const off = Math.min(0.45, (1.5 + 1.5 * i) / Math.max(1, len));
        d.bolts.push({ id: uid('b'), memberId: m.id, seg, s: atStart ? off : 1 - off });
        added++;
      }
    }
  }
  return added;
}
