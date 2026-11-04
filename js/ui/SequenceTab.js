// Sequence tab: the plan, built step by step. Each step is one task given to one builder; a step
// can run at the same time as that builder's previous one (multitasking). Each builder does their
// steps in list order, starting each as soon as they're free and what it needs is ready. The
// simulation re-runs on every change.
import { html, useEffect, useMemo, useState } from '../lib/preact.js';
import { updateProject } from '../model/store.js';
import { uid } from '../model/ids.js';
import { activePlan, emptyPlan } from '../model/schema.js';
import { autoOrderSteps, planUnits, sideOf, taskLabel, taskUnitKey, unitKey } from '../model/plan.js';
import { fmt, fmtCost, planTasks, simulate } from '../sim/simulate.js';
import { stateAt } from '../sim/playback.js';
import { IsoView } from './IsoView.js';
import { Gantt } from './Gantt.js';
import { Check, Hint, NumField, Section, SelectField, TextField } from './common.js';

// One color per assembly, used in the 3D view and the step list.
export const ASM_COLORS = ['#9333ea', '#0891b2', '#db2777', '#65a30d', '#ea580c', '#4f46e5', '#0d9488', '#b91c1c', '#ca8a04', '#7c3aed'];

export const TASK_KINDS = {
  run: ['⇢', 'Run a piece to the river'],
  receive: ['⬆', 'Receive a piece and run it to its place'],
  support: ['✋', 'Support the bridge in place'],
  bolt: ['●', 'Place a bolt in a member'],
  nut: ['🔧', 'Place and fasten a nut on a bolt'],
  tool: ['⚒', 'Assemble a tool'],
  pass: ['⇄', 'Pass a tool to another builder'],
  other: ['✎', 'Other task'],
  stand: ['▲', 'Place or remove a support tool'],
};

const STATUS_COLORS = { held: '#f97316', working: '#eab308', stable: '#475569', unstable: '#dc2626' };

const builderLabel = (project, b) => {
  const side = sideOf(project.site, b.start);
  return side && !b.name.toLowerCase().includes(side) ? `${b.name} (${side})` : b.name;
};

// Connections a member is part of that have bolts.
const connectionsOf = (model, memberId) => model.contacts.filter((c) => (c.a === memberId || c.b === memberId) && c.bolts > 0);

// Is this connection inside an assembly (so it's made in the staging yard)?
const insideAssembly = (plan, joint) => plan.assemblies.some((a) => a.memberIds.includes(joint.a) && a.memberIds.includes(joint.b));

function setJoint(task, plan, joint) {
  if (!joint) return { jointId: null, boltIds: [] };
  return { jointId: joint.id, boltIds: [...joint.boltIds], where: task.where === 'hand' ? 'hand' : insideAssembly(plan, joint) ? 'staging' : 'bridge' };
}

// A new step of this kind for this builder, with sensible first choices.
function newTask(kind, builder, project, model, plan, was = {}) {
  const t = { id: uid('k'), kind, builder };
  const units = planUnits(model, plan).units;
  const firstMember = model.members[0]?.id;
  if (kind === 'run' || kind === 'receive') t.unit = was.unit || (units[0] && { type: units[0].type, id: units[0].id });
  if (kind === 'support') { t.member = was.member || firstMember; t.until = 'auto'; }
  if (kind === 'bolt' || kind === 'nut') {
    t.member = was.member || firstMember;
    Object.assign(t, { where: 'bridge' }, setJoint(t, plan, connectionsOf(model, t.member)[0]));
  }
  if (kind === 'tool' || kind === 'pass') t.toolId = project.tools[0]?.id;
  if (kind === 'pass') t.to = project.builders.find((b) => b.id !== builder)?.id;
  if (kind === 'other') { t.text = ''; t.duration = 10; }
  if (kind === 'stand') { t.action = 'place'; t.toolId = project.tools.find((x) => x.kind === 'support')?.id; t.member = was.member || firstMember; }
  return t;
}

// The choices for one step. `set(patch)` changes it.
function TaskFields({ task, set, project, model, plan }) {
  const units = planUnits(model, plan).units;
  const members = model.members;
  const memberField = html`<${SelectField} label="Member" value=${task.member || ''} options=${members.map((m) => [m.id, m.name])}
    onChange=${(v) => { const patch = { member: v }; if (task.kind === 'bolt' || task.kind === 'nut') Object.assign(patch, setJoint(task, plan, connectionsOf(model, v)[0])); set(patch); }} />`;
  switch (task.kind) {
    case 'run': case 'receive':
      return html`<${SelectField} label="Piece" value=${task.unit ? unitKey(task.unit) : ''} options=${units.map((u) => [u.key, u.name + (u.type === 'assembly' ? ' (assembly)' : '')])}
        onChange=${(v) => { const u = units.find((x) => x.key === v); set({ unit: { type: u.type, id: u.id } }); }} />
        ${task.kind === 'receive' && html`<${Hint}>If nobody runs this piece to the river, this builder picks it up from where it's staged.<//>`}`;
    case 'support': {
      const auto = task.until === 'auto' || task.until == null;
      return html`${memberField}
        <${SelectField} label="For how long" value=${auto ? 'auto' : 'timed'} options=${[['auto', 'Until it stands without them'], ['timed', 'A set time']]}
          onChange=${(v) => set({ until: v === 'auto' ? 'auto' : 30 })} />
        ${!auto && html`<${NumField} label="Support for" unit="s" min=${0} value=${task.until} title="You can also drag the right end of the bar in the timeline" onChange=${(v) => set({ until: v })} />`}`;
    }
    case 'bolt': case 'nut': {
      const conns = connectionsOf(model, task.member);
      const joint = conns.find((c) => c.id === task.jointId);
      const name = (c) => model.memberById.get(c.a === task.member ? c.b : c.a)?.name;
      const all = joint && (task.boltIds || []).length === joint.boltIds.length;
      return html`${memberField}
        ${conns.length ? html`<${SelectField} label="Connected to" value=${task.jointId || ''} options=${conns.map((c) => [c.id, `${name(c)} · ${c.bolts} bolt${c.bolts === 1 ? '' : 's'}`])}
          onChange=${(v) => set(setJoint(task, plan, conns.find((c) => c.id === v)))} />` : html`<${Hint}>This member has no bolted connections yet (tab 1).<//>`}
        ${joint && joint.boltIds.length > 1 && html`<${SelectField} label="Which" value=${all ? 'all' : (task.boltIds || [])[0]}
          options=${[['all', `All ${joint.boltIds.length} bolts`], ...joint.boltIds.map((id, i) => [id, `Bolt ${i + 1}`])]}
          onChange=${(v) => set({ boltIds: v === 'all' ? [...joint.boltIds] : [v] })} />`}
        <${SelectField} label="Where" value=${task.where || 'bridge'}
          options=${[['bridge', 'At the bridge'], ['staging', 'In the staging yard (making an assembly)'], ...(task.kind === 'bolt' ? [['hand', 'While the member is being run to its place']] : [])]}
          onChange=${(v) => set({ where: v, along: v === 'hand' ? true : task.along })} />`;
    }
    case 'tool': {
      const tool = project.tools.find((t) => t.id === task.toolId);
      return html`<${SelectField} label="Tool" value=${task.toolId || ''} options=${project.tools.map((t) => [t.id, t.name])} onChange=${(v) => set({ toolId: v })} />
        ${tool && html`<${Hint}>${(tool.pieces || []).length ? `From ${tool.pieces.map((p) => `${p.name} (${p.time} s)`).join(', ')}.` : 'This tool has no pieces yet. Add them in the Tools tab.'}<//>`}`;
    }
    case 'pass':
      return html`<${SelectField} label="Tool" value=${task.toolId || ''} options=${project.tools.map((t) => [t.id, t.name])} onChange=${(v) => set({ toolId: v })} />
        <${SelectField} label="To" value=${task.to || ''} options=${project.builders.filter((b) => b.id !== task.builder).map((b) => [b.id, builderLabel(project, b)])} onChange=${(v) => set({ to: v })} />`;
    case 'other':
      return html`<${TextField} label="What" value=${task.text || ''} placeholder="Describe the task" onChange=${(v) => set({ text: v })} />
        <${NumField} label="Takes" unit="s" min=${0} value=${task.duration} title="You can also drag the right end of the bar in the timeline" onChange=${(v) => set({ duration: v })} />`;
    case 'stand': {
      const stands = project.tools.filter((t) => t.kind === 'support');
      return html`<${SelectField} label="Action" value=${task.action} options=${[['place', 'Place it'], ['remove', 'Remove it']]} onChange=${(v) => set({ action: v })} />
        <${SelectField} label="Tool" value=${task.toolId || ''} options=${stands.map((t) => [t.id, t.name])} onChange=${(v) => set({ toolId: v })} />
        ${memberField}`;
    }
    default: return null;
  }
}

const setActive = (fn, key) => updateProject((p) => fn(activePlan(p)), { key });

// Edit one step; used next to the list and under the timelines.
export function TaskEditor({ task, project, model, sim, onClose, onSelect }) {
  const plan = activePlan(project);
  const [takeover, setTakeover] = useState('');
  const [afterId, setAfterId] = useState('');
  if (!task) return null;
  const index = plan.tasks.findIndex((t) => t.id === task.id);
  const set = (patch) => setActive((pl) => { Object.assign(pl.tasks.find((t) => t.id === task.id), patch); }, 'task' + task.id + Object.keys(patch)[0]);
  const others = project.builders.filter((b) => b.id !== task.builder);
  const taker = takeover || others[0]?.id;
  const theirs = plan.tasks.filter((t) => t.builder === taker);
  // By default, once they finish whatever they're doing when this support begins.
  const begins = sim?.taskTimes?.[task.id]?.start ?? 0;
  const after = theirs.find((t) => t.id === afterId) || theirs.find((t) => (sim?.taskTimes?.[t.id]?.end ?? 0) >= begins) || theirs[theirs.length - 1];
  return html`<${Section} title=${`Step ${index + 1}`}>
    <${SelectField} label="Builder" value=${task.builder} options=${project.builders.map((b) => [b.id, builderLabel(project, b)])} onChange=${(v) => set({ builder: v })} />
    <div class="muted small">${TASK_KINDS[task.kind]?.[1]}</div>
    <${TaskFields} task=${task} set=${set} project=${project} model=${model} plan=${plan} />
    <${Check} label="At the same time as their previous step (multitask)" checked=${!!task.along}
      title="Starts once their previous step has started, and doesn't move them. It takes longer by the multitasking slowdown in Crew → Timing."
      onChange=${(v) => set({ along: v || undefined })} />
    ${task.kind === 'support' && others.length > 0 && html`<div class="swap">
      <b>Hand over to someone else</b>
      <${SelectField} label="Builder" value=${taker} options=${others.map((b) => [b.id, builderLabel(project, b)])} onChange=${setTakeover} />
      ${theirs.length > 0 && html`<${SelectField} label="After their step" value=${after?.id} options=${theirs.map((t) => [t.id, `${plan.tasks.indexOf(t) + 1}. ${taskLabel(t, model, plan, project)}`])} onChange=${setAfterId} />`}
      <button class="primary" onClick=${() => {
        const id = uid('k');
        setActive((pl) => {
          const at = after ? pl.tasks.findIndex((t) => t.id === after.id) + 1 : pl.tasks.length;
          pl.tasks.splice(at, 0, { id, kind: 'support', builder: taker, member: task.member, until: 'auto' });
          // They hold until the other builder takes over.
          const me = pl.tasks.find((t) => t.id === task.id);
          me.until = 'auto';
        });
        if (onSelect) onSelect(id);
      }}>Add the swap</button>
      <${Hint}>Once they've taken over, ${project.builders.find((b) => b.id === task.builder)?.name} lets go and moves on to their next step.<//>
    </div>`}
    <div class="row">
      <button class="danger" onClick=${() => { setActive((pl) => { pl.tasks = pl.tasks.filter((t) => t.id !== task.id); }); onClose && onClose(); }}>Delete step</button>
      ${onClose && html`<button onClick=${onClose}>Close</button>`}
    </div>
  <//>`;
}

export function SequenceTab({ project, model, sim }) {
  const plan = activePlan(project);
  const tasks = plan.tasks || [];
  const [sel, setSel] = useState(null);
  const [t, setT] = useState(null); // the moment shown in the 3D view
  const [editAsm, setEditAsm] = useState(null);
  const [dragFrom, setDragFrom] = useState(null);
  const [compare, setCompare] = useState(null);
  const [picked, setPicked] = useState([]); // member ids picked in the 3D view
  const [form, setForm] = useState(null); // the step being added
  const [thenSupport, setThenSupport] = useState(true);
  const [thenNut, setThenNut] = useState(false);

  const setPlan = (fn, key) => updateProject((p) => fn(activePlan(p)), { key });
  const selTask = tasks.find((x) => x.id === sel);
  const selIndex = tasks.indexOf(selTask);
  const { units } = planUnits(model, plan);
  const placedUnits = new Set(tasks.filter((x) => x.kind === 'receive').map(taskUnitKey));
  const unplaced = units.filter((u) => !placedUnits.has(u.key));
  const errorSteps = new Set(sim.errors.map((e) => e.step));
  const warnSteps = new Set(sim.warnings.map((e) => e.step));
  // Keep the selected step in view (it may have been picked on the timeline).
  useEffect(() => { document.querySelector('.steps-list li.sel')?.scrollIntoView({ block: 'nearest' }); }, [sel]);
  const select = (id) => {
    setForm(null);
    setSel(id);
    const times = sim.taskTimes?.[id];
    if (times) setT(times.end);
  };
  const move = (from, to) => setPlan((pl) => { const [s] = pl.tasks.splice(from, 1); pl.tasks.splice(to, 0, s); });

  // --- adding a step ---
  const startForm = (kind = form?.kind || 'receive', was = {}) => {
    const builder = form?.builder || selTask?.builder || project.builders[0]?.id;
    if (!builder) { alert('Add builders in the Crew tab first.'); return; }
    setForm(newTask(kind, builder, project, model, plan, was));
  };
  const addForm = () => {
    const id = form.id;
    const extra = [];
    if (form.kind === 'receive' && thenSupport && form.unit) {
      const u = units.find((x) => x.key === unitKey(form.unit));
      if (u) extra.push({ id: uid('k'), kind: 'support', builder: form.builder, member: u.memberIds[0], until: 'auto' });
    }
    if (form.kind === 'bolt' && thenNut && form.boltIds?.length) extra.push({ ...form, id: uid('k'), kind: 'nut', where: form.where === 'hand' ? 'bridge' : form.where, along: undefined });
    setPlan((pl) => { pl.tasks.splice(selIndex >= 0 ? selIndex + 1 : pl.tasks.length, 0, { ...form }, ...extra); });
    setSel(id);
    setForm(newTask(form.kind, form.builder, project, model, plan));
  };

  const autoBuild = () => {
    if (tasks.length && !confirm('Replace every step with an automatic plan? (You can undo, or Duplicate the plan first to keep this one.)')) return;
    setPlan((pl) => {
      const toStep = (x) => ({ id: uid('s'), kind: 'support', action: x.action, toolId: x.toolId, memberId: x.member, builder: x.builder });
      const stands = pl.tasks.filter((x) => x.kind === 'stand');
      const steps = [...stands.filter((x) => x.action === 'place').map(toStep), ...autoOrderSteps(model, pl), ...stands.filter((x) => x.action === 'remove').map(toStep)];
      pl.tasks = planTasks(project, pl, steps);
    });
    setSel(null);
  };

  // --- assemblies ---
  const rules = project.site.rules || {};
  const maxAsm = rules.maxAssemblyMembers ?? Infinity;
  const makeAssembly = (ids) => {
    if (ids.length < 2 || ids.length > maxAsm) return;
    const id = uid('as');
    setPlan((pl) => {
      for (const a of pl.assemblies) a.memberIds = a.memberIds.filter((m) => !ids.includes(m));
      pl.assemblies = pl.assemblies.filter((a) => a.memberIds.length > 1);
      pl.assemblies.push({ id, name: 'Assembly ' + (pl.assemblies.length + 1), memberIds: [...ids], areaZoneId: null });
      // The first piece's run and receive steps now carry the whole assembly.
      const seen = new Set();
      pl.tasks = pl.tasks.filter((x) => {
        if (!x.unit || x.unit.type !== 'member' || !ids.includes(x.unit.id)) return !(x.kind === 'support' && ids.includes(x.member) && ids.indexOf(x.member) > 0);
        if (seen.has(x.kind)) return false;
        seen.add(x.kind);
        x.unit = { type: 'assembly', id };
        return true;
      });
      for (const x of pl.tasks) {
        if ((x.kind === 'bolt' || x.kind === 'nut') && x.jointId) {
          const c = model.contacts.find((q) => q.id === x.jointId);
          if (c && ids.includes(c.a) && ids.includes(c.b)) x.where = 'staging';
        }
        if (x.kind === 'support' && ids.includes(x.member)) x.member = ids[0];
      }
    });
    setPicked([]);
  };
  const deleteAssembly = (asmId) => setPlan((pl) => {
    pl.assemblies = pl.assemblies.filter((x) => x.id !== asmId);
    pl.tasks = pl.tasks.filter((x) => !(x.unit && x.unit.type === 'assembly' && x.unit.id === asmId));
  });
  const toggleMember = (asmId, memberId) => {
    const cur = plan.assemblies.find((x) => x.id === asmId);
    if (cur && !cur.memberIds.includes(memberId) && cur.memberIds.length >= maxAsm) {
      alert(`An assembly can have at most ${maxAsm} members under this year's rules (10.3.7).`);
      return;
    }
    setPlan((pl) => {
      const a = pl.assemblies.find((x) => x.id === asmId);
      if (!a) return;
      if (a.memberIds.includes(memberId)) { a.memberIds = a.memberIds.filter((m) => m !== memberId); return; }
      for (const other of pl.assemblies) other.memberIds = other.memberIds.filter((m) => m !== memberId);
      a.memberIds.push(memberId);
    });
  };
  const pick = (m) => {
    if (editing) { toggleMember(editing.id, m.id); return; }
    setPicked(picked.includes(m.id) ? picked.filter((x) => x !== m.id) : [...picked, m.id]);
  };
  const editing = editAsm && plan.assemblies.find((a) => a.id === editAsm);
  const asmOf = new Map();
  for (const a of plan.assemblies) for (const m of a.memberIds) asmOf.set(m, a.id);
  const asmColor = (asmId) => ASM_COLORS[Math.max(0, plan.assemblies.findIndex((a) => a.id === asmId)) % ASM_COLORS.length];

  // --- 3D view: the bridge at the chosen moment, the selected step's members picked out ---
  const state = useMemo(() => (t != null ? stateAt(sim, t) : null), [sim, t]);
  const selMembers = new Set();
  if (selTask) {
    if (selTask.member) selMembers.add(selTask.member);
    if (selTask.unit) units.find((u) => u.key === unitKey(selTask.unit))?.memberIds.forEach((id) => selMembers.add(id));
  }
  const baseStyle = (m) => {
    if (editing) {
      if (editing.memberIds.includes(m.id)) return { color: asmColor(editing.id) };
      if (asmOf.has(m.id)) return { color: asmColor(asmOf.get(m.id)), opacity: 0.45 };
      return { color: '#94a3b8', opacity: 0.6 };
    }
    if (selMembers.has(m.id)) return { color: '#2563eb', outline: '#1d4ed8' };
    if (state) {
      const ms = state.members.get(m.id);
      if (ms?.loc === 'bridge') return { color: STATUS_COLORS[ms.status] || '#475569' };
      return asmOf.has(m.id) ? { color: asmColor(asmOf.get(m.id)), opacity: 0.35 } : { color: '#cbd5e1', opacity: 0.4, dash: '2 2' };
    }
    return asmOf.has(m.id) ? { color: asmColor(asmOf.get(m.id)) } : { color: '#94a3b8' };
  };
  const styleOf = (m) => {
    const st = baseStyle(m);
    return picked.includes(m.id) ? { ...st, color: '#facc15', outline: '#b45309', opacity: 1 } : st;
  };
  const pickedNames = picked.map((id) => model.memberById.get(id)?.name).filter(Boolean);

  const runCompare = () => setCompare(project.plans.map((pl) => {
    const r = simulate(project, pl);
    return { id: pl.id, name: pl.name, end: r.endTime, cost: r.cost, errors: r.errors.length, holds: r.holds.reduce((a, h) => a + h.duration, 0), aborted: r.aborted };
  }));
  const colorOf = (id) => project.builders.find((b) => b.id === id)?.color || '#94a3b8';
  const onGanttEdit = (taskId, patch) => setPlan((pl) => { Object.assign(pl.tasks.find((x) => x.id === taskId) || {}, patch); });

  return html`<div class="tab-layout seq">
    <div class="main">
      <div class="toolbar">
        <label class="check">Plan <select value=${plan.id} onChange=${(e) => updateProject((p) => { p.activePlanId = e.target.value; })}>
          ${project.plans.map((pl) => html`<option value=${pl.id} selected=${pl.id === plan.id}>${pl.name}</option>`)}</select></label>
        <input type="text" class="plan-name" value=${plan.name} onInput=${(e) => setPlan((pl) => { pl.name = e.target.value; }, 'planname')} title="Rename this plan" />
        <button title="Copy this plan to try a variation" onClick=${() => updateProject((p) => {
          const copy = structuredClone(activePlan(p));
          copy.id = uid('p'); copy.name = activePlan(p).name + ' (copy)';
          p.plans.push(copy); p.activePlanId = copy.id;
        })}>Duplicate</button>
        <button onClick=${() => updateProject((p) => { const pl = emptyPlan('Plan ' + (p.plans.length + 1)); p.plans.push(pl); p.activePlanId = pl.id; })}>New</button>
        <button disabled=${project.plans.length < 2} onClick=${() => confirm(`Delete plan "${plan.name}"?`) && updateProject((p) => { p.plans = p.plans.filter((x) => x.id !== plan.id); p.activePlanId = p.plans[0].id; })}>Delete</button>
        <button onClick=${runCompare}>Compare plans</button>
        <span class="sep"></span>
        <button title="Fill in a working plan you can then edit: footings first, west to east, trusses before laterals" onClick=${autoBuild}>Auto-build plan</button>
        <span class="spacer"></span>
        <span data-tour="total" class=${'total ' + (sim.errors.length ? 'bad' : '')} title="Construction cost uses this year's formula (number of builders × minutes × rate)">
          ${sim.aborted ? 'Plan gets stuck' : html`Build time ${fmt(sim.endTime)}${sim.cost != null && html` <span class="cost">· ${fmtCost(sim.cost)}</span>`}`}</span>
      </div>
      ${compare && html`<div class="compare">
        <table class="grid"><thead><tr><th>Plan</th><th>Build time</th><th>Construction cost</th><th>Total holding</th><th>Problems</th><th></th></tr></thead>
        <tbody>${compare.map((c) => html`<tr class=${c.id === plan.id ? 'sel' : ''}><td>${c.name}</td><td>${c.aborted ? 'incomplete' : fmt(c.end)}</td><td>${c.aborted ? '–' : fmtCost(c.cost)}</td><td>${fmt(c.holds)}</td><td class=${c.errors ? 'bad' : 'ok'}>${c.errors || '—'}</td>
          <td><button class="small" onClick=${() => updateProject((p) => { p.activePlanId = c.id; })}>Open</button></td></tr>`)}</tbody></table>
        <button class="small" onClick=${() => setCompare(null)}>Close</button></div>`}
      <div class="seq-body">
        <ol class="steps-list" data-tour="steps">
          ${!tasks.length && html`<li class="empty">No steps yet. Add one on the right, or press <b>Auto-build plan</b> and edit from there.</li>`}
          ${tasks.map((x, i) => {
            const times = sim.taskTimes?.[x.id];
            const asm = x.unit?.type === 'assembly' && plan.assemblies.find((a) => a.id === x.unit.id);
            return html`<li key=${x.id} class=${(x.id === sel ? 'sel ' : '') + (errorSteps.has(i) ? 'flag-err ' : warnSteps.has(i) ? 'flag ' : '') + 'k-' + x.kind + (x.along ? ' along' : '')}
              style=${asm ? { borderLeft: '4px solid ' + asmColor(asm.id) } : null}
              draggable="true" onDragStart=${() => setDragFrom(i)} onDragOver=${(e) => e.preventDefault()}
              onDrop=${() => { if (dragFrom != null && dragFrom !== i) move(dragFrom, i); setDragFrom(null); }}
              onClick=${() => (x.id === sel ? (setSel(null), setT(null)) : select(x.id))}>
              <span class="grip" title="Drag to reorder">⋮⋮</span>
              <span class="idx">${i + 1}</span>
              <span class="dot" style=${{ background: colorOf(x.builder) }} title=${project.builders.find((b) => b.id === x.builder)?.name}></span>
              ${x.along && html`<span class="along-tag" title="Done at the same time as this builder's previous step">+</span>`}
              <span class="icon">${TASK_KINDS[x.kind]?.[0]}</span>
              <span class="label" title=${taskLabel(x, model, plan, project)}>${taskLabel(x, model, plan, project)}</span>
              <span class="time">${times ? fmt(times.start) + '–' + fmt(times.end) : ''}</span>
              <span class="assign" onClick=${(e) => e.stopPropagation()}>
                <button class="small" disabled=${i === 0} onClick=${() => move(i, i - 1)} title="Move up">↑</button>
                <button class="small" disabled=${i === tasks.length - 1} onClick=${() => move(i, i + 1)} title="Move down">↓</button>
                <button class="small" title="Remove step" onClick=${() => { setPlan((pl) => { pl.tasks.splice(i, 1); }); if (x.id === sel) setSel(null); }}>✕</button>
              </span>
            </li>`;
          })}
        </ol>
        <div class="seq-3d">
          <${IsoView} model=${model} styleOf=${styleOf} supports=${state?.supports || []} onPick=${pick}
            label=${editing ? `Click pieces to add/remove them from "${editing.name}"` : t != null ? `At ${fmt(t)}: blue = this step, gray = built, orange = held` : 'Click pieces to pick them for an assembly · colors = assemblies'} />
          <div class="pickbar">
            ${editing ? html`<span class="names">Editing <span class="asm-chip" style=${{ background: asmColor(editing.id) }}>${editing.name}</span>: click pieces to add or take them out.</span>
                <button class="small primary" onClick=${() => setEditAsm(null)}>Done</button>`
            : picked.length ? html`<span class="names"><b>Picked ${picked.length}${maxAsm < Infinity ? ' of max ' + maxAsm : ''}:</b> ${pickedNames.join(' + ')}
                ${picked.length > maxAsm && html` <b class="bad">Too many for one assembly.</b>`}</span>
                <button class="small primary" disabled=${picked.length < 2 || picked.length > maxAsm} onClick=${() => makeAssembly(picked)}>Make assembly</button>
                <button class="small" onClick=${() => setPicked([])}>Clear</button>`
            : html`<span class="names muted">Click pieces in the 3D view to pick ${maxAsm < Infinity ? `2–${maxAsm}` : 'some'} of them, then make them an assembly.</span>`}
          </div>
          <${Problems} sim=${sim} onPick=${(i) => i != null && tasks[i] && select(tasks[i].id)} />
        </div>
      </div>
      <div data-tour="seq-gantt"><${Gantt} result=${sim} t=${t ?? 0} setT=${setT} compact onEdit=${onGanttEdit} onSelect=${select} selected=${sel} /></div>
    </div>
    <aside class="side">
      ${selTask && !form && html`<${TaskEditor} key=${selTask.id} task=${selTask} project=${project} model=${model} sim=${sim} onClose=${() => setSel(null)} onSelect=${select} />`}
      <div data-tour="add-step">
      <${Section} title=${selIndex >= 0 ? `Add a step after step ${selIndex + 1}` : 'Add a step at the end'}>
        ${!form ? html`<div class="add-kinds">${Object.entries(TASK_KINDS).map(([k, [icon, label]]) => html`<button key=${k} onClick=${() => startForm(k)}><span class="icon">${icon}</span>${label}</button>`)}</div>` : html`
          <${SelectField} label="Builder" value=${form.builder} options=${project.builders.map((b) => [b.id, builderLabel(project, b)])} onChange=${(v) => setForm({ ...form, builder: v })} />
          <${SelectField} label="Task" value=${form.kind} options=${Object.entries(TASK_KINDS).map(([k, v]) => [k, v[1]])} onChange=${(v) => setForm(newTask(v, form.builder, project, model, plan, { unit: form.unit, member: form.member }))} />
          <${TaskFields} task=${form} set=${(patch) => setForm({ ...form, ...patch })} project=${project} model=${model} plan=${plan} />
          ${form.kind === 'receive' && html`<${Check} label="Then support it until it stands" checked=${thenSupport} onChange=${setThenSupport} />`}
          ${form.kind === 'bolt' && html`<${Check} label="Then fasten the nuts too" checked=${thenNut} onChange=${setThenNut} />`}
          <${Check} label="At the same time as their previous step (multitask)" checked=${!!form.along} onChange=${(v) => setForm({ ...form, along: v || undefined })} />
          <div class="row"><button class="primary" onClick=${addForm}>Add step</button><button onClick=${() => setForm(null)}>Done</button></div>`}
      <//>
      </div>
      ${unplaced.length > 0 && html`<${Section} title=${`Not placed by any step (${unplaced.length})`}>
        <ul class="list">${unplaced.map((u) => html`<li key=${u.key}><span>${u.name}</span><span class="spacer"></span>
          <button class="small" onClick=${() => startForm('receive', { unit: { type: u.type, id: u.id } })}>Add</button></li>`)}</ul>
      <//>`}
      <div data-tour="assemblies">
      <${Section} title=${`Assemblies (${plan.assemblies.length})`}>
        <${Hint}>${maxAsm < Infinity ? `2 to ${maxAsm} members` : 'Members'} bolted together in the staging yard, then run and placed as one piece. Add bolt and nut steps "in the staging yard" for them; a piece can't be picked up until every nut is on.<//>
        <button class="primary" disabled=${picked.length < 2 || picked.length > maxAsm} onClick=${() => makeAssembly(picked)}
          title="Click pieces in the 3D view first">Make assembly from ${picked.length || 'picked'} piece${picked.length === 1 ? '' : 's'}</button>
        ${plan.assemblies.map((a) => html`<div class=${'asm ' + (editAsm === a.id ? 'editing' : '')} key=${a.id} style=${{ borderLeft: '4px solid ' + asmColor(a.id) }}>
          <div class="row">
            <span class="dot" style=${{ background: asmColor(a.id) }}></span>
            <input type="text" value=${a.name} onInput=${(e) => setPlan((pl) => { pl.assemblies.find((x) => x.id === a.id).name = e.target.value; }, 'asm' + a.id)} />
            <button class="small" onClick=${() => setEditAsm(editAsm === a.id ? null : a.id)}>${editAsm === a.id ? 'Done' : 'Edit'}</button>
            <button class="small danger" onClick=${() => { deleteAssembly(a.id); if (editAsm === a.id) setEditAsm(null); }}>✕</button>
          </div>
          <div class=${a.memberIds.length > maxAsm ? 'bad' : 'muted'}>${a.memberIds.map((id) => model.memberById.get(id)?.name).filter(Boolean).join(' + ') || 'No members yet.'}</div>
        </div>`)}
      <//>
      </div>
    </aside>
  </div>`;
}

export function Problems({ sim, onPick }) {
  if (!sim.errors.length && !sim.warnings.length) return html`<div class="problems ok">No problems found.</div>`;
  const label = (s) => (s == null || s < 0 ? 'Plan' : 'Step ' + (s + 1));
  return html`<div class="problems">
    ${sim.errors.map((e) => html`<div class="err" onClick=${() => onPick && onPick(e.step)}><b>${label(e.step)}</b> ${e.msg}</div>`)}
    ${sim.warnings.map((e) => html`<div class="warn" onClick=${() => onPick && onPick(e.step)}><b>${label(e.step)}</b> ${e.msg}</div>`)}
  </div>`;
}
