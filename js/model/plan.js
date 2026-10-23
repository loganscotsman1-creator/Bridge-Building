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

// Starting spot of every member on the site. Members without a saved spot are laid out in rows
// inside the first staging zone.
export function stagingSpots(project, model) {
  const site = project.site;
  const spots = new Map();
  const zone = site.zones.find((z) => z.type === 'staging');
  const auto = model.members.filter((m) => !site.staging[m.id]);
  const colW = 48, rowH = 8;
  const area = zone || { x: 0, y: 0, w: site.width, h: site.depth };
  const cols = Math.max(1, Math.floor((area.w - 6) / colW));
  auto.sort((a, b) => a.plane.localeCompare(b.plane) || a.name.localeCompare(b.name, undefined, { numeric: true }));
  auto.forEach((m, i) => {
    const col = i % cols, row = Math.floor(i / cols);
    spots.set(m.id, { x: area.x + 6 + col * colW + (colW - 6) / 2, y: area.y + 10 + row * rowH, auto: true });
  });
  for (const m of model.members) if (site.staging[m.id]) spots.set(m.id, { ...site.staging[m.id] });
  return spots;
}

const PLANE_ORDER = { A: 0, B: 1, L: 2 };

// A reasonable first guess: work from x = 0 toward the far end, bottom to top, truss A, then B, then laterals.
export function autoOrderSteps(model, plan) {
  const { units } = planUnits(model, plan);
  const info = units.map((u) => {
    const c = unitCentroid(model, u.memberIds);
    const m0 = model.memberById.get(u.memberIds[0]);
    return { u, x: Math.round(c[0] / 6), z: c[2], plane: PLANE_ORDER[m0?.plane] ?? 3 };
  });
  info.sort((a, b) => a.x - b.x || a.z - b.z || a.plane - b.plane);
  const steps = [];
  for (const { u } of info) {
    if (u.type === 'assembly') steps.push({ id: uid('s'), kind: 'build', assemblyId: u.id, builder: 'auto' });
  }
  for (const { u } of info) steps.push(installStep(u));
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
    return 'Build ' + (a ? a.name : '(missing assembly)') + ' on the ground';
  }
  if (step.kind === 'support') {
    const tool = project.tools.find((t) => t.id === step.toolId);
    return (step.action === 'remove' ? 'Remove ' : 'Place ') + (tool ? tool.name : 'support') + ' at ' + nodeLabel(model, step.nodeId);
  }
  return step.kind;
}

export function nodeLabel(model, nodeId) {
  const n = model.nodes.get(nodeId);
  if (!n) return '(missing node)';
  const r = (v) => Math.round(v * 10) / 10;
  return `${n.plane === 'L' ? 'lateral' : 'truss ' + n.plane} x=${r(n.x)} z=${r(n.z)}${n.plane === 'L' ? ' y=' + r(n.y) : ''}`;
}
