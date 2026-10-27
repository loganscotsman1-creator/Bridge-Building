// Sequence tab: the build order. Reorder steps, group members into assemblies, assign builders,
// add temporary supports, and compare plan variants. The simulation re-runs on every change.
import { html, useMemo, useState } from '../lib/preact.js';
import { updateProject } from '../model/store.js';
import { uid } from '../model/ids.js';
import { activePlan, emptyPlan } from '../model/schema.js';
import { autoOrderSteps, installStep, planUnits, stepLabel, unitKey } from '../model/plan.js';
import { fmt, fmtCost, simulate } from '../sim/simulate.js';
import { IsoView } from './IsoView.js';
import { Hint, Section, SelectField } from './common.js';

const KIND_ICON = { install: '⬆', build: '⚒', support: '▲' };
// One color per assembly, used in the 3D view and the step list.
export const ASM_COLORS = ['#9333ea', '#0891b2', '#db2777', '#65a30d', '#ea580c', '#4f46e5', '#0d9488', '#b91c1c', '#ca8a04', '#7c3aed'];

export function SequenceTab({ project, model, sim }) {
  const plan = activePlan(project);
  const [selStep, setSelStep] = useState(null);
  const [editAsm, setEditAsm] = useState(null);
  const [dragFrom, setDragFrom] = useState(null);
  const [compare, setCompare] = useState(null);
  const [picked, setPicked] = useState([]); // member ids picked in the 3D view

  const setPlan = (fn, key) => updateProject((p) => fn(p.plans.find((x) => x.id === p.activePlanId)), { key });
  const steps = plan.steps;
  const { units } = planUnits(model, plan);
  const sequenced = new Set(steps.filter((s) => s.kind === 'install').map((s) => unitKey(s.unit)));
  const unsequenced = units.filter((u) => !sequenced.has(u.key));
  const selIndex = steps.findIndex((s) => s.id === selStep);
  const errorSteps = new Set([...sim.errors, ...sim.warnings].map((e) => e.step));

  const move = (from, to) => setPlan((pl) => {
    const [s] = pl.steps.splice(from, 1);
    pl.steps.splice(to, 0, s);
  });

  const builderOpts = (extra = []) => [['auto', 'Auto'], ...extra, ...project.builders.map((b) => [b.id, b.name])];

  // --- assemblies ---
  const rules = project.site.rules || {};
  const maxAsm = rules.maxAssemblyMembers ?? Infinity;
  const asmZones = project.site.zones.filter((z) => (rules.assemblyIn === 'assembly' ? z.type === 'assembly' : z.type === 'staging'));
  const createAssembly = () => {
    const id = uid('as');
    setPlan((pl) => {
      pl.assemblies.push({ id, name: 'Assembly ' + (pl.assemblies.length + 1), memberIds: [], areaZoneId: null });
    });
    setEditAsm(id);
  };

  const toggleMember = (asmId, memberId) => {
    const cur = plan.assemblies.find((x) => x.id === asmId);
    if (cur && !cur.memberIds.includes(memberId) && cur.memberIds.length >= maxAsm) {
      alert(`An assembly can have at most ${maxAsm} members under this year's rules (10.3.7).`);
      return;
    }
    setPlan((pl) => {
    const a = pl.assemblies.find((x) => x.id === asmId);
    if (!a) return;
    if (a.memberIds.includes(memberId)) {
      a.memberIds = a.memberIds.filter((m) => m !== memberId);
      // Back to an individual piece: install it where the assembly is installed.
      const at = pl.steps.findIndex((s) => s.kind === 'install' && s.unit.type === 'assembly' && s.unit.id === asmId);
      pl.steps.splice(at >= 0 ? at + 1 : pl.steps.length, 0, installStep({ type: 'member', id: memberId }));
      return;
    }
    for (const other of pl.assemblies) other.memberIds = other.memberIds.filter((m) => m !== memberId);
    a.memberIds.push(memberId);
    const idx = pl.steps.findIndex((s) => s.kind === 'install' && s.unit.type === 'member' && s.unit.id === memberId);
    const hasInstall = pl.steps.some((s) => s.kind === 'install' && s.unit.type === 'assembly' && s.unit.id === asmId);
    const hasBuild = pl.steps.some((s) => s.kind === 'build' && s.assemblyId === asmId);
    if (idx >= 0) pl.steps.splice(idx, 1);
    const pos = idx >= 0 ? idx : pl.steps.length;
    if (!hasInstall) pl.steps.splice(pos, 0, installStep({ type: 'assembly', id: asmId }));
    if (!hasBuild) {
      const inst = pl.steps.findIndex((s) => s.kind === 'install' && s.unit.type === 'assembly' && s.unit.id === asmId);
      pl.steps.splice(Math.max(0, inst), 0, { id: uid('s'), kind: 'build', assemblyId: asmId, builder: 'auto' });
    }
    });
  };

  // Make one assembly out of the pieces picked in the 3D view. They leave any assembly they were
  // in, and the new assembly's assemble + install steps go where the first of them was installed.
  const makeAssembly = (ids) => {
    if (ids.length < 2 || ids.length > maxAsm) return;
    const id = uid('as');
    setPlan((pl) => {
      const isStepOf = (s, mid) => s.kind === 'install' && ((s.unit.type === 'member' && s.unit.id === mid) || (s.unit.type === 'assembly' && pl.assemblies.find((a) => a.id === s.unit.id)?.memberIds.includes(mid)));
      const positions = ids.map((mid) => pl.steps.findIndex((s) => isStepOf(s, mid))).filter((i) => i >= 0);
      const pos = positions.length ? Math.min(...positions) : pl.steps.length;
      const anchor = pl.steps[pos];
      // Pull the pieces out of other assemblies (an assembly left with one piece goes back to a member).
      for (const a of pl.assemblies) {
        if (!a.memberIds.some((m) => ids.includes(m))) continue;
        a.memberIds = a.memberIds.filter((m) => !ids.includes(m));
        if (a.memberIds.length <= 1) {
          const at = pl.steps.findIndex((s) => s.kind === 'install' && s.unit.type === 'assembly' && s.unit.id === a.id);
          pl.steps = pl.steps.filter((s) => !((s.kind === 'install' && s.unit.type === 'assembly' && s.unit.id === a.id) || (s.kind === 'build' && s.assemblyId === a.id)));
          if (a.memberIds.length === 1) pl.steps.splice(at >= 0 ? Math.min(at, pl.steps.length) : pl.steps.length, 0, installStep({ type: 'member', id: a.memberIds[0] }));
          a.memberIds = [];
        }
      }
      pl.assemblies = pl.assemblies.filter((a) => a.memberIds.length);
      pl.steps = pl.steps.filter((s) => !(s.kind === 'install' && s.unit.type === 'member' && ids.includes(s.unit.id)));
      let at = anchor ? pl.steps.indexOf(anchor) : -1;
      if (at < 0) at = Math.min(pos, pl.steps.length);
      pl.assemblies.push({ id, name: 'Assembly ' + (pl.assemblies.length + 1), memberIds: [...ids], areaZoneId: null });
      pl.steps.splice(at, 0, { id: uid('s'), kind: 'build', assemblyId: id, builder: 'auto' }, installStep({ type: 'assembly', id }));
    });
    setPicked([]);
  };

  const pick = (m) => {
    if (editing) { toggleMember(editing.id, m.id); return; }
    setPicked(picked.includes(m.id) ? picked.filter((x) => x !== m.id) : [...picked, m.id]);
  };

  const deleteAssembly = (asmId) => setPlan((pl) => {
    const a = pl.assemblies.find((x) => x.id === asmId);
    const at = pl.steps.findIndex((s) => s.kind === 'install' && s.unit.type === 'assembly' && s.unit.id === asmId);
    pl.steps = pl.steps.filter((s) => !((s.kind === 'install' && s.unit.type === 'assembly' && s.unit.id === asmId) || (s.kind === 'build' && s.assemblyId === asmId)));
    const pos = at >= 0 ? Math.min(at, pl.steps.length) : pl.steps.length;
    pl.steps.splice(pos, 0, ...a.memberIds.map((id) => installStep({ type: 'member', id })));
    pl.assemblies = pl.assemblies.filter((x) => x.id !== asmId);
  });

  // --- 3D highlight ---
  const highlight = useMemo(() => {
    const before = new Set(), now = new Set(), building = new Set();
    const memberIdsOf = (s) => {
      if (s.kind === 'install') return s.unit.type === 'assembly' ? plan.assemblies.find((a) => a.id === s.unit.id)?.memberIds || [] : [s.unit.id];
      if (s.kind === 'build') return plan.assemblies.find((a) => a.id === s.assemblyId)?.memberIds || [];
      return [];
    };
    steps.forEach((s, i) => {
      if (selIndex < 0) return;
      if (i < selIndex && s.kind === 'install') memberIdsOf(s).forEach((m) => before.add(m));
      if (i === selIndex) memberIdsOf(s).forEach((m) => (s.kind === 'build' ? building : now).add(m));
    });
    return { before, now, building };
  }, [steps, selIndex, plan.assemblies]);

  const editing = editAsm && plan.assemblies.find((a) => a.id === editAsm);
  const asmOf = new Map();
  for (const a of plan.assemblies) for (const m of a.memberIds) asmOf.set(m, a.id);
  const asmColor = (asmId) => ASM_COLORS[Math.max(0, plan.assemblies.findIndex((a) => a.id === asmId)) % ASM_COLORS.length];
  const baseStyle = (m) => {
    if (editing) {
      if (editing.memberIds.includes(m.id)) return { color: asmColor(editing.id) };
      if (asmOf.has(m.id)) return { color: asmColor(asmOf.get(m.id)), opacity: 0.45 };
      return { color: '#94a3b8', opacity: 0.6 };
    }
    if (selIndex < 0) return asmOf.has(m.id) ? { color: asmColor(asmOf.get(m.id)) } : { color: '#94a3b8' };
    if (highlight.now.has(m.id)) return { color: '#f97316' };
    if (highlight.building.has(m.id)) return { color: asmColor(asmOf.get(m.id)) };
    if (highlight.before.has(m.id)) return { color: '#475569' };
    return { color: '#cbd5e1', opacity: 0.5, dash: '2 2' };
  };
  const styleOf = (m) => {
    const st = baseStyle(m);
    return picked.includes(m.id) ? { ...st, color: '#facc15', outline: '#b45309', opacity: 1 } : st;
  };
  const pickedNames = picked.map((id) => model.memberById.get(id)?.name).filter(Boolean);
  const pickedAsms = [...new Set(picked.map((id) => asmOf.get(id)).filter(Boolean))].map((id) => plan.assemblies.find((a) => a.id === id));
  const unitMembers = (s) => (s.kind === 'install' && s.unit.type === 'assembly' ? s.unit.id : s.kind === 'build' ? s.assemblyId : null);
  const supportsAt = selIndex < 0 ? [] : (() => {
    const placed = new Map();
    steps.slice(0, selIndex + 1).forEach((s) => {
      if (s.kind !== 'support') return;
      const key = s.toolId + '@' + s.memberId;
      if (s.action === 'place') placed.set(key, { key, memberId: s.memberId }); else placed.delete(key);
    });
    return [...placed.values()];
  })();

  const runCompare = () => setCompare(project.plans.map((pl) => {
    const r = simulate(project, pl);
    return { id: pl.id, name: pl.name, end: r.endTime, cost: r.cost, errors: r.errors.length, holds: r.holds.reduce((a, h) => a + h.duration, 0), aborted: r.aborted };
  }));

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
        <button title="Start from the footings and work west to east, trusses before laterals. Supports stay at the start and end." onClick=${() => {
          if (steps.length && !confirm('Replace the order with an automatic west-to-east order?')) return;
          setPlan((pl) => {
            const places = pl.steps.filter((s) => s.kind === 'support' && s.action === 'place');
            const removes = pl.steps.filter((s) => s.kind === 'support' && s.action === 'remove');
            pl.steps = [...places, ...autoOrderSteps(model, pl), ...removes];
          });
        }}>Auto order</button>
        <span class="spacer"></span>
        <span data-tour="total" class=${'total ' + (sim.errors.length ? 'bad' : '')} title="Construction cost uses this year's formula (number of builders × minutes × rate)">
          ${sim.aborted ? 'Stops at step ' + ((sim.errors.at(-1)?.step ?? 0) + 1) : html`Build time ${fmt(sim.endTime)}${sim.cost != null && html` <span class="cost">· ${fmtCost(sim.cost)}</span>`}`}</span>
      </div>
      ${compare && html`<div class="compare">
        <table class="grid"><thead><tr><th>Plan</th><th>Build time</th><th>Construction cost</th><th>Total holding</th><th>Problems</th><th></th></tr></thead>
        <tbody>${compare.map((c) => html`<tr class=${c.id === plan.id ? 'sel' : ''}><td>${c.name}</td><td>${c.aborted ? 'incomplete' : fmt(c.end)}</td><td>${c.aborted ? '–' : fmtCost(c.cost)}</td><td>${fmt(c.holds)}</td><td class=${c.errors ? 'bad' : 'ok'}>${c.errors || '—'}</td>
          <td><button class="small" onClick=${() => updateProject((p) => { p.activePlanId = c.id; })}>Open</button></td></tr>`)}</tbody></table>
        <button class="small" onClick=${() => setCompare(null)}>Close</button></div>`}
      <div class="seq-body">
        <ol class="steps-list" data-tour="steps">
          ${!steps.length && html`<li class="empty">No steps yet. Use <b>Auto order</b> or add pieces from the list on the right.</li>`}
          ${steps.map((s, i) => {
            const t = sim.stepTimes[i];
            const asmId = unitMembers(s);
            const asm = asmId && plan.assemblies.find((a) => a.id === asmId);
            const col = asm && asmColor(asm.id);
            return html`<li key=${s.id} class=${(s.id === selStep ? 'sel ' : '') + (errorSteps.has(i) ? 'flag ' : '') + 'k-' + s.kind + (asm ? ' k-asm' : '')}
              style=${asm ? { borderLeft: '4px solid ' + col } : null}
              draggable="true" onDragStart=${() => setDragFrom(i)} onDragOver=${(e) => e.preventDefault()}
              onDrop=${() => { if (dragFrom != null && dragFrom !== i) move(dragFrom, i); setDragFrom(null); }}
              onClick=${() => setSelStep(s.id === selStep ? null : s.id)}>
              <span class="grip" title="Drag to reorder">⋮⋮</span>
              <span class="idx">${i + 1}</span>
              <span class="icon">${KIND_ICON[s.kind]}</span>
              <span class="label">${asm
                ? html`${s.kind === 'build' ? 'Assemble' : 'Install'} <span class="asm-chip" style=${{ background: col }}>${asm.name}</span>${s.kind === 'build' ? ' where staged' : ''}`
                : stepLabel(s, model, plan, project)}</span>
              <span class="time">${t ? fmt(t.start) + '–' + fmt(t.end) : ''}</span>
              <span class="assign" onClick=${(e) => e.stopPropagation()}>
                ${s.kind === 'install' && html`
                  <select title="Who carries and holds it" value=${s.carrier} onChange=${(e) => setPlan((pl) => { pl.steps[i].carrier = e.target.value; })}>
                    ${builderOpts().map(([v, l]) => html`<option value=${v} selected=${v === s.carrier}>${v === 'auto' ? 'Carrier: auto' : l}</option>`)}</select>
                  <select title="Who aligns and fastens it" value=${s.fastener} onChange=${(e) => setPlan((pl) => { pl.steps[i].fastener = e.target.value; })}>
                    ${builderOpts([['carrier', 'Carrier fastens (solo)']]).map(([v, l]) => html`<option value=${v} selected=${v === s.fastener}>${v === 'auto' ? 'Fastener: auto' : l}</option>`)}</select>`}
                ${(s.kind === 'build' || s.kind === 'support') && html`
                  <select value=${s.builder} onChange=${(e) => setPlan((pl) => { pl.steps[i].builder = e.target.value; })}>
                    ${builderOpts().map(([v, l]) => html`<option value=${v} selected=${v === s.builder}>${v === 'auto' ? 'Builder: auto' : l}</option>`)}</select>`}
                <button class="small" disabled=${i === 0} onClick=${() => move(i, i - 1)} title="Move up">↑</button>
                <button class="small" disabled=${i === steps.length - 1} onClick=${() => move(i, i + 1)} title="Move down">↓</button>
                <button class="small" title="Remove step" onClick=${() => setPlan((pl) => { pl.steps.splice(i, 1); })}>✕</button>
              </span>
              ${asm && html`<span class="members">${asm.memberIds.map((id) => model.memberById.get(id)?.name).filter(Boolean).join(' + ')}</span>`}
            </li>`;
          })}
        </ol>
        <div class="seq-3d">
          <${IsoView} model=${model} styleOf=${styleOf} supports=${supportsAt} onPick=${pick}
            label=${editing ? `Click pieces to add/remove them from "${editing.name}"` : selIndex >= 0 ? `Step ${selIndex + 1}: orange = this step, gray = already built` : 'Click pieces to pick them for an assembly · colors = assemblies'} />
          <div class="pickbar">
            ${editing ? html`<span class="names">Editing <span class="asm-chip" style=${{ background: asmColor(editing.id) }}>${editing.name}</span>: click pieces to add or take them out.</span>
                <button class="small primary" onClick=${() => setEditAsm(null)}>Done</button>`
            : picked.length ? html`<span class="names"><b>Picked ${picked.length}${maxAsm < Infinity ? ' of max ' + maxAsm : ''}:</b> ${pickedNames.join(' + ')}
                ${pickedAsms.length > 0 && html` <span class="muted">(${pickedAsms.length === 1 ? 'already in ' + pickedAsms[0].name : 'from ' + pickedAsms.length + ' assemblies'}; they'll move to the new one)</span>`}
                ${picked.length > maxAsm && html` <b class="bad">Too many for one assembly.</b>`}</span>
                <button class="small primary" disabled=${picked.length < 2 || picked.length > maxAsm} onClick=${() => makeAssembly(picked)}>Make assembly</button>
                <button class="small" onClick=${() => setPicked([])}>Clear</button>`
            : html`<span class="names muted">Click pieces in the 3D view to pick ${maxAsm < Infinity ? `2–${maxAsm}` : 'some'} of them, then make them an assembly.</span>`}
          </div>
          <${Problems} sim=${sim} onPick=${(i) => i != null && steps[i] && setSelStep(steps[i].id)} />
        </div>
      </div>
    </div>
    <aside class="side">
      <${Section} title=${`Not in the sequence (${unsequenced.length})`}>
        ${!unsequenced.length && html`<${Hint}>Every piece is in the sequence.<//>`}
        ${unsequenced.length > 0 && html`<button onClick=${() => setPlan((pl) => {
          for (const u of unsequenced) {
            if (u.type === 'assembly' && !pl.steps.some((s) => s.kind === 'build' && s.assemblyId === u.id)) pl.steps.push({ id: uid('s'), kind: 'build', assemblyId: u.id, builder: 'auto' });
            pl.steps.push(installStep(u));
          }
        })}>Add all to the end</button>`}
        <ul class="list">${unsequenced.map((u) => html`<li><span>${u.name}</span><span class="spacer"></span>
          <button class="small" onClick=${() => setPlan((pl) => {
            if (u.type === 'assembly' && !pl.steps.some((s) => s.kind === 'build' && s.assemblyId === u.id)) pl.steps.push({ id: uid('s'), kind: 'build', assemblyId: u.id, builder: 'auto' });
            pl.steps.push(installStep(u));
          })}>Add</button></li>`)}</ul>
      <//>
      <div data-tour="assemblies">
      <${Section} title=${`Assemblies (${plan.assemblies.length})`}>
        <${Hint}>${maxAsm < Infinity ? `2 to ${maxAsm} members` : 'Members'} bolted together ${rules.assemblyIn === 'assembly' ? 'in a ground-assembly area' : 'right where they\'re staged (stage them ready to connect)'} after the clock starts, then carried and installed as one piece.<//>
        <div class="row">
          <button class="primary" disabled=${picked.length < 2 || picked.length > maxAsm} onClick=${() => makeAssembly(picked)}
            title="Click pieces in the 3D view first">Make assembly from ${picked.length || 'picked'} piece${picked.length === 1 ? '' : 's'}</button>
          <button onClick=${createAssembly} title="Start an empty assembly and add pieces to it in the 3D view">Empty assembly</button>
        </div>
        ${plan.assemblies.map((a) => html`<div class=${'asm ' + (editAsm === a.id ? 'editing' : '')} key=${a.id} style=${{ borderLeft: '4px solid ' + asmColor(a.id) }}>
          <div class="row">
            <span class="dot" style=${{ background: asmColor(a.id) }}></span>
            <input type="text" value=${a.name} onInput=${(e) => setPlan((pl) => { pl.assemblies.find((x) => x.id === a.id).name = e.target.value; }, 'asm' + a.id)} />
            <button class="small" onClick=${() => setEditAsm(editAsm === a.id ? null : a.id)}>${editAsm === a.id ? 'Done' : 'Edit'}</button>
            <button class="small danger" onClick=${() => { deleteAssembly(a.id); if (editAsm === a.id) setEditAsm(null); }}>✕</button>
          </div>
          ${rules.assemblyIn === 'assembly' && asmZones.length > 1 && html`<${SelectField} label="Assembled in" value=${a.areaZoneId || ''}
            options=${[['', '(where its members start)'], ...asmZones.map((z) => [z.id, z.name])]}
            onChange=${(v) => setPlan((pl) => { pl.assemblies.find((x) => x.id === a.id).areaZoneId = v || null; })} />`}
          <div class=${a.memberIds.length > maxAsm ? 'bad' : 'muted'}>${a.memberIds.map((id) => model.memberById.get(id)?.name).filter(Boolean).join(' + ') || 'No members yet. Click Edit, then click pieces in the 3D view.'}
            ${a.memberIds.length > 0 && ` (${a.memberIds.length}${maxAsm < Infinity ? ' of ' + maxAsm : ''})`}</div>
        </div>`)}
      <//>
      <${AddSupport} project=${project} model=${model} selIndex=${selIndex} setPlan=${setPlan} />
      </div>
    </aside>
  </div>`;
}

function AddSupport({ project, model, selIndex, setPlan }) {
  const supports = project.tools.filter((t) => t.kind === 'support');
  const [toolId, setToolId] = useState('');
  const [memberId, setMemberId] = useState('');
  const [action, setAction] = useState('place');
  const members = [...model.members].filter((m) => m.plane !== 'L').sort((a, b) => a.plane.localeCompare(b.plane) || a.centroid[0] - b.centroid[0]);
  const tid = toolId || supports[0]?.id || '';
  const mid = memberId || members[0]?.id || '';
  return html`<${Section} title="Temporary supports">
    ${!supports.length ? html`<${Hint}>Add a temporary support tool (e.g. a jack stand) in the Tools tab first.<//>` : html`
      <${SelectField} label="Action" value=${action} options=${[['place', 'Place support'], ['remove', 'Remove support']]} onChange=${setAction} />
      <${SelectField} label="Tool" value=${tid} options=${supports.map((t) => [t.id, t.name])} onChange=${setToolId} />
      <${SelectField} label="Under member" value=${mid} options=${members.map((m) => [m.id, m.name])} onChange=${setMemberId} />
      <button class="primary" onClick=${() => setPlan((pl) => {
        const step = { id: uid('s'), kind: 'support', action, toolId: tid, memberId: mid, builder: 'auto' };
        pl.steps.splice(selIndex >= 0 ? selIndex + 1 : pl.steps.length, 0, step);
      })}>Add step ${selIndex >= 0 ? 'after step ' + (selIndex + 1) : 'at the end'}</button>
      <${Hint}>A support under a member's lowest point holds it like a footing, so it doesn't need to be held. Supports must be picked back up before the finish (10.9.1), and can't stand in the river.<//>`}
  <//>`;
}

export function Problems({ sim, onPick }) {
  if (!sim.errors.length && !sim.warnings.length) return html`<div class="problems ok">No problems found.</div>`;
  const label = (s) => (s == null || s < 0 ? 'Start' : 'Step ' + (s + 1));
  return html`<div class="problems">
    ${sim.errors.map((e) => html`<div class="err" onClick=${() => onPick && onPick(e.step)}><b>${label(e.step)}</b> ${e.msg}</div>`)}
    ${sim.warnings.map((e) => html`<div class="warn" onClick=${() => onPick && onPick(e.step)}><b>${label(e.step)}</b> ${e.msg}</div>`)}
  </div>`;
}
