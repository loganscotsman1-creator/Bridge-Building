// After a run: the time, what each builder spent their time on, and earlier runs to compare.
import { html, useState } from '../../../js/lib/preact.js';
import { downloadJSON, safeFilename } from '../../../js/model/storage.js';
import { ACTIVITIES, ACTIVITY_NAMES } from '../world.js';
import { fmtMoney, fmtTime } from '../render.js';

const RUNS_KEY = 'oe.runs.v1';
const COLORS = { fasten: '#16a34a', assemble: '#2563eb', hold: '#d97706', brace: '#f59e0b', pass: '#a855f7', carry: '#64748b', walk: '#94a3b8', idle: '#e2e8f0' };

function loadRuns() { try { return JSON.parse(localStorage.getItem(RUNS_KEY)) || []; } catch { return []; } }

export function Results({ result, project, order, setup, onAgain, onSetup }) {
  const [runs] = useState(() => {
    const list = loadRuns();
    const entry = {
      at: new Date().toISOString(), projectName: project.name, done: result.done, time: result.time, penalties: result.penalties, total: result.total, cost: result.cost, builders: result.builders,
      falls: result.falls.length, players: result.players.filter((p) => !p.npc).map((p) => p.name),
    };
    const next = [entry, ...list].slice(0, 30);
    try { localStorage.setItem(RUNS_KEY, JSON.stringify(next)); } catch { /* ignore */ }
    return next;
  });
  // The score is the construction cost (lower is better); runs saved before costs, by time.
  const scoreOf = (r) => (r.cost != null ? r.cost : null);
  const earlier = runs.slice(1).filter((r) => r.projectName === project.name && r.done && scoreOf(r) != null);
  const best = earlier.length ? Math.min(...earlier.map(scoreOf)) : null;
  const money = result.cost != null;

  return html`<div class="oe oe-results">
    <header class="oe-top">
      <div class="oe-logo small">OVER<br />ENGINEERED</div>
      <div class="oe-tag">${project.name}</div>
    </header>
    <div class="oe-res-body">
      <section class="oe-card oe-total">
        <div class="oe-sub">Construction cost</div>
        <div class="big">${money ? fmtMoney(result.cost) : fmtTime(result.total)}</div>
        <div>${result.done ? 'Bridge built' : 'Ended early'} in ${fmtTime(result.time)}${result.penalties ? ` + ${result.penalties} s penalties` : ''} with ${result.builders} builder${result.builders === 1 ? '' : 's'}</div>
        ${money && html`<div class="oe-sub">${(result.total / 60).toFixed(2)} min × ${result.builders} builders × ${fmtMoney(project.site.rules.costPerBuilderMin)} per builder-minute${result.builders >= (project.site.rules.crewFactorMinBuilders ?? Infinity) && project.site.rules.crewFactor != null ? ` × ${project.site.rules.crewFactor} crew factor` : ''}</div>`}
        ${best != null && money && html`<div class=${result.cost < best ? 'good' : ''}>${result.done && result.cost < best ? 'New best! ' : ''}Best before: ${fmtMoney(best)}</div>`}
        <div class="oe-sub">${result.falls.length} fall${result.falls.length === 1 ? '' : 's'} · ${result.neglected} bolt${result.neglected === 1 ? '' : 's'} left unfastened over ${setup.settings.neglect} s</div>
        <div class="row wrap center">
          <button class="oe-go" onClick=${onAgain}>Play again</button>
          <button onClick=${onSetup}>Change setup</button>
          <button onClick=${() => downloadJSON({ kind: 'over-engineered-run', projectName: project.name, at: new Date().toISOString(), setup: { builders: setup.builders, npcRole: setup.npcRole, settings: setup.settings, players: setup.players.map((p) => ({ name: p.name, side: p.side })) }, order, result }, safeFilename(project.name + ' run', '.json'))}>Download results</button>
        </div>
      </section>

      <section class="oe-card">
        <h2>Who did what</h2>
        <div class="oe-legend">${ACTIVITIES.map((k) => html`<span><i style=${{ background: COLORS[k] }}></i>${ACTIVITY_NAMES[k]}</span>`)}</div>
        ${result.players.map((p) => {
          const total = ACTIVITIES.reduce((s, k) => s + p.time[k], 0) || 1;
          return html`<div class="oe-who">
            <div class="nm"><i style=${{ background: p.color }}></i><b>${p.name}</b> <small>${p.side} side</small></div>
            <div class="bar">${ACTIVITIES.map((k) => p.time[k] > 0.05 && html`<span style=${{ width: (100 * p.time[k]) / total + '%', background: COLORS[k] }} title=${ACTIVITY_NAMES[k] + ': ' + p.time[k].toFixed(1) + ' s'}></span>`)}</div>
            <div class="nums">
              ${p.time.hold > 0.5 && html`<span>Held the bridge ${p.holdTotal.toFixed(0)} s</span>`}
              ${p.nutsFastened > 0 && html`<span>${p.nutsFastened} nut${p.nutsFastened === 1 ? '' : 's'}</span>`}
              ${p.boltsPlaced > 0 && html`<span>${p.boltsPlaced} bolt${p.boltsPlaced === 1 ? '' : 's'}</span>`}
              ${p.piecesPlaced > 0 && html`<span>${p.piecesPlaced} piece${p.piecesPlaced === 1 ? '' : 's'} placed</span>`}
              ${p.assemblies > 0 && html`<span>${p.assemblies} assembl${p.assemblies === 1 ? 'y' : 'ies'}</span>`}
              ${p.handoffs > 0 && html`<span>${p.handoffs} pass${p.handoffs === 1 ? '' : 'es'}</span>`}
              <span>waited ${p.time.idle.toFixed(0)} s</span>
            </div>
          </div>`;
        })}
        ${result.falls.length > 0 && html`<h3>Falls</h3><ul class="oe-falls">${result.falls.map((f) => html`<li><b>${fmtTime(f.t)}</b> ${f.why}</li>`)}</ul>`}
      </section>

      ${runs.length > 1 && html`<section class="oe-card">
        <h2>Recent runs</h2>
        <table class="oe-runs">
          <tr><th>When</th><th>Bridge</th><th>Cost</th><th>Time</th><th>Builders</th><th>Falls</th><th>Players</th></tr>
          ${runs.slice(0, 12).map((r, i) => html`<tr class=${i === 0 ? 'now' : ''}>
            <td>${new Date(r.at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</td>
            <td>${r.projectName}</td><td>${r.done && r.cost != null ? fmtMoney(r.cost) : r.done ? '' : 'ended early'}</td><td>${fmtTime(r.total)}</td><td>${r.builders ?? ''}</td><td>${r.falls}</td><td>${r.players.join(', ')}${r.builders > r.players.length ? ' + ' + (r.builders - r.players.length) + ' COM' : ''}</td>
          </tr>`)}
        </table>
      </section>`}
    </div>
  </div>`;
}
