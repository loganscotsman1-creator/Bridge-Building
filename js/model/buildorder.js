// The build order: every piece of the bridge in the order it goes in, grouped into assemblies
// where several are bolted together in the staging yard first. It's chosen on the 3D bridge when
// the Build sequence tab opens, drives what the timeline offers next, and is what the game plays.
//
// It lives on the plan as plan.order = [{id, memberIds, buddy}]. An item with two or more pieces is
// an assembly, and its id is that assembly's id in plan.assemblies (kept in step by setOrder).
//   buddy – large or awkward: in the game, whoever carries it into place can only hold it there,
//           and someone else has to bolt it
import { uid } from './ids.js';
import { autoOrderSteps, planUnits } from './plan.js';
import { applyAssembly, dissolveAssembly } from './timeline.js';

export const isAssemblyItem = (item) => item.memberIds.length > 1;
export const itemKey = (item) => (isAssemblyItem(item) ? 'a:' + item.id : 'm:' + item.memberIds[0]);

// A first order when the plan has none yet: the order pieces are placed in on the timeline, then
// the automatic order (footings first, west to east), with the plan's assemblies kept together.
export function deriveOrder(model, plan) {
  const { units } = planUnits(model, plan);
  const byKey = new Map(units.map((u) => [u.key, u]));
  const seen = new Set();
  const out = [];
  const add = (u) => {
    if (!u || seen.has(u.key) || !u.memberIds.length) return;
    seen.add(u.key);
    out.push({ id: u.type === 'assembly' ? u.id : uid('it'), memberIds: [...u.memberIds], buddy: false });
  };
  const key = (unit) => (unit.type === 'assembly' ? 'a:' : 'm:') + unit.id;
  for (const t of plan.tasks || []) if ((t.kind === 'receive' || t.kind === 'run') && t.unit) add(byKey.get(key(t.unit)));
  for (const s of plan.steps || []) if (s.kind === 'install' && s.unit) add(byKey.get(key(s.unit)));
  for (const s of autoOrderSteps(model, { ...plan, order: null })) if (s.kind === 'install') add(byKey.get(key(s.unit)));
  for (const u of units) add(u);
  return out;
}

// The plan's order as it stands, made to agree with the bridge and the plan's assemblies: pieces
// that no longer exist are dropped, an assembly's pieces come from the assembly itself, and (with
// `fill`) anything left out is added at the end so the order is complete.
export function planOrder(model, plan, { fill = true } = {}) {
  if (!Array.isArray(plan.order)) return deriveOrder(model, plan);
  const asm = new Map(plan.assemblies.map((a) => [a.id, a]));
  const used = new Set();
  const out = [];
  const push = (it) => {
    const ids = it.memberIds.filter((id) => model.memberById.has(id) && !used.has(id));
    if (!ids.length) return;
    ids.forEach((id) => used.add(id));
    out.push({ ...it, memberIds: ids, buddy: !!it.buddy });
  };
  for (const it of plan.order) {
    if (isAssemblyItem(it)) {
      const a = asm.get(it.id);
      if (a) push({ ...it, memberIds: a.memberIds });
      else for (const id of it.memberIds) push({ id: uid('it'), memberIds: [id], buddy: false });
    } else push(it);
  }
  if (fill) {
    for (const a of plan.assemblies) if (a.memberIds.some((id) => !used.has(id))) push({ id: a.id, memberIds: a.memberIds, buddy: false });
    for (const m of model.members) if (!used.has(m.id)) push({ id: uid('it'), memberIds: [m.id], buddy: false });
  }
  return out;
}

// Put a new order on the plan and bring the plan's assemblies into line with it: assemblies are
// named by their place in the order (unless renamed), and timeline steps for an assembly that
// changed or went away are updated the same way as changing it on the timeline. `spare` are
// assemblies made but not put in the order yet. Mutates the plan.
export function setOrder(plan, model, items, spare = []) {
  const want = [...items, ...spare].filter(isAssemblyItem);
  const wantIds = new Set(want.map((it) => it.id));
  for (const a of [...plan.assemblies]) if (!wantIds.has(a.id)) dissolveAssembly(plan, model, a.id);
  want.forEach((it, i) => {
    const a = plan.assemblies.find((x) => x.id === it.id);
    const auto = 'Assembly ' + (i + 1);
    const name = !a || /^Assembly \d+$/.test(a.name) ? auto : a.name;
    const same = a && a.memberIds.length === it.memberIds.length && it.memberIds.every((id) => a.memberIds.includes(id));
    if (same) a.name = name;
    else applyAssembly(plan, model, it.memberIds, { id: it.id, name });
  });
  // Keep plan.assemblies in build order too.
  const at = new Map(want.map((it, i) => [it.id, i]));
  plan.assemblies.sort((a, b) => (at.get(a.id) ?? 1e9) - (at.get(b.id) ?? 1e9));
  plan.order = items.map((it) => ({ id: it.id, memberIds: [...it.memberIds], buddy: !!it.buddy }));
}

// Problems with an order (each {msg}). `strict` adds the game's rule about the first item.
export function orderProblems(order, model, rules = {}, { strict = true } = {}) {
  const out = [];
  if (!order.length) return [{ msg: 'The order is empty.' }];
  const first = order[0];
  if (strict && first.memberIds.length !== 3) out.push({ msg: 'The first item has to be an assembly of three pieces, carried in together.' });
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
  // An assembly's pieces have to be bolted together (each joined to the rest by a connection).
  order.forEach((it, i) => {
    if (it.memberIds.length < 2) return;
    const ids = new Set(it.memberIds.filter((id) => model.memberById.has(id)));
    const seen = new Set([[...ids][0]]);
    for (let grew = true; grew;) {
      grew = false;
      for (const c of model.contacts) {
        if (!c.bolts || !ids.has(c.a) || !ids.has(c.b) || seen.has(c.a) === seen.has(c.b)) continue;
        seen.add(c.a); seen.add(c.b); grew = true;
      }
    }
    if (seen.size < ids.size) out.push({ msg: `#${i + 1}: ${[...ids].filter((id) => !seen.has(id)).map((id) => model.memberById.get(id)?.name).join(', ')} isn't bolted to the rest of the assembly.` });
  });
  return out;
}
