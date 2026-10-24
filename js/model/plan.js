// Plan helpers: "units" (a single member or an assembly that is carried and installed as one),
// where pieces start in the staging yard, and an automatic starting order.
import { uid } from './ids.js';

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
// inside the members area.
export function stagingSpots(project, model) {
  const site = project.site;
  const spots = new Map();
  const auto = model.members.filter((m) => !site.staging[m.id]);
  const longest = Math.max(12, ...model.members.map((m) => m.len));
  const colW = longest + 4;
  const rowH = Math.max(3, Math.max(0, ...model.members.map((m) => m.depth)) + 1.5);
  const area = membersArea(site);
  const cols = Math.max(1, Math.floor((area.w - 6) / colW));
  auto.sort((a, b) => a.plane.localeCompare(b.plane) || a.name.localeCompare(b.name, undefined, { numeric: true }));
  auto.forEach((m, i) => {
    const col = i % cols, row = Math.floor(i / cols);
    spots.set(m.id, { x: area.x + 4 + col * colW + colW / 2, y: area.y + 6 + row * rowH, auto: true });
  });
  for (const m of model.members) if (site.staging[m.id]) spots.set(m.id, { ...site.staging[m.id] });
  return spots;
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
  return step.kind;
}

export function jointLabel(model, joint) {
  const a = model.memberById.get(joint.a), b = model.memberById.get(joint.b);
  return `${a ? a.name : '?'} ↔ ${b ? b.name : '?'}`;
}
