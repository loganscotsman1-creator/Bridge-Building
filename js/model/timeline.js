// The build sequence as a timeline: where each builder's tasks sit in time, where a drop lands, what
// a builder could pick at that moment, and what the plan still misses. No drawing in here.
import { jointLabel, membersArea, planUnits, sideOf, taskUnitKey, unitKey } from './plan.js';
import { uid } from './ids.js';

export const ASM_COLORS = ['#9333ea', '#0891b2', '#db2777', '#65a30d', '#ea580c', '#4f46e5', '#0d9488', '#b91c1c', '#ca8a04', '#7c3aed'];

// The tasks a builder can be given: [icon, name in the list, what it does].
export const TASK_KINDS = {
  run: ['⇢', 'Run a piece to the river', 'Pick a piece up and carry it to the river to hand across'],
  receive: ['⬆', 'Receive a piece, run it to its place', 'Take a piece at the river (or pick it up nearby) and carry it to where it goes'],
  support: ['✋', 'Support the bridge', 'Hold a piece up until it stands, or for a set time'],
  bolt: ['●', 'Place a bolt', 'Put a bolt through two pieces'],
  nut: ['🔧', 'Fasten a nut', 'Put the nut on a placed bolt and fasten it'],
  assembly: ['🧩', 'Make an assembly', 'Bolt pieces together in the staging yard, to carry as one'],
  tool: ['⚒', 'Assemble a tool', 'Put a tool together from its pieces'],
  pass: ['⇄', 'Pass a tool', 'Hand a tool to another builder'],
  stand: ['▲', 'Place or remove a support tool', 'Set a jack stand under a piece, or take it out'],
  other: ['✎', 'Other task', 'Anything else: write what it is and how long it takes'],
};

// A step on a bar: as few words as can still tell it from its neighbors.
export function shortLabel(task, model, plan, project) {
  const member = () => model.memberById.get(task.member)?.name || '?';
  const unit = () => {
    if (!task.unit) return '?';
    return task.unit.type === 'assembly' ? plan.assemblies.find((a) => a.id === task.unit.id)?.name || '?' : model.memberById.get(task.unit.id)?.name || '?';
  };
  const joint = () => {
    const c = task.jointId && model.contacts.find((x) => x.id === task.jointId);
    return c ? jointLabel(model, c) : member();
  };
  const tool = () => project.tools.find((t) => t.id === task.toolId)?.name || 'tool';
  switch (task.kind) {
    case 'run': return 'Run ' + unit();
    case 'receive': return 'Receive ' + unit();
    case 'support': return 'Support ' + member();
    case 'bolt': return 'Bolt ' + joint();
    case 'nut': return 'Nut ' + joint();
    case 'assembly': return 'Make ' + (plan.assemblies.find((a) => a.id === task.assemblyId)?.name || 'assembly');
    case 'tool': return 'Assemble ' + tool();
    case 'pass': return 'Pass ' + tool();
    case 'stand': return (task.action === 'remove' ? 'Remove ' : 'Place ') + tool();
    case 'other': return task.text || 'Other task';
    default: return task.kind;
  }
}

// How long a step that hasn't got a time yet is drawn (seconds).
const GHOST = 10;

// Where each builder's steps sit in time: {builderId: [{task, start, end, along, ghost, why}]}. A
// step that never got going (its builder is stuck, or still holding on) is a `ghost` placed after
// whatever is stopping it, with `why` saying what that is.
export function taskBlocks(plan, sim, project) {
  const out = new Map();
  const open = new Set((sim.segments || []).filter((s) => s.open).map((s) => s.taskId));
  const nameOf = (id) => project?.builders.find((b) => b.id === id)?.name || 'This builder';
  for (const task of plan.tasks || []) {
    if (!out.has(task.builder)) out.set(task.builder, []);
    out.get(task.builder).push(task);
  }
  for (const [builder, tasks] of out) {
    let main = null, blocked = null, cursor = 0;
    out.set(builder, tasks.map((task) => {
      const times = sim.taskTimes?.[task.id], begun = sim.taskStarts?.[task.id];
      const along = !!task.along && !!main;
      let block;
      if (times) block = { task, start: times.start, end: times.end, along };
      else if (begun != null) block = { task, start: begun, end: begun + GHOST, along, ghost: true, why: sim.stuckTasks?.[task.id] ? `Waiting for ${sim.stuckTasks[task.id]}, and nothing in the plan makes that happen yet.` : 'This step never finished.' };
      else {
        const start = along ? main.start : cursor;
        block = { task, start, end: start + GHOST, along, ghost: true, why: blocked || 'This step never gets to start.' };
      }
      if (!along) {
        main = block;
        cursor = block.end;
        if (block.ghost && !blocked) blocked = `${nameOf(builder)} is stuck on the step before this one.`;
        if (open.has(task.id) && !blocked) blocked = `${nameOf(builder)} never lets go of the support before this, so this step can't start. Drop it on the lower half of that bar to do both at once, or give it to someone else.`;
      }
      return block;
    }));
  }
  return out;
}

// Where a drop lands in a builder's row. `lower` means the lower half of the row, where things done
// at the same time as a bar go.
export function dropSlot(blocks, builder, time, lower = false, exclude = new Set()) {
  const mains = (blocks.get(builder) || []).filter((b) => !b.along && !exclude.has(b.task.id));
  if (lower) {
    const on = mains.find((b) => time >= b.start - 1 && time <= b.end + 1);
    if (on) return { builder, time, along: true, with: on.task.id };
  }
  const next = mains.find((b) => time < (b.start + b.end) / 2);
  return { builder, time, along: false, before: next?.task.id || null };
}

// A step and the things its builder does at the same time as it, which move with it.
export function taskGroup(tasks, id) {
  const task = tasks.find((t) => t.id === id);
  if (!task) return [];
  if (task.along) return [task];
  const mine = tasks.filter((t) => t.builder === task.builder);
  const group = [task];
  for (let i = mine.indexOf(task) + 1; i < mine.length && mine[i].along; i++) group.push(mine[i]);
  return group;
}

// Put steps into the list where a drop landed. `startOf(id)` is when a step starts, used to keep
// the list roughly in time order when dropping past a builder's last step. Mutates `tasks`.
export function insertAtSlot(tasks, group, slot, startOf = () => null) {
  const ids = new Set(group.map((t) => t.id));
  const rest = tasks.filter((t) => !ids.has(t.id));
  for (const t of group) t.builder = slot.builder;
  if (slot.along) group[0].along = true; else delete group[0].along;
  let at;
  if (slot.with) {
    const mine = rest.filter((t) => t.builder === slot.builder);
    let k = mine.findIndex((t) => t.id === slot.with);
    while (mine[k + 1]?.along) k++;
    at = rest.indexOf(mine[k]) + 1;
  } else if (slot.before) at = rest.findIndex((t) => t.id === slot.before);
  else {
    at = 0;
    rest.forEach((t, i) => { const s = startOf(t.id); if (t.builder === slot.builder || (s != null && s <= slot.time)) at = i + 1; });
  }
  rest.splice(at, 0, ...group);
  tasks.length = 0;
  tasks.push(...rest);
}

// ---------- assemblies made from the timeline ----------

function dropAssemblySteps(plan, asmIds) {
  plan.tasks = (plan.tasks || []).filter((t) => !(t.kind === 'assembly' && asmIds.includes(t.assemblyId)) && !(t.unit?.type === 'assembly' && asmIds.includes(t.unit.id)));
}

// Make an assembly from these pieces, or change the pieces of an existing one. Steps that carried
// one of its pieces alone now carry the whole assembly. Mutates the plan.
export function applyAssembly(plan, model, ids, { id = uid('as'), name = null } = {}) {
  const existing = plan.assemblies.find((a) => a.id === id);
  for (const a of plan.assemblies) if (a !== existing) a.memberIds = a.memberIds.filter((m) => !ids.includes(m));
  const emptied = plan.assemblies.filter((a) => a !== existing && a.memberIds.length < 2).map((a) => a.id);
  if (emptied.length) dropAssemblySteps(plan, emptied);
  plan.assemblies = plan.assemblies.filter((a) => !emptied.includes(a.id));
  const fresh = existing || { id, name: name || 'Assembly ' + (plan.assemblies.length + 1), memberIds: [], areaZoneId: null };
  if (name) fresh.name = name;
  fresh.memberIds = [...ids];
  if (!existing) plan.assemblies.push(fresh);
  const seen = new Set((plan.tasks || []).filter((t) => t.unit?.type === 'assembly' && t.unit.id === id).map((t) => t.kind));
  plan.tasks = (plan.tasks || []).filter((t) => {
    if (t.unit?.type === 'member' && ids.includes(t.unit.id)) {
      if (seen.has(t.kind)) return false;
      seen.add(t.kind);
      t.unit = { type: 'assembly', id };
    }
    return true;
  });
  for (const t of plan.tasks) {
    if ((t.kind !== 'bolt' && t.kind !== 'nut') || !t.jointId) continue;
    const c = model.contacts.find((q) => q.id === t.jointId);
    if (c && ids.includes(c.a) && ids.includes(c.b)) t.where = 'staging';
  }
  return fresh;
}

// Back to loose pieces: the steps that made or carried it go, and its bolts are done at the bridge.
export function dissolveAssembly(plan, model, asmId) {
  const a = plan.assemblies.find((x) => x.id === asmId);
  if (!a) return;
  dropAssemblySteps(plan, [asmId]);
  plan.assemblies = plan.assemblies.filter((x) => x !== a);
  for (const t of plan.tasks || []) {
    if ((t.kind !== 'bolt' && t.kind !== 'nut') || t.where !== 'staging' || !t.jointId) continue;
    const c = model.contacts.find((q) => q.id === t.jointId);
    if (c && a.memberIds.includes(c.a) && a.memberIds.includes(c.b)) t.where = 'bridge';
  }
}

// Take a step out of the plan. When the step that makes an assembly goes, the assembly does too.
export function removeTask(plan, model, id) {
  const task = (plan.tasks || []).find((t) => t.id === id);
  if (!task) return;
  plan.tasks = plan.tasks.filter((t) => t.id !== id);
  if (task.kind === 'assembly') dissolveAssembly(plan, model, task.assemblyId);
}

// ---------- what a builder can get at ----------

// Is this builder on the same side of the river as the members?
export function onStagingSide(site, builder) {
  const area = membersArea(site);
  const side = sideOf(site, { x: area.x + area.w / 2, y: area.y + area.h / 2 });
  return !side || !builder || sideOf(site, builder.start) === side;
}

const stepOf = (plan, kind, key) => (plan.tasks || []).find((t) => t.kind === kind && taskUnitKey(t) === key);

// For each piece, whether this builder could choose it for this kind of step at this moment:
// {status: 'ready' | 'later' | 'no', note, unitKey, unit}, by member id.
export function pieceChoices(project, model, plan, sim, kind, builderId, t) {
  const builder = project.builders.find((b) => b.id === builderId);
  const near = onStagingSide(project.site, builder);
  const nameOf = (task) => project.builders.find((b) => b.id === task.builder)?.name || 'someone';
  const { units } = planUnits(model, plan);
  const out = new Map();
  for (const u of units) {
    const run = stepOf(plan, 'run', u.key), recv = stepOf(plan, 'receive', u.key);
    let c;
    if (kind === 'run') {
      if (run) c = { status: 'no', note: `${nameOf(run)} already runs it` };
      else if (recv) c = { status: 'no', note: `${nameOf(recv)} already takes it to its place` };
      else c = { status: 'ready', note: 'In the yard' };
    } else if (kind === 'receive') {
      if (recv) c = { status: 'no', note: `${nameOf(recv)} already places it` };
      else if (run) c = { status: 'ready', note: `${nameOf(run)} runs it to the river` };
      else if (near) c = { status: 'ready', note: 'In the yard' };
      else c = { status: 'later', note: 'Nobody runs it to the river yet' };
    } else if (kind === 'support') {
      const began = recv ? sim.taskStarts?.[recv.id] : null;
      if (!recv) c = { status: 'no', note: 'No step places it yet' };
      else if (began != null && began <= t) c = { status: 'ready', note: `Placed by ${nameOf(recv)}` };
      else c = { status: 'later', note: 'Placed later in the plan' };
    } else c = { status: 'ready', note: '' };
    for (const id of u.memberIds) out.set(id, { ...c, unitKey: u.key, unit: u });
  }
  return out;
}

// Which bolts have a step to place them, and which to fasten them. Making an assembly does both for
// the ones inside it.
export function plannedBolts(model, plan) {
  const placed = new Set(), nutted = new Set();
  for (const t of plan.tasks || []) {
    if (t.kind === 'bolt') (t.boltIds || []).forEach((id) => placed.add(id));
    if (t.kind === 'nut') (t.boltIds || []).forEach((id) => nutted.add(id));
    if (t.kind === 'assembly') {
      const a = plan.assemblies.find((x) => x.id === t.assemblyId);
      if (!a) continue;
      for (const b of model.bolts) if (b.jointId && (b.memberIds || []).every((m) => a.memberIds.includes(m))) { placed.add(b.id); nutted.add(b.id); }
    }
  }
  return { placed, nutted };
}

// Every bolted connection, and whether a builder could work on it now.
export function connectionChoices(model, plan, sim, kind, t) {
  const { placed, nutted } = plannedBolts(model, plan);
  const { inAssembly } = planUnits(model, plan);
  const begun = (memberId) => {
    const key = inAssembly.has(memberId) ? 'a:' + inAssembly.get(memberId) : 'm:' + memberId;
    const recv = stepOf(plan, 'receive', key);
    if (!recv) return 'no';
    const at = sim.taskStarts?.[recv.id];
    return at != null && at <= t ? 'now' : 'later';
  };
  return model.contacts.filter((c) => c.bolts > 0).map((joint) => {
    const inside = inAssembly.has(joint.a) && inAssembly.get(joint.a) === inAssembly.get(joint.b) ? inAssembly.get(joint.a) : null;
    const left = joint.boltIds.filter((id) => !(kind === 'nut' ? nutted : placed).has(id));
    const ready = kind === 'nut' ? left.filter((id) => placed.has(id)) : left;
    const pa = begun(joint.a), pb = begun(joint.b);
    let status, note;
    if (!left.length) { status = 'no'; note = kind === 'nut' ? 'Every nut has a step' : 'Every bolt has a step'; }
    else if (kind === 'nut' && !ready.length) { status = 'later'; note = 'Place its bolts first'; }
    else if (inside) { status = 'ready'; note = 'In an assembly, in the yard'; }
    else if (pa === 'now' && pb === 'now') { status = 'ready'; note = 'Both pieces are in place'; }
    else if (kind === 'bolt' && (pa === 'now' || pb === 'now')) { status = 'ready'; note = 'One piece is in place'; }
    else if (pa === 'no' && pb === 'no') { status = 'later'; note = 'No step places these yet'; }
    else if (pa === 'no' || pb === 'no') { status = 'later'; note = 'One piece has no step placing it yet'; }
    else { status = 'later'; note = 'Placed later in the plan'; }
    return { joint, left, ready: ready.length ? ready : left, inside, status, note };
  });
}

// ---------- what the plan is missing ----------

// Live tallies, the list of what's still to do (each can be dragged onto the timeline, as `kind`
// with `preset` filled in), and the marks to show on individual bars.
export function planChecks(project, model, plan, sim) {
  const tasks = plan.tasks || [];
  const { units, inAssembly } = planUnits(model, plan);
  const { placed, nutted } = plannedBolts(model, plan);
  const todo = [];
  const received = new Set(tasks.filter((t) => t.kind === 'receive').map(taskUnitKey));
  const ran = new Set(tasks.filter((t) => t.kind === 'run').map(taskUnitKey));
  const unitPreset = (u) => ({ unit: { type: u.type, id: u.id } });

  // Pieces that would fall, first: that's the most urgent thing to see.
  const fallen = new Map();
  for (const f of sim.falls || []) if (!fallen.has(f.unitKey)) fallen.set(f.unitKey, f);
  for (const key of fallen.keys()) {
    const u = units.find((x) => x.key === key);
    if (u) todo.push({ id: 'fall:' + key, group: 'support', kind: 'support', text: `Support ${u.name}: it would fall`, preset: { member: u.memberIds[0] } });
  }
  // Assemblies nothing makes.
  for (const u of units) {
    if (u.type !== 'assembly') continue;
    const made = tasks.some((t) => t.kind === 'assembly' && t.assemblyId === u.id);
    const inner = model.bolts.filter((b) => b.jointId && (b.memberIds || []).every((m) => u.memberIds.includes(m)));
    if (!made && inner.some((b) => !nutted.has(b.id))) todo.push({ id: 'asm:' + u.id, group: 'assembly', kind: 'assembly', text: `Make ${u.name}`, preset: { assemblyId: u.id } });
  }
  for (const u of units) if (ran.has(u.key) && !received.has(u.key)) todo.push({ id: 'recv:' + u.key, group: 'piece', kind: 'receive', text: `Receive ${u.name}: it's run to the river`, preset: unitPreset(u) });
  for (const u of units) if (!ran.has(u.key) && !received.has(u.key)) todo.push({ id: 'place:' + u.key, group: 'piece', kind: 'receive', text: `Place ${u.name}`, preset: unitPreset(u) });
  // Bolts and nuts, one line per connection. (A bolt through several pieces is listed once.)
  const seen = { bolt: new Set(), nut: new Set() };
  const line = (kind, have, joint, one, many) => {
    const ids = joint.boltIds.filter((id) => !have.has(id) && !seen[kind].has(id));
    ids.forEach((id) => seen[kind].add(id));
    if (!ids.length) return;
    const where = inAssembly.has(joint.a) && inAssembly.get(joint.a) === inAssembly.get(joint.b) ? 'staging' : 'bridge';
    todo.push({ id: kind + ':' + joint.id, group: kind, kind, text: `${ids.length} ${ids.length === 1 ? one : many}: ${jointLabel(model, joint)}`, preset: { member: joint.a, jointId: joint.id, boltIds: ids, where } });
  };
  const joints = model.contacts.filter((c) => c.bolts > 0);
  for (const j of joints) line('bolt', placed, j, 'bolt', 'bolts');
  for (const j of joints) line('nut', nutted, j, 'nut', 'nuts');

  // Marks on the bars.
  const marks = new Map();
  const mark = (id, m) => { if (!marks.has(id)) marks.set(id, []); marks.get(id).push(m); };
  for (const t of tasks) {
    if (t.kind === 'run' && !received.has(taskUnitKey(t))) mark(t.id, { icon: '⬆', bad: true, text: 'Nobody receives this at the river yet' });
    if (t.kind === 'receive' && t.unit) {
      const key = unitKey(t.unit);
      const u = units.find((x) => x.key === key);
      if (!u) continue;
      if (fallen.has(key)) mark(t.id, { icon: '✋', bad: true, text: `${u.name} would fall: nobody is supporting it` });
      const outer = joints.filter((j) => u.memberIds.includes(j.a) !== u.memberIds.includes(j.b));
      const count = (have) => new Set(outer.flatMap((j) => j.boltIds).filter((id) => !have.has(id))).size;
      const nb = count(placed), nn = count(nutted);
      if (nb) mark(t.id, { icon: '●', n: nb, text: `${nb} bolt${nb === 1 ? '' : 's'} on this piece: no step places ${nb === 1 ? 'it' : 'them'} yet` });
      if (nn) mark(t.id, { icon: '🔧', n: nn, text: `${nn} nut${nn === 1 ? '' : 's'} on this piece: no step fastens ${nn === 1 ? 'it' : 'them'} yet` });
    }
    if (t.kind === 'bolt') {
      const nn = (t.boltIds || []).filter((id) => !nutted.has(id)).length;
      if (nn) mark(t.id, { icon: '🔧', n: nn, text: `No step fastens the nut${nn === 1 ? '' : 's'} on ${nn === 1 ? 'this bolt' : `${nn} of these bolts`} yet` });
    }
  }

  const allBolts = model.bolts.filter((b) => b.jointId);
  return {
    pieces: { done: units.filter((u) => received.has(u.key)).length, total: units.length },
    bolts: { done: allBolts.filter((b) => placed.has(b.id)).length, total: allBolts.length },
    nuts: { done: allBolts.filter((b) => nutted.has(b.id)).length, total: allBolts.length },
    falls: fallen.size,
    todo,
    marks,
  };
}
