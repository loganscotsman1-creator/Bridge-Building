// Plan helpers: "units" (a single member or an assembly that is carried and installed as one),
// where pieces start in the staging yard, and an automatic starting order.
import { uid } from './ids.js';
import { contact2d, pointInPoly, polyCentroid } from './geometry.js';

export const unitKey = (u) => (u.type === 'assembly' ? 'a:' : 'm:') + u.id;

// Every unit the plan has to install: assemblies, plus members that aren't in an assembly.
export function planUnits(model, plan) {
  const inAssembly = new Map();
  const units = [];
  for (const a of plan.assemblies) {
    const memberIds = a.memberIds.filter((id) => model.memberById.has(id) && !inAssembly.has(id));
    for (const id of memberIds) inAssembly.set(id, a.id);
    units.push({ type: 'assembly', id: a.id, key: 'a:' + a.id, name: a.name, memberIds, assembly: a });
  }
  for (const m of model.members) {
    if (inAssembly.has(m.id)) continue;
    units.push({ type: 'member', id: m.id, key: 'm:' + m.id, name: m.name, memberIds: [m.id] });
  }
  return { units, inAssembly };
}

export function unitCentroid(model, memberIds) {
  let x = 0, y = 0, z = 0, w = 0;
  for (const id of memberIds) {
    const m = model.memberById.get(id);
    if (!m) continue;
    x += m.centroid[0] * m.length; y += m.centroid[1] * m.length; z += m.centroid[2] * m.length; w += m.length;
  }
  return w ? [x / w, y / w, z / w] : [0, 0, 0];
}

// The area members start in: a "Members area" if the layout has one, else the first staging yard.
export function membersArea(site) {
  return site.zones.find((z) => z.type === 'members') || site.zones.find((z) => z.type === 'staging') || { x: 0, y: 0, w: site.width, h: site.depth };
}

// Starting spot of every member on the site. Members without a saved spot are laid out in rows
// inside the members area. When there are too many to fit side by side, the rows (and columns)
// are squeezed together so they overlap but all stay inside the area: it's only a rough model.
export function stagingSpots(project, model) {
  const site = project.site;
  const spots = new Map();
  const auto = model.members.filter((m) => !site.staging[m.id]);
  const longest = Math.max(12, ...model.members.map((m) => m.long));
  const deepest = Math.max(0, ...model.members.map((m) => m.wide));
  const area = membersArea(site);
  const margin = Math.min(4, area.w / 10, area.h / 10);
  const innerW = Math.max(0, area.w - 2 * margin), innerH = Math.max(0, area.h - 2 * margin);
  const colW = longest + 4;
  const cols = Math.max(1, Math.floor(innerW / colW));
  const rows = Math.max(1, Math.ceil(auto.length / cols));
  // Centers range over the area minus half a piece at each edge (or the middle if it's too small).
  const xSpan = Math.max(0, innerW - Math.min(longest, innerW)), ySpan = Math.max(0, innerH - Math.min(deepest, innerH));
  const colStep = cols > 1 ? Math.min(colW, xSpan / (cols - 1)) : 0;
  const rowStep = rows > 1 ? Math.min(Math.max(3, deepest + 1.5), ySpan / (rows - 1)) : 0;
  const x0 = area.x + area.w / 2 - (colStep * (cols - 1)) / 2;
  const y0 = area.y + margin + Math.min(deepest, innerH) / 2;
  auto.sort((a, b) => a.plane.localeCompare(b.plane) || a.name.localeCompare(b.name, undefined, { numeric: true }));
  auto.forEach((m, i) => {
    const col = i % cols, row = Math.floor(i / cols);
    spots.set(m.id, { x: x0 + col * colStep, y: y0 + row * rowStep, rot: flatRot(m), auto: true });
  });
  for (const m of model.members) if (site.staging[m.id]) spots.set(m.id, { rot: flatRot(m), ...site.staging[m.id] });
  return spots;
}

// A member lies flat in the yard. Most show their outline from the side or top view; one that's
// longest out of its view lies as a plain long × wide rectangle.
const liesAsBar = (m) => m.thick > Math.max(m.len, m.depth);
// The rotation that lines its long side up with the yard.
export const flatRot = (m) => (liesAsBar(m) ? 0 : m.angle || 0);

// Where a point of the member's outline lies, before rotating, relative to the member's center.
function flatPoint(m, p) {
  if (liesAsBar(m)) return [0, 0];
  const c = polyCentroid(m.poly);
  return [p[0] - c[0], -(p[1] - c[1])];
}

// The member's outline on the site at a staging spot {x, y, rot (degrees)}.
export function stagedPoly(m, spot) {
  let base;
  if (liesAsBar(m)) {
    const hl = m.long / 2, hw = m.wide / 2;
    base = [[-hl, -hw], [hl, -hw], [hl, hw], [-hl, hw]];
  } else base = m.poly.map((p) => flatPoint(m, p));
  const a = ((spot.rot ?? flatRot(m)) * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  return base.map(([x, y]) => [spot.x + x * c - y * s, spot.y + x * s + y * c]);
}

// Do two staged outlines touch? Returns a point where they do, or null.
export function stagedTouch(P, Q, tol = 0.5) {
  const hit = contact2d(P, Q);
  if (hit) return hit.kind === 'edge' ? [(hit.seg[0][0] + hit.seg[1][0]) / 2, (hit.seg[0][1] + hit.seg[1][1]) / 2] : polyCentroid(hit.poly);
  for (const p of P) if (pointInPoly(p, Q, tol)) return p;
  for (const p of Q) if (pointInPoly(p, P, tol)) return p;
  return null;
}

// Every connection inside each assembly, and whether its members are placed touching in the yard
// (members still stacked automatically don't count).
export function assemblyConnections(project, model, plan, spots = stagingSpots(project, model)) {
  return plan.assemblies.map((a) => {
    const ids = new Set(a.memberIds.filter((id) => model.memberById.has(id)));
    const joints = model.contacts.filter((c) => ids.has(c.a) && ids.has(c.b)).map((joint) => {
      const sa = spots.get(joint.a), sb = spots.get(joint.b);
      const at = sa && sb && !sa.auto && !sb.auto ? stagedTouch(stagedPoly(model.memberById.get(joint.a), sa), stagedPoly(model.memberById.get(joint.b), sb)) : null;
      return { joint, touching: !!at, at };
    });
    return { assembly: a, joints };
  });
}

// Lay an assembly's members out in the yard the way they go together, touching where they bolt,
// in the first free space of the members area. Mutates project.site.staging.
export function layOutAssembly(project, model, assembly) {
  const site = project.site;
  const ids = assembly.memberIds.filter((id) => model.memberById.has(id));
  if (!ids.length) return false;
  // Walk the connections out from the first member, lining up each next one on their shared point.
  const pos = new Map([[ids[0], [0, 0]]]);
  let grew = true;
  const midOf = (c) => (c.kind === 'edge' ? [(c.seg[0][0] + c.seg[1][0]) / 2, (c.seg[0][1] + c.seg[1][1]) / 2] : polyCentroid(c.poly));
  // A connection found in the top view only knows a side-view member's position along the span.
  const pointOn = (m, c) => { const p = midOf(c); return (c.plane === 'L') !== (m.plane === 'L') ? [p[0], m.v] : p; };
  while (grew) {
    grew = false;
    for (const c of model.contacts) {
      if (!ids.includes(c.a) || !ids.includes(c.b) || pos.has(c.a) === pos.has(c.b)) continue;
      const [from, to] = pos.has(c.a) ? [c.a, c.b] : [c.b, c.a];
      const mf = model.memberById.get(from), mt = model.memberById.get(to);
      const pf = flatPoint(mf, pointOn(mf, c)), pt = flatPoint(mt, pointOn(mt, c));
      const o = pos.get(from);
      pos.set(to, [o[0] + pf[0] - pt[0], o[1] + pf[1] - pt[1]]);
      grew = true;
    }
  }
  // Anything not connected goes alongside.
  let spare = 0;
  for (const id of ids) if (!pos.has(id)) pos.set(id, [0, (spare += 8)]);

  const shapes = ids.map((id) => stagedPoly(model.memberById.get(id), { x: pos.get(id)[0], y: pos.get(id)[1], rot: 0 }));
  const xs = shapes.flat().map((p) => p[0]), ys = shapes.flat().map((p) => p[1]);
  const w = Math.max(...xs) - Math.min(...xs), h = Math.max(...ys) - Math.min(...ys);
  const area = membersArea(site);
  const taken = model.members.filter((m) => site.staging[m.id] && !ids.includes(m.id)).map((m) => {
    const q = stagedPoly(m, { rot: flatRot(m), ...site.staging[m.id] });
    return [Math.min(...q.map((p) => p[0])), Math.min(...q.map((p) => p[1])), Math.max(...q.map((p) => p[0])), Math.max(...q.map((p) => p[1]))];
  });
  const free = (x, y) => !taken.some((b) => x < b[2] + 1 && x + w > b[0] - 1 && y < b[3] + 1 && y + h > b[1] - 1);
  let at = null;
  for (let y = area.y + 1; !at && y + h <= area.y + area.h - 1 + 1e-6; y += 3) {
    for (let x = area.x + 1; !at && x + w <= area.x + area.w - 1 + 1e-6; x += 3) if (free(x, y)) at = [x, y];
  }
  const fits = !!at;
  if (!at) at = [area.x + area.w / 2 - w / 2, area.y + area.h / 2 - h / 2];
  const dx = at[0] - Math.min(...xs), dy = at[1] - Math.min(...ys);
  for (const id of ids) site.staging[id] = { x: Math.round((pos.get(id)[0] + dx) * 100) / 100, y: Math.round((pos.get(id)[1] + dy) * 100) / 100, rot: 0 };
  return fits;
}

const PLANE_ORDER = { A: 0, B: 1, L: 2 };

// A reasonable first guess that follows the rules: start with pieces standing on a footing (each
// constructed portion starts on a footing), then keep adding the westernmost piece that touches
// something already placed — trusses before laterals, bottom to top, truss A before B.
export function autoOrderSteps(model, plan) {
  const { units, inAssembly } = planUnits(model, plan);
  const unitOf = (memberId) => (inAssembly.has(memberId) ? 'a:' + inAssembly.get(memberId) : 'm:' + memberId);
  const info = new Map(units.map((u) => {
    const c = unitCentroid(model, u.memberIds);
    const ms = u.memberIds.map((id) => model.memberById.get(id)).filter(Boolean);
    return [u.key, { u, x: Math.round(c[0] / 6), z: c[2], lateral: ms.every((m) => m.plane === 'L') ? 1 : 0, plane: PLANE_ORDER[ms[0]?.plane] ?? 3, footing: ms.some((m) => m.bearing) }];
  }));
  const touches = new Map(units.map((u) => [u.key, new Set()]));
  for (const c of model.contacts) {
    const a = unitOf(c.a), b = unitOf(c.b);
    if (a !== b && touches.has(a) && touches.has(b)) { touches.get(a).add(b); touches.get(b).add(a); }
  }
  const better = (p, q) => p.x - q.x || p.lateral - q.lateral || p.z - q.z || p.plane - q.plane;
  const placed = new Set();
  const order = [];
  while (order.length < units.length) {
    let pick = null;
    for (const it of info.values()) {
      if (placed.has(it.u.key)) continue;
      const reachable = it.footing || [...touches.get(it.u.key)].some((k) => placed.has(k));
      if (!reachable) continue;
      if (!pick || better(it, pick) < 0) pick = it;
    }
    // Nothing connects any more (e.g. a piece touching nothing): fall back to west-to-east.
    if (!pick) for (const it of info.values()) if (!placed.has(it.u.key) && (!pick || better(it, pick) < 0)) pick = it;
    placed.add(pick.u.key);
    order.push(pick.u);
  }
  const steps = [];
  for (const u of order) if (u.type === 'assembly') steps.push({ id: uid('s'), kind: 'build', assemblyId: u.id, builder: 'auto' });
  for (const u of order) steps.push(installStep(u));
  return steps;
}

export function installStep(u) {
  return { id: uid('s'), kind: 'install', unit: { type: u.type, id: u.id }, carrier: 'auto', fastener: 'auto' };
}

export function stepLabel(step, model, plan, project) {
  if (step.kind === 'install') {
    if (step.unit.type === 'assembly') {
      const a = plan.assemblies.find((x) => x.id === step.unit.id);
      return 'Install ' + (a ? a.name : '(missing assembly)');
    }
    const m = model.memberById.get(step.unit.id);
    return 'Install ' + (m ? m.name : '(missing member)');
  }
  if (step.kind === 'build') {
    const a = plan.assemblies.find((x) => x.id === step.assemblyId);
    return 'Assemble ' + (a ? a.name : '(missing assembly)') + ' in the staging yard';
  }
  if (step.kind === 'support') {
    const tool = project.tools.find((t) => t.id === step.toolId);
    const m = model.memberById.get(step.memberId);
    return (step.action === 'remove' ? 'Remove ' : 'Place ') + (tool ? tool.name : 'support') + ' under ' + (m ? m.name : '(missing member)');
  }
  if (step.kind === 'fasten') {
    const m = step.scope && step.scope !== 'all' ? model.memberById.get(step.scope) : null;
    return 'Come back and fasten inserted bolts' + (m ? ' on ' + m.name : '');
  }
  return step.kind;
}

// One step of a plan, in words.
export const taskUnitKey = (task) => (task.unit ? unitKey(task.unit) : null);

export function taskLabel(task, model, plan, project) {
  const unitName = () => {
    if (!task.unit) return '(no piece)';
    if (task.unit.type === 'assembly') return plan.assemblies.find((a) => a.id === task.unit.id)?.name || '(missing assembly)';
    return model.memberById.get(task.unit.id)?.name || '(missing member)';
  };
  const memberName = () => model.memberById.get(task.member)?.name || '(missing member)';
  const n = (task.boltIds || []).length;
  const joint = task.jointId && model.contacts.find((c) => c.id === task.jointId);
  const place = { bridge: 'at the bridge', staging: 'in the staging yard', hand: 'while it is carried' }[task.where] || '';
  const tool = () => project.tools.find((t) => t.id === task.toolId)?.name || '(missing tool)';
  switch (task.kind) {
    case 'run': return `Run ${unitName()} to the river`;
    case 'receive': return (plan.tasks || []).some((x) => x.kind === 'run' && x.unit && x.unit.type === task.unit?.type && x.unit.id === task.unit?.id) ? `Receive ${unitName()} and run it to its place` : `Run ${unitName()} to its place`;
    case 'support': return `Support ${memberName()} ${task.until === 'auto' || task.until == null ? 'until it stands' : `for ${task.until} s`}`;
    case 'bolt': return `Place ${n} bolt${n === 1 ? '' : 's'} in ${memberName()}${joint ? ` (${jointLabel(model, joint)})` : ''} ${place}`;
    case 'nut': return `Fasten ${n} nut${n === 1 ? '' : 's'}${joint ? `: ${jointLabel(model, joint)}` : ''} ${place}`;
    case 'tool': return `Assemble ${tool()}`;
    case 'pass': return `Pass ${tool()} to ${project.builders.find((b) => b.id === task.to)?.name || '(missing builder)'}`;
    case 'other': return task.text || 'Other task';
    case 'stand': return `${task.action === 'remove' ? 'Remove' : 'Place'} ${tool()} under ${memberName()}`;
    default: return task.kind;
  }
}

// Which side of the river a spot is on ('west' or 'east'), or null if the site has no river.
export function sideOf(site, p) {
  const river = site.zones.find((z) => z.type === 'nogo');
  if (!river) return null;
  return p.x < river.x + river.w / 2 ? 'west' : 'east';
}

export function jointLabel(model, joint) {
  const a = model.memberById.get(joint.a), b = model.memberById.get(joint.b);
  return `${a ? a.name : '?'} ↔ ${b ? b.name : '?'}`;
}
