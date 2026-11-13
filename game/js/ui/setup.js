// The setup screen: bridge and build order, who's playing (and on which side), NPCs and times.
import { html, useEffect, useRef, useState } from '../../../js/lib/preact.js';
import { bridgeToSite, footingRanges } from '../../../js/model/geometry.js';
import { membersArea, sideOf } from '../../../js/model/plan.js';
import { downloadJSON, pickFile, readJSONFile, safeFilename } from '../../../js/model/storage.js';
import { createExampleProject } from '../../../js/model/example.js';
import { gameAssemblyTime, deleteSavedOrder, itemName, orderFile, orderProblems, readOrderFile, saveOrder, savedOrders, startFooting } from '../order.js';
import { deviceHelp, deviceName, endFrame, pressedDevices } from '../input.js';

export const PLAYER_COLORS = ['#e11d48', '#2563eb', '#16a34a', '#d97706'];

// Which side each NPC works from: the holder at the first assembly's footing, the assembler in the assembly area.
export function npcSides(project, model, order) {
  const site = project.site;
  const F = footingRanges(project);
  const sf = startFooting(project, model, order[0]);
  const holder = F.length ? sideOf(site, bridgeToSite(site, (F[sf][0] + F[sf][1]) / 2, 0)) : 'west';
  const a = membersArea(site);
  const assembler = sideOf(site, { x: a.x + a.w / 2, y: 0 });
  return { holder: holder || 'west', assembler: assembler || 'east' };
}

export function npcList(setup) {
  if (setup.builders === 6) return { holder: true, assembler: true };
  if (setup.builders === 5) return { [setup.npcRole]: true };
  return {};
}

export function setupProblems(project, model, order, setup) {
  const out = orderProblems(order, model, project.site.rules).map((p) => p.msg);
  if (!setup.players.length) out.push('Join at least one player: press A on a controller, or Space / slash on the keyboard.');
  const npcs = npcList(setup);
  const sides = npcSides(project, model, order);
  const on = { west: 0, east: 0 };
  for (const p of setup.players) on[p.side]++;
  for (const k of Object.keys(npcs)) on[sides[k]]++;
  if (setup.players.length && (!on.west || !on.east)) out.push('Put at least one builder on each side of the river.');
  if (setup.players.length + Object.keys(npcs).length > (project.site.rules?.maxBuilders || 6)) out.push('Too many builders for the rules.');
  return out;
}

export function Setup({ project, model, from, order, setOrder, setup, setSetup, onProject, onEditOrder, onStart }) {
  const problems = setupProblems(project, model, order, setup);
  const setupRef = useRef(setup);
  setupRef.current = setup;
  const [flash, setFlash] = useState(null);

  // Press A (or Space / slash) to join.
  useEffect(() => {
    let raf;
    const held = new Set(pressedDevices());
    const loop = () => {
      const now = pressedDevices();
      endFrame();
      for (const d of now) {
        if (held.has(d)) continue;
        const s = setupRef.current;
        if (s.players.some((p) => p.device === d) || s.players.length >= 4) continue;
        const used = new Set(s.players.map((p) => p.color));
        const color = PLAYER_COLORS.find((c) => !used.has(c)) || PLAYER_COLORS[0];
        const n = s.players.length;
        const sideCount = { west: s.players.filter((p) => p.side === 'west').length, east: s.players.filter((p) => p.side === 'east').length };
        const side = sideCount.west <= sideCount.east ? 'west' : 'east';
        setSetup({ ...s, players: [...s.players, { device: d, name: 'Player ' + (n + 1), color, side }] });
        setFlash(d);
      }
      held.clear();
      for (const d of now) held.add(d);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  const setPlayer = (i, patch) => setSetup({ ...setup, players: setup.players.map((p, j) => (j === i ? { ...p, ...patch } : p)) });
  const setS = (patch) => setSetup({ ...setup, settings: { ...setup.settings, ...patch } });
  const npcs = npcList(setup);
  const sides = npcSides(project, model, order);

  const openProject = async () => {
    const f = await pickFile('.json,application/json');
    if (!f) return;
    try { onProject(await readJSONFile(f), 'file'); } catch (e) { alert('Could not open that file: ' + e.message); }
  };

  return html`<div class="oe">
    <header class="oe-top">
      <div class="oe-logo">OVER<br />ENGINEERED</div>
      <div class="oe-tag">A co-op bridge build for practicing teamwork, on your bridge and this year's site.</div>
      <a class="oe-link" href="../">← Build Sequencer</a>
    </header>
    <div class="oe-grid">
      <section class="oe-card">
        <h2>1 · Bridge & build order</h2>
        <div class="oe-src">
          <b>${project.name}</b>
          <span>${from === 'sequencer' ? 'from your Build Sequencer' : from === 'file' ? 'from a project file' : 'the example bridge'} · ${model.members.length} pieces · ${model.bolts.length} bolts</span>
        </div>
        <div class="row wrap">
          <button onClick=${openProject}>Open project file…</button>
          ${from !== 'example' && html`<button onClick=${() => onProject(createExampleProject(), 'example')}>Use the example bridge</button>`}
        </div>
        <${OrderSummary} project=${project} model=${model} order=${order} settings=${setup.settings} />
        <div class="row wrap">
          <button class="primary" onClick=${onEditOrder}>Edit the order…</button>
          <${SavedOrders} project=${project} order=${order} setOrder=${setOrder} />
        </div>
      </section>

      <section class="oe-card">
        <h2>2 · Players</h2>
        <p class="oe-hint">Press <kbd>A</kbd> on a controller to join (or <kbd>Space</kbd> / <kbd>/</kbd> for two players on one keyboard). Up to four.</p>
        <div class="oe-players">
          ${[0, 1, 2, 3].map((i) => {
            const p = setup.players[i];
            if (!p) return html`<div class="oe-slot empty">Player ${i + 1}<br /><small>press A to join</small></div>`;
            return html`<div class=${'oe-slot' + (flash === p.device ? ' joined' : '')} style=${{ '--c': p.color }}>
              <div class="row">
                <input type="color" value=${p.color} onInput=${(e) => setPlayer(i, { color: e.target.value })} title="Color" />
                <input type="text" value=${p.name} onInput=${(e) => setPlayer(i, { name: e.target.value })} />
                <button class="small" title="Leave" onClick=${() => setSetup({ ...setup, players: setup.players.filter((_, j) => j !== i) })}>✕</button>
              </div>
              <div class="oe-side">
                ${['west', 'east'].map((s) => html`<button class=${p.side === s ? 'on' : ''} onClick=${() => setPlayer(i, { side: s })}>${s === 'west' ? 'West side' : 'East side'}</button>`)}
              </div>
              <small class="oe-dev" title=${deviceHelp(p.device)}>${deviceName(p.device)}</small>
            </div>`;
          })}
        </div>
        <h3>Builders on the site</h3>
        <div class="oe-side">
          ${[4, 5, 6].map((n) => html`<button class=${setup.builders === n ? 'on' : ''} onClick=${() => setSetup({ ...setup, builders: n })}>${n}</button>`)}
        </div>
        ${setup.builders === 4 && html`<p class="oe-hint">Players do everything: assemblies, running pieces, holding the bridge.</p>`}
        ${setup.builders === 5 && html`<div class="oe-side">
          <button class=${setup.npcRole === 'holder' ? 'on' : ''} onClick=${() => setSetup({ ...setup, npcRole: 'holder' })}>NPC holds the bridge</button>
          <button class=${setup.npcRole === 'assembler' ? 'on' : ''} onClick=${() => setSetup({ ...setup, npcRole: 'assembler' })}>NPC makes assemblies</button>
        </div>`}
        ${npcs.holder && html`<p class="oe-hint">The holder (${sides.holder} side) holds the bridge at the newest lateral until it stands, then bolts the buddy pieces.</p>`}
        ${npcs.assembler && html`<p class="oe-hint">The assembler (${sides.assembler} side) makes every assembly at its set time. Players can make assemblies alongside it to get ahead.</p>`}
      </section>

      <section class="oe-card">
        <h2>3 · Times</h2>
        <${Num} label="Fasten one nut (hold X)" unit="s" value=${setup.settings.fastenTime} onChange=${(v) => setS({ fastenTime: v })} />
        <${Num} label="Assembly times, share of the sequencer's" unit="×" value=${setup.settings.assemblyScale ?? 1} onChange=${(v) => setS({ assemblyScale: v })} />
        <${Num} label="Penalty when the bridge falls" unit="s" value=${setup.settings.fallPenalty} onChange=${(v) => setS({ fallPenalty: v })} />
        <${Num} label="Time to take hold of the bridge" unit="s" value=${setup.settings.grace} onChange=${(v) => setS({ grace: v })} />
        <${Num} label="Unfastened bolts flash after" unit="s" value=${setup.settings.neglect} onChange=${(v) => setS({ neglect: v })} />
        <${Num} label="Walking speed" unit="in/s" value=${setup.settings.walkSpeed} onChange=${(v) => setS({ walkSpeed: v })} />
        <${Num} label="Carrying speed" unit="in/s" value=${setup.settings.carrySpeed} onChange=${(v) => setS({ carrySpeed: v })} />
        <${Num} label="Reach" unit="in" value=${setup.settings.reach} onChange=${(v) => setS({ reach: v })} />
        <${Num} label="Reach to pass a piece" unit="in" value=${setup.settings.passReach} onChange=${(v) => setS({ passReach: v })} />
        <p class="oe-hint">An assembly's own time can be set in the order editor. Defaults keep the game moving: quicker nuts and assemblies, brisker walking.</p>
        <details class="oe-how">
          <summary>How to play</summary>
          <ul>
            <li><b>A</b>: grab the next item from the ready area (from anywhere in it) or from a teammate, place a piece where it goes (puts in its first bolt), place a bolt. Hold A while carrying to pass a piece across.</li>
            <li><b>X</b> (hold): fasten a nut, or make an assembly in the assembly area. Several builders can work there at once, on different assemblies or together on one.</li>
            <li><b>LB</b> (hold): hold the bridge up at a lateral. Push the stick along the bridge to move out to the next lateral. Let go with nobody else holding and it falls.</li>
            <li>A piece touching the bridge in one place needs one bolt; in two or more places, two bolts in different places. Until then whoever placed it holds it. ★ pieces need a buddy to bolt them.</li>
            <li>The bridge stands on its own once it reaches both footings with the trusses tied together. Then fasten everything and get back to a staging yard.</li>
          </ul>
        </details>
      </section>
    </div>
    <footer class="oe-start">
      ${problems.length ? html`<ul class="oe-problems">${problems.map((p) => html`<li>${p}</li>`)}</ul>` : html`<span class="oe-ready">Ready: ${setup.players.length} player${setup.players.length === 1 ? '' : 's'}${Object.keys(npcs).length ? ' + ' + Object.keys(npcs).length + ' NPC' : ''}</span>`}
      <button class="oe-go" disabled=${problems.length > 0} onClick=${onStart}>Start building</button>
    </footer>
  </div>`;
}

function Num({ label, unit, value, onChange }) {
  return html`<label class="oe-num"><span>${label}</span><input type="number" min="0" step="any" value=${value}
    onInput=${(e) => { const v = parseFloat(e.target.value); if (Number.isFinite(v) && v >= 0) onChange(v); }} /><em>${unit}</em></label>`;
}

function OrderSummary({ project, model, order, settings }) {
  return html`<ol class="oe-order">
    ${order.map((it, i) => html`<li class=${it.memberIds.length > 1 ? 'oe-asm' : ''}>
      <span class="n">${i + 1}</span>
      <span class="nm">${itemName(it, model)}</span>
      ${it.buddy && html`<span class="buddy" title="Needs a buddy to bolt it">★</span>`}
      ${it.memberIds.length > 1 && html`<span class="tm">${gameAssemblyTime(it, project, model, settings)} s</span>`}
    </li>`)}
  </ol>`;
}

function SavedOrders({ project, order, setOrder }) {
  const [list, setList] = useState(() => savedOrders());
  const mine = list.filter((o) => o.projectName === project.name);
  const save = () => {
    const name = prompt('Name this order', 'Order ' + (mine.length + 1));
    if (!name) return;
    saveOrder(name, project, order);
    setList(savedOrders());
  };
  const load = (name) => {
    const o = mine.find((x) => x.name === name);
    if (o) setOrder(readOrderFile(o));
  };
  const upload = async () => {
    const f = await pickFile('.json,application/json');
    if (!f) return;
    try { setOrder(readOrderFile(await readJSONFile(f))); } catch (e) { alert(e.message); }
  };
  return html`
    <button onClick=${save}>Save order</button>
    ${mine.length > 0 && html`<select onChange=${(e) => { if (e.target.value) load(e.target.value); e.target.value = ''; }}>
      <option value="">Load a saved order…</option>
      ${mine.map((o) => html`<option value=${o.name}>${o.name}</option>`)}
    </select>`}
    ${mine.length > 0 && html`<select title="Delete a saved order" onChange=${(e) => { if (e.target.value && confirm('Delete "' + e.target.value + '"?')) { deleteSavedOrder(e.target.value, project.name); setList(savedOrders()); } e.target.value = ''; }}>
      <option value="">Delete…</option>
      ${mine.map((o) => html`<option value=${o.name}>${o.name}</option>`)}
    </select>`}
    <button onClick=${() => downloadJSON(orderFile('Build order', project, order), safeFilename(project.name + ' order', '.json'))}>Download</button>
    <button onClick=${upload}>Upload…</button>`;
}
