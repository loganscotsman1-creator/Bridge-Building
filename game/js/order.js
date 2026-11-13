// The build order: the list of assemblies and single pieces, in the order they become available
// in the ready area. Each item is {id, memberIds, buddy, time}:
//   buddy – large or awkward: whoever carries it into place can only hold it there, and someone
//           else has to bolt it
//   time  – seconds to make the assembly (null = worked out from the project's timing)
import { buildModel, footingRanges } from '../../js/model/geometry.js';
import { activePlan } from '../../js/model/schema.js';
import { autoOrderSteps, planUnits } from '../../js/model/plan.js';

const ORDERS_KEY = 'oe.orders.v1';
let n = 0;
export const itemId = () => 'it' + Date.now().toString(36) + (n++).toString(36);

export const isAssembly = (item) => item.memberIds.length > 1;

export function itemName(item, model, i) {
  const names = item.memberIds.map((id) => model.memberById.get(id)?.name || '?');
  return (i != null ? '#' + (i + 1) + ' ' : '') + names.join(' + ');
}

// A first order from the sequencer's plan: its assemblies and the order pieces are run in there,
// or else a west-to-east guess.
export function defaultOrder(project, model = buildModel(project)) {
  const plan = activePlan(project);
  const { units } = planUnits(model, plan);
  const byKey = new Map(units.map((u) => [u.key, u]));
  const seen = new Set();
  const out = [];
  const add = (u) => {
    if (!u || seen.has(u.key) || !u.memberIds.length) return;
    seen.add(u.key);
    out.push({ id: itemId(), memberIds: [...u.memberIds], buddy: false, time: null });
  };
  const key = (unit) => (unit.type === 'assembly' ? 'a:' : 'm:') + unit.id;
  for (const t of plan.tasks || []) if ((t.kind === 'receive' || t.kind === 'run') && t.unit) add(byKey.get(key(t.unit)));
  for (const s of plan.steps || []) if (s.kind === 'install' && s.unit) add(byKey.get(key(s.unit)));
  for (const s of autoOrderSteps(model, plan)) if (s.kind === 'install') add(byKey.get(key(s.unit)));
  for (const u of units) add(u);
  return out;
}

// Problems that stop the game from starting (each {msg}).
export function orderProblems(order, model, rules = {}) {
  const out = [];
  if (!order.length) return [{ msg: 'The order is empty.' }];
  const first = order[0];
  if (first.memberIds.length !== 3) out.push({ msg: 'The first item has to be an assembly of three pieces, carried in together.' });
  const count = new Map();
  for (const it of order) for (const id of it.memberIds) count.set(id, (count.get(id) || 0) + 1);
  const missing = model.members.filter((m) => !count.has(m.id));
  if (missing.length) out.push({ msg: `${missing.length} piece${missing.length === 1 ? ' is' : 's are'} not in the order: ${missing.slice(0, 6).map((m) => m.name).join(', ')}${missing.length > 6 ? '…' : ''}` });
  const twice = [...count].filter(([, c]) => c > 1).map(([id]) => model.memberById.get(id)?.name || id);
  if (twice.length) out.push({ msg: 'In the order twice: ' + twice.join(', ') });
  const gone = [...count.keys()].filter((id) => !model.memberById.has(id));
  if (gone.length) out.push({ msg: `${gone.length} piece${gone.length === 1 ? '' : 's'} in the order no longer exist in the bridge.` });
  const max = rules.maxAssemblyMembers || 3;
  order.forEach((it, i) => { if (it.memberIds.length > max) out.push({ msg: `#${i + 1} has ${it.memberIds.length} pieces; an assembly can have at most ${max}.` }); });
  return out;
}

// Seconds for one builder to make an assembly: each connection inside it lined up and its nuts fastened.
export function assemblyTime(item, project, model, fastenTime) {
  if (item.time != null) return item.time;
  if (!isAssembly(item)) return 0;
  const tm = project.timing;
  const ids = new Set(item.memberIds);
  let t = 0;
  for (const c of model.contacts) {
    if (!ids.has(c.a) || !ids.has(c.b) || !c.bolts) continue;
    const align = c.alignTime ?? (tm.assemblyAlignTime || tm.alignTime || 6);
    const bolt = c.boltTime ?? (tm.assemblyBoltTime || fastenTime);
    t += align + c.bolts * ((tm.insertTime || 0) + bolt);
  }
  return Math.max(5, Math.round(t));
}

// Default time to fasten one nut: the first fastening tool's time, else by hand.
// Seconds for an assembly in the game: its own time if set (order editor), else
// the setup's assembly time (settings.assemblyTime), or the sequencer's time if that is 0.
export function gameAssemblyTime(item, project, model, settings) {
  if (item.time != null) return item.time;
  if (!isAssembly(item)) return 0;
  if (settings.assemblyTime > 0) return settings.assemblyTime;
  return assemblyTime({ ...item, time: null }, project, model, defaultFastenTime(project));
}

// The game's default nut time: quicker than the sequencer's (a game should keep moving).
export const gameFastenTime = (project) => Math.max(0.5, Math.round(defaultFastenTime(project) * 0.6 * 10) / 10);

export function defaultFastenTime(project) {
  const tool = project.tools.find((t) => t.kind === 'fastener' && t.boltTime > 0);
  return tool ? tool.boltTime : project.timing.boltTimeHand || 10;
}

// Which footing (index into footingRanges, west first) an item starts from.
export function startFooting(project, model, item) {
  const F = footingRanges(project);
  if (!F.length || !item) return 0;
  const ms = item.memberIds.map((id) => model.memberById.get(id)).filter(Boolean);
  const xs = ms.filter((m) => m.bearing).map((m) => m.bearingPoint[0]);
  const x = xs.length ? xs[0] : ms.reduce((s, m) => s + m.centroid[0], 0) / Math.max(1, ms.length);
  let best = 0;
  F.forEach(([a, b], i) => { if (Math.abs((a + b) / 2 - x) < Math.abs((F[best][0] + F[best][1]) / 2 - x)) best = i; });
  return best;
}

// ---- saved orders (this browser) and order files ----
export function savedOrders() {
  try { return JSON.parse(localStorage.getItem(ORDERS_KEY)) || []; } catch { return []; }
}

export function saveOrder(name, project, items) {
  const list = savedOrders().filter((o) => !(o.name === name && o.projectName === project.name));
  list.unshift({ name, projectName: project.name, items, savedAt: new Date().toISOString() });
  try { localStorage.setItem(ORDERS_KEY, JSON.stringify(list)); } catch { /* storage full or private */ }
}

export function deleteSavedOrder(name, projectName) {
  const list = savedOrders().filter((o) => !(o.name === name && o.projectName === projectName));
  try { localStorage.setItem(ORDERS_KEY, JSON.stringify(list)); } catch { /* ignore */ }
}

export function orderFile(name, project, items) {
  return { kind: 'over-engineered-order', name, projectName: project.name, items };
}

export function readOrderFile(obj) {
  if (!obj || !Array.isArray(obj.items)) throw new Error('Not a build order file');
  return obj.items.map((it) => ({ id: it.id || itemId(), memberIds: [...(it.memberIds || [])], buddy: !!it.buddy, time: it.time ?? null }));
}
