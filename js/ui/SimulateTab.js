// Simulate tab: play back the build, see who's doing what, and how long pieces are held.
import { html, useEffect, useMemo, useRef, useState } from '../lib/preact.js';
import { activePlan } from '../model/schema.js';
import { stagingSpots } from '../model/plan.js';
import { fmt } from '../sim/simulate.js';
import { stateAt } from '../sim/playback.js';
import { PlanView } from './PlanView.js';
import { IsoView } from './IsoView.js';
import { Gantt } from './Gantt.js';
import { Problems } from './SequenceTab.js';
import { Section } from './common.js';

const STATUS_COLORS = { held: '#f97316', working: '#eab308', stable: '#475569', unstable: '#dc2626' };

export function SimulateTab({ project, model, sim }) {
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(4);
  const [sel, setSel] = useState(null);
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
  const styleOf = (m) => {
    const ms = state.members.get(m.id);
    if (!ms || ms.loc !== 'bridge') return { color: '#cbd5e1', opacity: 0.35, dash: '2 2' };
    return { color: STATUS_COLORS[ms.status] || '#475569' };
  };
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
      <span class="muted">${placed} / ${model.members.length} members placed · plan "${plan.name}"</span>
    </div>
    <div class="sim-views">
      <div class="sim-plan">
        <${PlanView} project=${project} model=${model} spots=${spots} state=${state} sel=${sel} setSel=${setSel} />
        <div class="sim-legend">
          ${Object.entries({ held: 'Being held', working: 'Being aligned / fastened', stable: 'Stable', unstable: 'Unstable' }).map(([k, l]) => html`<span><i style=${{ background: STATUS_COLORS[k] }}></i>${l}</span>`)}
        </div>
      </div>
      <div class="sim-side">
        <${IsoView} model=${model} styleOf=${styleOf} supports=${state.supports} label="Bridge at this moment" />
        <div class="now">
          ${state.builders.map((b) => html`<div class=${'who ' + (selBuilder && selBuilder.id === b.id ? 'sel' : '')} onClick=${() => setSel({ type: 'builder', id: b.id })}>
            <span class="dot" style=${{ background: b.color }}></span><b>${b.name}</b> <span class="muted">${b.label}</span></div>`)}
        </div>
      </div>
    </div>
    <div data-tour="gantt"><${Gantt} result=${sim} t=${t} setT=${(v) => { setPlaying(false); setT(v); }} /></div>
    <div class="sim-reports">
      <${Section} title=${`Holding time (${fmt(totalHold)} total)`}>
        <p class="hint">How long someone had to hold each piece after placing it: waiting for a fastener, then aligning and bolting, then until the piece became stable.</p>
        <table class="grid">
          <thead><tr><th>Piece</th><th>Held by</th><th>From</th><th>Held for</th><th>Waiting for fastener</th><th>Align + bolt</th><th></th></tr></thead>
          <tbody>${holds.map((h) => html`<tr onClick=${() => { setPlaying(false); setT(h.start); }} class=${h.open ? 'bad' : ''}>
            <td>${h.name}</td><td>${sim.builders.find((b) => b.id === h.builderId)?.name}${h.solo ? ' (solo)' : ''}</td>
            <td>${fmt(h.start)}</td><td><b>${h.duration.toFixed(1)} s</b>${h.open ? ' – never released' : ''}</td>
            <td>${h.waitForFastener != null ? h.waitForFastener.toFixed(1) + ' s' : '—'}</td>
            <td>${h.working != null ? h.working.toFixed(1) + ' s' : '—'}</td>
            <td><span class="bar" style=${{ width: Math.min(120, (h.duration / Math.max(1, holds[0]?.duration || 1)) * 120) + 'px' }}></span></td></tr>`)}</tbody>
        </table>
      <//>
      <${Section} title="Builders">
        <table class="grid"><thead><tr><th>Builder</th><th>Busy</th><th>Idle / waiting</th><th>Holding</th></tr></thead>
          <tbody>${sim.builders.map((b) => {
            const held = sim.holds.filter((h) => h.builderId === b.id && !h.solo).reduce((a, h) => a + h.duration, 0);
            return html`<tr><td><span class="dot" style=${{ background: b.color }}></span>${b.name}</td><td>${fmt(b.busy)}</td><td>${fmt(Math.max(0, end - b.busy))}</td><td>${fmt(held)}</td></tr>`;
          })}</tbody></table>
      <//>
      <${Section} title=${`Problems (${sim.errors.length + sim.warnings.length})`}>
        <${Problems} sim=${sim} />
      <//>
    </div>
  </div>`;
}
