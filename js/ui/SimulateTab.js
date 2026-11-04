// Simulate tab: play back the build, see who's doing what, and how long pieces are held.
import { html, useEffect, useMemo, useRef, useState } from '../lib/preact.js';
import { activePlan } from '../model/schema.js';
import { stagingSpots } from '../model/plan.js';
import { updateProject } from '../model/store.js';
import { siteToBridge } from '../model/geometry.js';
import { fmt, fmtCost } from '../sim/simulate.js';
import { stateAt } from '../sim/playback.js';
import { BOLT_COLORS, PlanView } from './PlanView.js';
import { IsoView } from './IsoView.js';
import { Gantt } from './Gantt.js';
import { Problems, TaskEditor } from './SequenceTab.js';
import { Section } from './common.js';

const STATUS_COLORS = { held: '#f97316', working: '#eab308', stable: '#475569', unstable: '#dc2626' };

export function SimulateTab({ project, model, sim }) {
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(4);
  const [sel, setSel] = useState(null);
  const [selTaskId, setSelTaskId] = useState(null);
  const raf = useRef(null);
  const end = sim.endTime;
  const spots = useMemo(() => stagingSpots(project, model), [project]);

  const tRef = useRef(t);
  tRef.current = t;
  useEffect(() => { if (t > end) setT(end); }, [end]);
  useEffect(() => {
    if (!playing) return;
    let last = performance.now();
    const tick = (now) => {
      const next = tRef.current + ((now - last) / 1000) * speed;
      last = now;
      tRef.current = Math.min(end, next);
      setT(tRef.current);
      if (next >= end) setPlaying(false); else raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, [playing, speed, end]);

  const state = useMemo(() => stateAt(sim, t), [sim, t]);
  // Members with a bolt that's only inserted are held but only partly connected.
  const partial = new Set();
  for (const b of model.bolts) if (state.bolts.get(b.id)?.state === 'inserted') for (const id of b.memberIds) partial.add(id);
  const styleOf = (m) => {
    const ms = state.members.get(m.id);
    if (!ms || ms.loc !== 'bridge') return { color: '#cbd5e1', opacity: 0.35, dash: '2 2' };
    return { color: STATUS_COLORS[ms.status] || '#475569', outline: partial.has(m.id) ? BOLT_COLORS.inserted : null };
  };
  // Every bolt on the bridge at this moment, for the 3D view.
  const boltDots = [];
  for (const b of model.bolts) {
    const st = state.bolts.get(b.id);
    const onBridge = b.memberIds.some((id) => state.members.get(id)?.loc === 'bridge');
    if (st?.state === 'moving' && !st.at) {
      const from = siteToBridge(project.site, st.from.x, st.from.y);
      const q = [from.x + (b.pos[0] - from.x) * st.f, from.y + (b.pos[1] - from.y) * st.f, 30 + (b.pos[2] - 30) * st.f];
      boltDots.push({ key: b.id, pos: q, r: 5, fill: BOLT_COLORS.moving, stroke: '#fff', width: 1, title: 'Bolt on its way' });
    } else if (onBridge && st?.state === 'working') boltDots.push({ key: b.id, pos: b.pos, r: 5.5, fill: BOLT_COLORS.working, stroke: '#111827', width: 1, title: 'Being fastened' });
    else if (onBridge && st?.state === 'inserted') boltDots.push({ key: b.id, pos: b.pos, r: 4, fill: '#fff', stroke: BOLT_COLORS.inserted, width: 2.5, title: 'Inserted: holds, but the nut is not on yet' });
    else if (onBridge && st?.state === 'fastened') boltDots.push({ key: b.id, pos: b.pos, r: 3, fill: BOLT_COLORS.fastened, stroke: '#fff', width: 0.5, title: 'Fastened' });
    else if (onBridge) boltDots.push({ key: b.id, pos: b.pos, r: 2.5, fill: 'none', stroke: BOLT_COLORS.todo, width: 1, title: 'Not in yet' });
  }
  const totalBolts = model.bolts.filter((b) => b.jointId).length;
  const placed = [...state.members.values()].filter((m) => m.loc === 'bridge').length;
  const holds = [...sim.holds].sort((a, b) => b.duration - a.duration);
  const totalHold = holds.reduce((a, h) => a + h.duration, 0);
  const plan = activePlan(project);
  const selBuilder = sel && sel.type === 'builder' ? state.builders.find((b) => b.id === sel.id) : null;

  return html`<div class="sim">
    <div class="toolbar" data-tour="play">
      <button class="primary" onClick=${() => { if (t >= end) setT(0); setPlaying(!playing); }}>${playing ? '❚❚ Pause' : '▶ Play'}</button>
      <button onClick=${() => { setPlaying(false); setT(0); }}>⏮</button>
      <select value=${speed} onChange=${(e) => setSpeed(parseFloat(e.target.value))} title="Playback speed">
        ${[1, 2, 4, 8, 16, 32].map((s) => html`<option value=${s} selected=${s === speed}>${s}×</option>`)}
      </select>
      <input class="scrub" type="range" min="0" max=${end} step="0.1" value=${t} onInput=${(e) => { setPlaying(false); setT(parseFloat(e.target.value)); }} />
      <span class="clock">${fmt(t)} / ${fmt(end)}</span>
      <span class="bolt-count" title="Fastened bolts, and bolts inserted but waiting for their nut">${state.boltCounts.fastened} / ${totalBolts} bolts fastened${state.boltCounts.inserted ? html` · <b>${state.boltCounts.inserted} only inserted</b>` : ''}</span>
      <span class="muted">${placed} / ${model.members.length} members placed · ${sim.handoffs} handed across · construction cost ${fmtCost(sim.cost)} · plan "${plan.name}"</span>
    </div>
    <div class="sim-views">
      <div class="sim-plan">
        <${PlanView} project=${project} model=${model} spots=${spots} state=${state} sel=${sel} setSel=${setSel} />
        <div class="sim-legend">
          ${Object.entries({ held: 'Being held', working: 'Being aligned / fastened', stable: 'Stable', unstable: 'Unstable' }).map(([k, l]) => html`<span><i style=${{ background: STATUS_COLORS[k] }}></i>${l}</span>`)}
          <span class="bolt-key"><i class="round" style=${{ background: BOLT_COLORS.moving }}></i>Bolt on its way</span>
          <span class="bolt-key"><i class="round" style=${{ background: BOLT_COLORS.fastened }}></i>Fastened</span>
          <span class="bolt-key"><i class="round ring" style=${{ borderColor: BOLT_COLORS.inserted }}></i>Inserted, nut not on (partly connected)</span>
        </div>
      </div>
      <div class="sim-side">
        <${IsoView} model=${model} styleOf=${styleOf} supports=${state.supports} bolts=${boltDots} label="Bridge at this moment" />
        <div class="now">
          ${state.builders.map((b) => html`<div class=${'who ' + (selBuilder && selBuilder.id === b.id ? 'sel' : '')} onClick=${() => setSel({ type: 'builder', id: b.id })}>
            <span class="dot" style=${{ background: b.color }}></span><b>${b.name}</b> <span class="muted">${b.label}</span>${b.boltCount != null && html` <span class="bolts-left">${b.boltCount - b.boltsUsedNow} bolts</span>`}</div>`)}
        </div>
      </div>
    </div>
    <div data-tour="gantt"><${Gantt} result=${sim} t=${t} setT=${(v) => { setPlaying(false); setT(v); }} selected=${selTaskId} onSelect=${setSelTaskId}
      onEdit=${(id, patch) => updateProject((p) => { Object.assign(activePlan(p).tasks.find((x) => x.id === id) || {}, patch); })} /></div>
    ${plan.tasks?.find((x) => x.id === selTaskId) && html`<div class="sim-edit"><${TaskEditor} key=${selTaskId} task=${plan.tasks.find((x) => x.id === selTaskId)} project=${project} model=${model} sim=${sim} onClose=${() => setSelTaskId(null)} onSelect=${setSelTaskId} /></div>`}
    <div class="sim-reports">
      <${Section} title=${`Holding time (${fmt(totalHold)} total)`}>
        <p class="hint">How long someone had to hold each piece after placing it: waiting for a fastener, then aligning and bolting, then until the piece became stable or another builder's held piece (say a lateral bolted to both trusses) could hold it up instead.</p>
        <table class="grid">
          <thead><tr><th>Piece</th><th>Held by</th><th>From</th><th>Held for</th><th>Waiting for fastener</th><th>Align + bolt</th><th></th></tr></thead>
          <tbody>${holds.map((h) => html`<tr onClick=${() => { setPlaying(false); setT(h.start); }} class=${h.open ? 'bad' : ''}>
            <td>${h.name}</td><td>${sim.builders.find((b) => b.id === h.builderId)?.name}${h.solo ? ' (solo)' : ''}</td>
            <td>${fmt(h.start)}</td><td><b>${h.duration.toFixed(1)} s</b>${h.open ? ' – never released' : ''}${h.heldUpBy ? html`<div class="muted small">then held up through ${h.heldUpBy.name}${h.heldUpBy.builder ? ' (' + h.heldUpBy.builder + ')' : ''}</div>` : ''}</td>
            <td>${h.waitForFastener != null ? h.waitForFastener.toFixed(1) + ' s' : '—'}</td>
            <td>${h.working != null ? h.working.toFixed(1) + ' s' : '—'}</td>
            <td><span class="bar" style=${{ width: Math.min(120, (h.duration / Math.max(1, holds[0]?.duration || 1)) * 120) + 'px' }}></span></td></tr>`)}</tbody>
        </table>
      <//>
      <${Section} title="Bolts each builder carries">
        <table class="grid"><thead><tr><th>Builder</th><th>Starts with</th><th>This plan puts in</th><th>Left at this moment</th></tr></thead>
          <tbody>${sim.builders.map((b) => {
            const now = state.builders.find((x) => x.id === b.id)?.boltsUsedNow || 0;
            return html`<tr><td><span class="dot" style=${{ background: b.color }}></span>${b.name}</td><td>${b.boltCount ?? 'as needed'}</td>
              <td class=${b.boltCount != null && b.boltsUsed > b.boltCount ? 'bad' : ''}>${b.boltsUsed}</td><td>${b.boltCount != null ? b.boltCount - now : now + ' used'}</td></tr>`;
          })}</tbody></table>
        <button onClick=${() => updateProject((p) => { for (const x of sim.builders) { const b = p.builders.find((q) => q.id === x.id); if (b) b.boltCount = x.boltsUsed; } })}
          title="Each builder starts with exactly what this plan has them put in">Start each builder with what this plan uses</button>
      <//>
      <${Section} title="Builders">
        <table class="grid"><thead><tr><th>Builder</th><th>Busy</th><th>Idle / waiting</th><th>Holding</th></tr></thead>
          <tbody>${sim.builders.map((b) => {
            const held = sim.holds.filter((h) => h.builderId === b.id && !h.solo).reduce((a, h) => a + h.duration, 0);
            return html`<tr><td><span class="dot" style=${{ background: b.color }}></span>${b.name}</td><td>${fmt(b.busy)}</td><td>${fmt(Math.max(0, end - b.busy))}</td><td>${fmt(held)}</td></tr>`;
          })}</tbody></table>
      <//>
      <${Section} title=${`Problems (${sim.errors.length + sim.warnings.length})`}>
        <${Problems} sim=${sim} nameOf=${(i) => { const x = plan.tasks?.[i]; return x ? project.builders.find((b) => b.id === x.builder)?.name : null; }} />
      <//>
    </div>
  </div>`;
}
