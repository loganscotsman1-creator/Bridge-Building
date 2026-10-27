// Editing helpers that keep the project consistent (deleting a member also removes its bolts and
// the plan steps that referred to it). All of these mutate the project passed in, so call them
// inside updateProject(p => ...).
import { MIRROR_SUFFIX, uid } from './ids.js';
import { boxLimits } from './schema.js';
import { polyCentroid, rectOfPoly } from './geometry.js';

const baseId = (id) => (id.endsWith(MIRROR_SUFFIX) ? id.slice(0, -MIRROR_SUFFIX.length) : id);

export function removeMemberRefs(project, memberIds) {
  const ids = new Set(memberIds);
  for (const id of memberIds) ids.add(id + MIRROR_SUFFIX);
  for (const plan of project.plans) {
    for (const a of plan.assemblies) a.memberIds = a.memberIds.filter((m) => !ids.has(m));
    plan.steps = plan.steps.filter((s) => !(s.kind === 'install' && s.unit.type === 'member' && ids.has(s.unit.id)) && !(s.kind === 'support' && ids.has(s.memberId)));
  }
  for (const id of ids) delete project.site.staging[id];
}

export function removeMember(project, memberId) {
  const d = project.design;
  const gone = new Set([memberId, memberId + MIRROR_SUFFIX]);
  d.members = d.members.filter((m) => m.id !== memberId);
  d.bolts = d.bolts.filter((b) => !gone.has(b.a) && !gone.has(b.b));
  removeMemberRefs(project, [memberId]);
}

export function removeBolt(project, boltId) {
  const d = project.design;
  d.bolts = d.bolts.filter((b) => b.id !== baseId(boltId));
}

export function nextMemberName(project, plane) {
  const prefix = plane === 'L' ? 'L-' : plane + '-';
  let n = 1;
  const names = new Set(project.design.members.map((m) => m.name));
  while (names.has(prefix + n)) n++;
  return prefix + n;
}

// A new box member at its full allowed size (it can be made smaller, never bigger).
export function newBox(project, plane, u, v, angle = 0, extra = {}) {
  const lim = boxLimits(project);
  return { id: uid('m'), name: nextMemberName(project, plane), plane, u, v, angle, len: lim.len, depth: lim.depth, thick: lim.thick, z: 0, ...extra };
}

export function duplicateMember(project, memberId, du = 0, dv = 0) {
  const m = project.design.members.find((x) => x.id === memberId);
  if (!m) return null;
  const copy = { ...m, id: uid('m'), name: nextMemberName(project, m.plane), u: m.u + du, v: m.v + dv };
  if (m.corners) copy.corners = m.corners.map(([u, v]) => [u + du, v + dv]);
  project.design.members.push(copy);
  return copy.id;
}

// Turn a reshaped member back into a plain rectangle (its tightest enclosing rectangle).
export function squareUp(project, m) {
  if (!m.corners) return m;
  Object.assign(m, rectOfPoly(m.corners));
  delete m.corners;
  return clampBox(project, m);
}

// Keep a box within the rule limits (only ever shrinks).
export function clampBox(project, m) {
  const lim = boxLimits(project);
  m.len = Math.min(lim.len, Math.max(0.5, m.len));
  m.depth = Math.min(lim.depth, Math.max(0.25, m.depth));
  m.thick = Math.min(lim.thick, Math.max(0.125, m.thick));
  return m;
}

// Turning mirroring off: write the generated truss-B copies into the design (same ids, so
// laterals and plans that refer to them keep working) so they can be edited on their own.
export function materializeMirror(project, model) {
  const d = project.design;
  for (const m of model.members) {
    if (!m.mirrorOf || d.members.some((x) => x.id === m.id)) continue;
    const src = d.members.find((x) => x.id === m.mirrorOf);
    d.members.push({ ...src, id: m.id, name: m.name, plane: 'B' });
  }
  for (const b of model.bolts) {
    if (b.plane === 'B' && b.id.endsWith(MIRROR_SUFFIX) && !d.bolts.some((x) => x.id === b.id)) {
      d.bolts.push({ id: b.id, plane: 'B', a: b.a, b: b.b, u: b.u, v: b.v });
    }
  }
  d.mirrorB = false;
}

// Turning mirroring on: drop the stored truss-B pieces; copies of truss A replace them.
export function enableMirror(project) {
  const d = project.design;
  const bMembers = d.members.filter((m) => m.plane === 'B').map((m) => m.id);
  const gone = new Set(bMembers);
  d.members = d.members.filter((m) => m.plane !== 'B');
  d.bolts = d.bolts.filter((b) => b.plane !== 'B' && !(gone.has(b.a) && !b.a.endsWith(MIRROR_SUFFIX)) && !(gone.has(b.b) && !b.b.endsWith(MIRROR_SUFFIX)));
  removeMemberRefs(project, bMembers.filter((id) => !id.endsWith(MIRROR_SUFFIX)));
  d.mirrorB = true;
}

// Give every connection on this view's plane that has no bolt `count` bolts, spread along the
// touching edge (or in the middle of an overlap). Returns how many were added.
export function autoBolts(project, model, plane, count) {
  const d = project.design;
  const editable = new Set(d.members.map((m) => m.id));
  let added = 0;
  for (const c of model.contacts) {
    if (c.plane !== plane || c.bolts > 0) continue;
    // Truss B mirror copies get their bolts from truss A.
    if (!editable.has(c.a) && !editable.has(c.b)) continue;
    const pts = [];
    if (c.kind === 'edge') {
      const [p, q] = c.seg;
      for (let i = 0; i < count; i++) {
        const t = (i + 1) / (count + 1);
        pts.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
      }
    } else {
      const [cx, cy] = polyCentroid(c.poly);
      // Spread along the longer direction of the overlap.
      const xs = c.poly.map((p) => p[0]), ys = c.poly.map((p) => p[1]);
      const wide = Math.max(...xs) - Math.min(...xs) >= Math.max(...ys) - Math.min(...ys);
      const span = wide ? Math.max(...xs) - Math.min(...xs) : Math.max(...ys) - Math.min(...ys);
      for (let i = 0; i < count; i++) {
        const off = count === 1 ? 0 : (i / (count - 1) - 0.5) * span * 0.5;
        pts.push(wide ? [cx + off, cy] : [cx, cy + off]);
      }
    }
    for (const [u, v] of pts) {
      d.bolts.push({ id: uid('b'), plane, a: c.a, b: c.b, u: Math.round(u * 100) / 100, v: Math.round(v * 100) / 100 });
      added++;
    }
  }
  return added;
}
