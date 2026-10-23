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
