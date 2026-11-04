// Sequence tab: the plan is built on a timeline. Tasks are dragged from a list onto a builder's row,
// a pop-up asks which piece or connection each is about, and marks on the timeline show what's still
// missing. Each builder does their steps in order, starting each as soon as they're free and what
// it needs is ready. The simulation re-runs on every change.
import { html, useEffect, useMemo, useRef, useState } from '../lib/preact.js';
import { updateProject } from '../model/store.js';
import { uid } from '../model/ids.js';
import { activePlan, emptyPlan } from '../model/schema.js';
import { autoOrderSteps, layOutAssembly, planUnits, sideOf, unitKey } from '../model/plan.js';
import { ASM_COLORS, TASK_KINDS, applyAssembly, dissolveAssembly, insertAtSlot, planChecks, removeTask, shortLabel, taskBlocks, taskGroup } from '../model/timeline.js';
import { fmt, fmtCost, planTasks, simulate } from '../sim/simulate.js';
import { stateAt } from '../sim/playback.js';
import { IsoView } from './IsoView.js';
import { Timeline } from './Timeline.js';
import { AssemblyPopup, ConnectionPopup, PiecePopup, Popup, firstViewFor } from './TaskPopups.js';
import { Check, Hint, NumField, Section, SelectField, TextField, isTyping } from './common.js';

export { ASM_COLORS, TASK_KINDS };

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
    case 'assembly': {
      const a = plan.assemblies.find((x) => x.id === task.assemblyId);
      return a ? html`<${TextField} label="Name" value=${a.name} onChange=${(v) => setActive((pl) => { pl.assemblies.find((x) => x.id === a.id).name = v; }, 'asm' + a.id)} />
        <${Hint}>${a.memberIds.map((id) => model.memberById.get(id)?.name).filter(Boolean).join(' + ')}. This builder does every bolt and nut inside it that no other step takes.<//>` : null;
    }
    default: return null;
  }
}

const setActive = (fn, key) => updateProject((p) => fn(activePlan(p)), { key });

const REPICK = { run: 1, receive: 1, support: 1, bolt: 1, nut: 1, assembly: 1, stand: 1 };

// Edit one step; used beside the timeline and under the one in the Simulate tab.
export function TaskEditor({ task, project, model, sim, onClose, onSelect, onRepick = null }) {
  const plan = activePlan(project);
  const [takeover, setTakeover] = useState('');
  const [afterId, setAfterId] = useState('');
  if (!task) return null;
  const set = (patch) => setActive((pl) => { Object.assign(pl.tasks.find((t) => t.id === task.id), patch); }, 'task' + task.id + Object.keys(patch)[0]);
  const others = project.builders.filter((b) => b.id !== task.builder);
  const taker = takeover || others[0]?.id;
  const theirs = plan.tasks.filter((t) => t.builder === taker);
  // By default, once they finish whatever they're doing when this support begins.
  const begins = sim?.taskTimes?.[task.id]?.start ?? 0;
  const after = theirs.find((t) => t.id === afterId) || theirs.find((t) => (sim?.taskTimes?.[t.id]?.end ?? 0) >= begins) || theirs[theirs.length - 1];
  return html`<${Section} title=${TASK_KINDS[task.kind]?.[1] || 'Step'}>
    <div class="small"><b>${shortLabel(task, model, plan, project)}</b></div>
    ${onRepick && REPICK[task.kind] && html`<button data-repick onClick=${() => onRepick(task)}>${task.kind === 'assembly' ? 'Change its pieces…' : task.kind === 'bolt' || task.kind === 'nut' ? 'Change the two pieces…' : 'Change the piece…'}</button>`}
    <${SelectField} label="Builder" value=${task.builder} options=${project.builders.map((b) => [b.id, builderLabel(project, b)])} onChange=${(v) => set({ builder: v })} />
    <${TaskFields} task=${task} set=${set} project=${project} model=${model} plan=${plan} />
    <${Check} label="At the same time as their previous step (multitask)" checked=${!!task.along}
      title="Starts once their previous step has started, and doesn't move them. It takes longer by the multitasking slowdown in Crew → Timing."
      onChange=${(v) => set({ along: v || undefined })} />
    ${task.kind === 'support' && others.length > 0 && html`<div class="swap">
      <b>Hand over to someone else</b>
      <${SelectField} label="Builder" value=${taker} options=${others.map((b) => [b.id, builderLabel(project, b)])} onChange=${setTakeover} />
      ${theirs.length > 0 && html`<${SelectField} label="After their step" value=${after?.id} options=${theirs.map((t) => [t.id, shortLabel(t, model, plan, project)])} onChange=${setAfterId} />`}
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
      <button class="danger" onClick=${() => { setActive((pl) => removeTask(pl, model, task.id)); onClose && onClose(); }}>Delete step</button>
      ${onClose && html`<button onClick=${onClose}>Close</button>`}
    </div>
  <//>`;
}

const CHIP_TITLES = { pieces: 'Pieces placed', bolts: 'Bolts placed', nuts: 'Nuts fastened' };

function draftTask(kind, builder, project) {
  const out = { kind, builder };
  if (kind === 'tool' || kind === 'pass') out.toolId = project.tools[0]?.id;
  if (kind === 'pass') out.to = project.builders.find((b) => b.id !== builder)?.id;
  if (kind === 'other') { out.text = ''; out.duration = 10; }
  return out;
}

export function SequenceTab({ project, model, sim }) {
  const plan = activePlan(project);
  const tasks = plan.tasks || [];
  const [sel, setSel] = useState(null);
  const [t, setT] = useState(null); // the moment shown in the 3D view
  const [compare, setCompare] = useState(null);
  const [drag, setDrag] = useState(null); // a task being dragged from a list: {kind, preset, label, x, y}
  const [pending, setPending] = useState(null); // a task waiting for its pop-up: {kind, slot, at, carried, editId, editing, draft}
  const [thenSupport, setThenSupport] = useState(true);
  const [standAction, setStandAction] = useState('place');
  const [standTool, setStandTool] = useState('');
  const [filter, setFilter] = useState(null); // which group of "still to do" to show
  const api = useRef(null);

  const setPlan = (fn, key) => updateProject((p) => fn(activePlan(p)), { key });
  const selTask = tasks.find((x) => x.id === sel);
  const { units, inAssembly } = planUnits(model, plan);
  const checks = useMemo(() => planChecks(project, model, plan, sim), [sim, model]);
  const startOf = (id) => sim.taskStarts?.[id] ?? null;
  const select = (id) => {
    if (id === sel) { setSel(null); return; }
    setSel(id);
    const times = sim.taskTimes?.[id];
    if (times) setT(times.end);
  };

  // --- putting a task on the timeline ---
  // A piece on a footing stands by itself, so it doesn't need supporting when it's placed.
  const onFooting = (u) => !!u && u.memberIds.some((id) => model.memberById.get(id)?.bearing);
  const unitOfMember = (memberId) => (inAssembly.has(memberId) ? { type: 'assembly', id: inAssembly.get(memberId) } : { type: 'member', id: memberId });
  const addTasks = (slot, list) => {
    setPlan((pl) => insertAtSlot(pl.tasks, list, slot, startOf));
    setSel(list[0].id);
    setPending(null);
  };
  const commit = (fields, extras = []) => {
    const { kind, slot, editId } = pending;
    if (editId) {
      setPlan((pl) => { Object.assign(pl.tasks.find((x) => x.id === editId), fields); });
      setPending(null);
      return;
    }
    addTasks(slot, [{ id: uid('k'), kind, builder: slot.builder, ...fields }, ...extras.map((x) => ({ id: uid('k'), builder: slot.builder, ...x }))]);
  };
  const openTask = (kind, slot, preset = null) => {
    // When a step dropped here gets started, near enough, for what's available by then.
    const mine = (taskBlocks(plan, sim, project).get(slot.builder) || []).filter((b) => !b.along);
    const main = slot.with ? mine.find((b) => b.task.id === slot.with) : null;
    const next = slot.before ? mine.findIndex((b) => b.task.id === slot.before) : mine.length;
    const at = main ? main.start : Math.max(slot.time, mine[next - 1]?.end ?? 0);
    const carried = main?.task.unit && (main.task.kind === 'run' || main.task.kind === 'receive') ? units.find((u) => u.key === unitKey(main.task.unit)) : null;
    if (preset) {
      const list = [{ id: uid('k'), kind, builder: slot.builder, ...preset, ...(kind === 'support' ? { until: 'auto' } : {}) }];
      if (kind === 'receive' && thenSupport) {
        const u = units.find((x) => x.key === unitKey(preset.unit));
        if (u && !onFooting(u)) list.push({ id: uid('k'), kind: 'support', builder: slot.builder, member: u.memberIds[0], until: 'auto' });
      }
      addTasks(slot, list);
      return;
    }
    const draft = kind === 'tool' || kind === 'pass' || kind === 'other' ? draftTask(kind, slot.builder, project) : null;
    setPending({ kind, slot, at, carried, draft });
  };
  const repick = (task) => setPending({ kind: task.kind, editId: task.id, slot: { builder: task.builder }, at: sim.taskStarts?.[task.id] ?? 0, editing: task });

  const pickPiece = (memberId) => {
    const { kind, editId } = pending;
    const footed = onFooting(units.find((x) => x.key === unitKey(unitOfMember(memberId))));
    if (kind === 'run' || kind === 'receive') commit({ unit: unitOfMember(memberId) }, kind === 'receive' && thenSupport && !editId && !footed ? [{ kind: 'support', member: memberId, until: 'auto' }] : []);
    else if (kind === 'support') commit(editId ? { member: memberId } : { member: memberId, until: 'auto' });
    else if (kind === 'stand') commit({ member: memberId, action: standAction, toolId: standTool || project.tools.find((x) => x.kind === 'support')?.id });
  };
  const finishConnection = ({ also, ...fields }) => {
    commit(fields, also ? [{ kind: 'nut', jointId: fields.jointId, boltIds: fields.boltIds, member: fields.member, where: fields.where === 'hand' ? 'bridge' : fields.where }] : []);
  };
  const finishAssembly = ({ ids, name, layOut }) => {
    const { slot, editId, editing } = pending;
    const id = editing ? editing.assemblyId : uid('as');
    const task = { id: uid('k'), kind: 'assembly', builder: slot.builder, assemblyId: id };
    updateProject((p) => {
      const pl = activePlan(p);
      const a = applyAssembly(pl, model, ids, { id, name });
      if (layOut) layOutAssembly(p, model, a);
      if (!editId) insertAtSlot(pl.tasks, [task], slot, startOf);
    });
    if (!editId) setSel(task.id);
    setPending(null);
  };

  // --- dragging a task out of a list ---
  const dragging = !!drag;
  const dragRef = useRef(null);
  dragRef.current = { openTask, drag };
  useEffect(() => {
    if (!dragging) return;
    const move = (e) => setDrag((d) => d && { ...d, x: e.clientX, y: e.clientY });
    const up = (e) => {
      const { drag: d, openTask: open } = dragRef.current;
      const slot = api.current?.slotAt(e.clientX, e.clientY, new Set());
      setDrag(null);
      if (slot && d) open(d.kind, slot, d.preset);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
  }, [dragging]);
  const beginDrag = (e, kind, label, preset = null) => {
    if (e.button !== 0) return;
    e.preventDefault();
    setDrag({ kind, label, preset, x: e.clientX, y: e.clientY });
  };

  useEffect(() => {
    const key = (e) => {
      if (isTyping(e) || pending || !sel) return;
      if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); setPlan((pl) => removeTask(pl, model, sel)); setSel(null); }
      if (e.key === 'Escape') setSel(null);
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  });

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
  const clearAll = () => {
    if (!confirm('Take every step off the timeline and undo its assemblies? (Ctrl+Z brings them back.)')) return;
    setPlan((pl) => { pl.tasks = []; pl.assemblies = []; pl.steps = []; });
    setSel(null);
    setT(null);
  };

  // --- assemblies ---
  const asmOf = new Map();
  for (const a of plan.assemblies) for (const m of a.memberIds) asmOf.set(m, a.id);
  const asmColor = (asmId) => ASM_COLORS[Math.max(0, plan.assemblies.findIndex((a) => a.id === asmId)) % ASM_COLORS.length];

  // --- 3D view: the bridge at the chosen moment, the selected step's members picked out ---
  const state = useMemo(() => (t != null ? stateAt(sim, t) : null), [sim, t]);
  const selMembers = new Set();
  if (selTask) {
    if (selTask.member) selMembers.add(selTask.member);
    if (selTask.unit) units.find((u) => u.key === unitKey(selTask.unit))?.memberIds.forEach((id) => selMembers.add(id));
    if (selTask.jointId) { const c = model.contacts.find((x) => x.id === selTask.jointId); if (c) { selMembers.add(c.a); selMembers.add(c.b); } }
    if (selTask.kind === 'assembly') plan.assemblies.find((a) => a.id === selTask.assemblyId)?.memberIds.forEach((id) => selMembers.add(id));
  }
  const styleOf = (m) => {
    if (selMembers.has(m.id)) return { color: '#2563eb', outline: '#1d4ed8' };
    if (state) {
      const ms = state.members.get(m.id);
      if (ms?.loc === 'bridge') return { color: STATUS_COLORS[ms.status] || '#475569' };
      return asmOf.has(m.id) ? { color: asmColor(asmOf.get(m.id)), opacity: 0.35 } : { color: '#cbd5e1', opacity: 0.4, dash: '2 2' };
    }
    return asmOf.has(m.id) ? { color: asmColor(asmOf.get(m.id)) } : { color: '#94a3b8' };
  };

  const runCompare = () => setCompare(project.plans.map((pl) => {
    const r = simulate(project, pl);
    return { id: pl.id, name: pl.name, end: r.endTime, cost: r.cost, errors: r.errors.length, holds: r.holds.reduce((a, h) => a + h.duration, 0), aborted: r.aborted };
  }));
  const nameOfStep = (i) => {
    const x = tasks[i];
    return x ? `${project.builders.find((b) => b.id === x.builder)?.name || '?'} · ${shortLabel(x, model, plan, project)}` : null;
  };
  const groupOf = { pieces: 'piece', bolts: 'bolt', nuts: 'nut', support: 'support' };
  const shownTodo = checks.todo.filter((x) => !filter || x.group === groupOf[filter]);
  const chip = (id) => {
    const c = checks[id];
    return html`<button key=${id} class=${'chk ' + (c.done === c.total ? 'ok' : 'todo') + (filter === id ? ' on' : '')} data-check=${id} title="Show what's left of these" onClick=${() => setFilter(filter === id ? null : id)}>
      ${c.done === c.total ? '✔' : '○'} ${CHIP_TITLES[id]} <b>${c.done}/${c.total}</b></button>`;
  };

  // --- the pop-up for the task that just landed ---
  const popup = () => {
    if (!pending) return null;
    const { kind, slot, at, carried, editing, draft } = pending;
    const close = () => setPending(null);
    const who = project.builders.find((b) => b.id === slot.builder)?.name;
    const first = firstViewFor(project, kind, slot.builder);
    const shared = { project, model, plan, sim, onClose: close };
    if (kind === 'run' || kind === 'receive' || kind === 'support' || kind === 'stand') {
      const stands = project.tools.filter((x) => x.kind === 'support');
      const extra = kind === 'receive' && !editing ? html`<${Check} label="Then support it until it stands" title="Not added for a piece on a footing, which stands by itself" checked=${thenSupport} onChange=${setThenSupport} />`
        : kind === 'stand' ? html`<${SelectField} label="Action" value=${standAction} options=${[['place', 'Place it'], ['remove', 'Remove it']]} onChange=${setStandAction} />
          ${stands.length ? html`<${SelectField} label="Tool" value=${standTool || stands[0].id} options=${stands.map((x) => [x.id, x.name])} onChange=${setStandTool} />` : html`<${Hint}>No support tools yet. Add one in the Tools tab.<//>`}` : null;
      return html`<${PiecePopup} ...${shared} kind=${kind} title=${`${who}: ${TASK_KINDS[kind][1]}. Which piece?`} builderId=${slot.builder} t=${at} firstView=${first} onPick=${pickPiece} extra=${extra} />`;
    }
    if (kind === 'bolt' || kind === 'nut') {
      return html`<${ConnectionPopup} ...${shared} kind=${kind} title=${`${who}: ${TASK_KINDS[kind][1]}. Between which two pieces?`} t=${at} firstView=${first} carried=${carried} initial=${editing || null} onDone=${finishConnection} />`;
    }
    if (kind === 'assembly') {
      const initial = editing ? plan.assemblies.find((a) => a.id === editing.assemblyId) : null;
      return html`<${AssemblyPopup} project=${project} model=${model} plan=${plan} onClose=${close} title=${initial ? `Which pieces go in ${initial.name}?` : `${who}: Make an assembly. Which pieces?`} initial=${initial} onDone=${finishAssembly} />`;
    }
    return html`<${Popup} title=${`${who}: ${TASK_KINDS[kind][1]}`} onClose=${close} wide=${false}>
      <div class="pop-simple">
        <${TaskFields} task=${draft} set=${(patch) => setPending({ ...pending, draft: { ...draft, ...patch } })} project=${project} model=${model} plan=${plan} />
        <div class="row"><span class="spacer"></span><button onClick=${close}>Cancel</button>
          <button class="primary" data-confirm onClick=${() => { const { kind: _k, builder: _b, ...fields } = draft; commit(fields); }}>Add step</button></div>
      </div>
    <//>`;
  };

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
        <button title="Start a new, empty plan" onClick=${() => updateProject((p) => { const pl = emptyPlan('Plan ' + (p.plans.length + 1)); p.plans.push(pl); p.activePlanId = pl.id; })}>New</button>
        <button disabled=${project.plans.length < 2} onClick=${() => confirm(`Delete plan "${plan.name}"?`) && updateProject((p) => { p.plans = p.plans.filter((x) => x.id !== plan.id); p.activePlanId = p.plans[0].id; })}>Delete</button>
        <button onClick=${runCompare}>Compare plans</button>
        <span class="sep"></span>
        <button title="Fill in a working plan you can then edit: footings first, west to east, trusses before laterals" onClick=${autoBuild}>Auto-build plan</button>
        <button disabled=${!tasks.length} title="Take every step off the timeline" onClick=${clearAll}>Clear timeline</button>
        <span class="spacer"></span>
        <span data-tour="total" class=${'total ' + (sim.errors.length ? 'bad' : '')} title="Construction cost uses this year's formula (number of builders × minutes × rate)">
          ${sim.aborted ? 'Plan gets stuck' : html`Build time ${fmt(sim.endTime)}${sim.cost != null && html` <span class="cost">· ${fmtCost(sim.cost)}</span>`}`}</span>
      </div>
      ${compare && html`<div class="compare">
        <table class="grid"><thead><tr><th>Plan</th><th>Build time</th><th>Construction cost</th><th>Total holding</th><th>Problems</th><th></th></tr></thead>
        <tbody>${compare.map((c) => html`<tr class=${c.id === plan.id ? 'sel' : ''}><td>${c.name}</td><td>${c.aborted ? 'incomplete' : fmt(c.end)}</td><td>${c.aborted ? '–' : fmtCost(c.cost)}</td><td>${fmt(c.holds)}</td><td class=${c.errors ? 'bad' : 'ok'}>${c.errors || '—'}</td>
          <td><button class="small" onClick=${() => updateProject((p) => { p.activePlanId = c.id; })}>Open</button></td></tr>`)}</tbody></table>
        <button class="small" onClick=${() => setCompare(null)}>Close</button></div>`}
      <div class="seq-checks" data-tour="seq-checks">
        ${chip('pieces')}${chip('bolts')}${chip('nuts')}
        <button class=${'chk ' + (checks.falls ? 'bad' : 'ok') + (filter === 'support' ? ' on' : '')} data-check="support" title="Pieces nobody is holding up at some point in the plan" onClick=${() => setFilter(filter === 'support' ? null : 'support')}>
          ${checks.falls ? html`⚠ ${checks.falls} would fall` : '✔ Nothing falls'}</button>
        <span class=${'chk plain ' + (sim.errors.length ? 'bad' : sim.warnings.length ? 'todo' : 'ok')}>${sim.errors.length} problem${sim.errors.length === 1 ? '' : 's'}, ${sim.warnings.length} warning${sim.warnings.length === 1 ? '' : 's'}</span>
      </div>
      <div class="seq-top">
        <div class="palette" data-tour="seq-palette">
          <div class="palette-title">Drag onto a builder</div>
          ${Object.entries(TASK_KINDS).map(([k, [icon, label, what]]) => html`<div key=${k} class="palette-item" data-kind=${k} title=${what} onPointerDown=${(e) => beginDrag(e, k, label)}>
            <span class="ic">${icon}</span>${label}</div>`)}
        </div>
        <${Timeline} project=${project} model=${model} plan=${plan} sim=${sim} checks=${checks} t=${t ?? 0} setT=${setT} selected=${sel} onSelect=${select}
          dragging=${drag} apiRef=${api}
          onMove=${(id, slot) => setPlan((pl) => insertAtSlot(pl.tasks, taskGroup(pl.tasks, id), slot, startOf))}
          onEdit=${(id, patch) => setPlan((pl) => { Object.assign(pl.tasks.find((x) => x.id === id) || {}, patch); })} />
      </div>
      <div class="seq-bottom">
        <div class="seq-3d">
          <${IsoView} model=${model} styleOf=${styleOf} supports=${state?.supports || []}
            label=${t != null ? `At ${fmt(t)}: blue = this step, gray = built, orange = held` : 'Click the time along the top of the timeline to see the bridge at that moment'} />
        </div>
        <div class="seq-problems"><${Problems} sim=${sim} nameOf=${nameOfStep} onPick=${(i) => i != null && tasks[i] && select(tasks[i].id)} /></div>
      </div>
    </div>
    <aside class="side">
      ${selTask && html`<${TaskEditor} key=${selTask.id} task=${selTask} project=${project} model=${model} sim=${sim} onClose=${() => setSel(null)} onSelect=${setSel} onRepick=${repick} />`}
      <div data-tour="seq-todo">
      <${Section} title=${`Still to do (${shownTodo.length})`}>
        ${!checks.todo.length && html`<div class="ok small">Every piece, bolt and nut has a step.</div>`}
        ${checks.todo.length > 0 && html`<${Hint}>Drag one onto a builder's row to add it as it is.${filter ? ' ' : ''}${filter && html`<a href="#" onClick=${(e) => { e.preventDefault(); setFilter(null); }}>Show all</a>`}<//>`}
        <ul class="todo">${shownTodo.map((x) => html`<li key=${x.id} class=${'todo-' + x.group} data-todo=${x.id} onPointerDown=${(e) => beginDrag(e, x.kind, x.text, x.preset)}>
          <span class="ic">${TASK_KINDS[x.kind]?.[0]}</span><span>${x.text}</span></li>`)}</ul>
      <//>
      </div>
      <div data-tour="assemblies">
      <${Section} title=${`Assemblies (${plan.assemblies.length})`}>
        <${Hint}>Drag <b>Make an assembly</b> onto a builder to add one.<//>
        ${plan.assemblies.map((a) => html`<div class="asm" key=${a.id} style=${{ borderLeft: '4px solid ' + asmColor(a.id) }}>
          <div class="row">
            <span class="dot" style=${{ background: asmColor(a.id) }}></span>
            <input type="text" value=${a.name} onInput=${(e) => setPlan((pl) => { pl.assemblies.find((x) => x.id === a.id).name = e.target.value; }, 'asm' + a.id)} />
            <button class="small" title="Change its pieces" onClick=${() => setPending({ kind: 'assembly', editId: a.id, slot: { builder: project.builders[0]?.id }, at: 0, editing: { assemblyId: a.id } })}>Edit</button>
            <button class="small danger" title="Back to loose pieces" onClick=${() => { setPlan((pl) => dissolveAssembly(pl, model, a.id)); setSel(null); }}>✕</button>
          </div>
          <div class="muted">${a.memberIds.map((id) => model.memberById.get(id)?.name).filter(Boolean).join(' + ') || 'No members yet.'}</div>
        </div>`)}
      <//>
      </div>
    </aside>
    ${drag && html`<div class="tl-ghost" style=${{ left: drag.x + 10 + 'px', top: drag.y + 8 + 'px' }}><span class="ic">${TASK_KINDS[drag.kind]?.[0]}</span> ${drag.label}</div>`}
    ${popup()}
  </div>`;
}

export function Problems({ sim, onPick, nameOf = null }) {
  if (!sim.errors.length && !sim.warnings.length) return html`<div class="problems ok">No problems found.</div>`;
  const label = (s) => (s == null || s < 0 ? 'Plan' : nameOf?.(s) || 'Step ' + (s + 1));
  return html`<div class="problems">
    ${sim.errors.map((e, i) => html`<div class="err" key=${'e' + i} onClick=${() => onPick && onPick(e.step)}><b>${label(e.step)}</b> ${e.msg}</div>`)}
    ${sim.warnings.map((e, i) => html`<div class="warn" key=${'w' + i} onClick=${() => onPick && onPick(e.step)}><b>${label(e.step)}</b> ${e.msg}</div>`)}
  </div>`;
}
