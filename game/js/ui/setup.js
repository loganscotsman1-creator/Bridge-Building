// The setup screen: bridge and build order, who's playing (and on which side), NPCs and times.
import { html, useEffect, useRef, useState } from '../../../js/lib/preact.js';
import { bridgeToSite, footingRanges } from '../../../js/model/geometry.js';
import { membersArea, sideOf } from '../../../js/model/plan.js';
import { downloadJSON, pickFile, readJSONFile, safeFilename } from '../../../js/model/storage.js';
import { createExampleProject } from '../../../js/model/example.js';
import { gameAssemblyTime, deleteSavedOrder, itemName, orderFile, orderProblems, readOrderFile, saveOrder, savedOrders, startFooting } from '../order.js';
import { KEYBOARDS, deviceHelp, deviceName, endFrame, pressedDevices, readDevice } from '../input.js';

export const PLAYER_COLORS = ['#e11d48', '#2563eb', '#16a34a', '#d97706'];

// The time settings, and how far one press of left/right moves each on a controller.
const TIMES = [
  { key: 'fastenTime', label: 'Fasten one nut (hold X)', unit: 's', step: 0.1 },
  { key: 'assemblyTime', label: 'Make an assembly (hold X)', unit: 's', step: 0.5, title: "Every assembly takes this long. 0 uses each assembly's time from the sequencer." },
  { key: 'fallPenalty', label: 'Penalty when the bridge falls', unit: 's', step: 5 },
  { key: 'grace', label: 'Time to take hold of the bridge', unit: 's', step: 0.5 },
  { key: 'neglect', label: 'Unfastened bolts flash after', unit: 's', step: 1 },
  { key: 'walkSpeed', label: 'Walking speed', unit: 'in/s', step: 2 },
  { key: 'carrySpeed', label: 'Carrying speed', unit: 'in/s', step: 2 },
  { key: 'reach', label: 'Reach', unit: 'in', step: 2 },
  { key: 'passReach', label: 'Reach to pass a piece', unit: 'in', step: 5 },
];
// The on-screen keyboard for typing a name with a controller.
const KEYS = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ', ' ', '-', '⌫', '✓'];
const KEY_COLS = 6;
const isPad = (device) => !KEYBOARDS[device];

// Player 1's list of things to move through with the stick, in screen order.
function navList(setup) {
  return [
    { id: 'builders' },
    ...(setup.builders === 5 ? [{ id: 'npcRole' }] : []),
    ...TIMES.map((t) => ({ id: t.key, time: t })),
    { id: 'start' },
  ];
}
// Left/right on one of player 1's settings.
function nudge(setup, id, dir) {
  if (id === 'builders') return { ...setup, builders: Math.max(4, Math.min(6, setup.builders + dir)) };
  if (id === 'npcRole') return { ...setup, npcRole: setup.npcRole === 'holder' ? 'assembler' : 'holder' };
  const t = TIMES.find((x) => x.key === id);
  if (!t) return setup;
  const v = Math.max(0, Math.round(((setup.settings[id] ?? 0) + dir * t.step) * 100) / 100);
  return { ...setup, settings: { ...setup.settings, [id]: v } };
}
// Typing one key into a name: capitals at the start of a word, small letters after.
function typeKey(name, key, fresh) {
  if (key === '⌫') return fresh ? '' : name.slice(0, -1);
  const base = fresh ? '' : name;
  if (base.length >= 16) return base;
  const start = !base.length || base.endsWith(' ') || base.endsWith('-');
  return base + (key.length === 1 && /[A-Z]/.test(key) && !start ? key.toLowerCase() : key);
}

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
  // Player 1 moves through the settings with the stick: which one is highlighted.
  // (Both are kept in refs the controller loop reads and writes right away, mirrored into state to
  // redraw, so a quick press never acts on an out-of-date screen.)
  const [navAt, setNavAtState] = useState(-1);
  const navRef = useRef(-1);
  const setNavAt = (fn) => { navRef.current = fn(navRef.current); setNavAtState(navRef.current); };
  // Name editors open with Y: device -> {cursor, fresh}.
  const [editing, setEditingState] = useState({});
  const edRef = useRef({});
  const setEditing = (fn) => { edRef.current = fn(edRef.current); setEditingState(edRef.current); };
  const live = useRef({});
  live.current = { problems, onStart };

  // Press A (or Space / slash) to join. Joined players: X switches side, Y types a name (with a
  // controller). Player 1 also moves through the settings (stick up/down, left/right to change,
  // A to press) and can start with Start.
  useEffect(() => {
    let raf;
    const held = new Set(pressedDevices());
    const prev = new Map(); // device -> last frame's buttons
    const rep = new Map(); // device -> {dir, t} for stick repeat
    let last = performance.now();
    const stick = (d, st, dt) => {
      // A stick or d-pad push: once at first, then repeating while held.
      const dx = st.mx > 0.6 ? 1 : st.mx < -0.6 ? -1 : 0, dy = st.my > 0.6 ? 1 : st.my < -0.6 ? -1 : 0;
      const dir = dx ? 'x' + dx : dy ? 'y' + dy : '';
      const r0 = rep.get(d) || { dir: '', t: 0 };
      if (dir !== r0.dir) { rep.set(d, { dir, t: -0.35 }); return dir ? { dx, dy } : null; }
      r0.t += dt;
      if (dir && r0.t >= 0.12) { r0.t = 0; return { dx, dy }; }
      return null;
    };
    const loop = () => {
      const tnow = performance.now(), dt = Math.min(0.1, (tnow - last) / 1000);
      last = tnow;
      const now = pressedDevices();
      // Each joined player's buttons this frame.
      const states = new Map(setupRef.current.players.map((p) => [p.device, readDevice(p.device)]));
      endFrame();
      const s0 = setupRef.current, L = live.current;
      let s = s0;
      s.players.forEach((p, i) => {
        const st = states.get(p.device), pv = prev.get(p.device) || {};
        const tap = (b) => st[b] && !pv[b];
        const mv = stick(p.device, st, dt);
        const ed = edRef.current[p.device];
        if (ed) {
          // Typing a name on the on-screen keyboard.
          let { cursor, fresh } = ed;
          if (mv) {
            const col = cursor % KEY_COLS, row = Math.floor(cursor / KEY_COLS), rows = Math.ceil(KEYS.length / KEY_COLS);
            const c2 = (col + mv.dx + KEY_COLS) % KEY_COLS, r2 = (row + mv.dy + rows) % rows;
            cursor = Math.min(KEYS.length - 1, r2 * KEY_COLS + c2);
          }
          let close = tap('y') || tap('start');
          let name = p.name;
          if (tap('a')) {
            const key = KEYS[cursor];
            if (key === '✓') close = true;
            else { name = typeKey(name, key, fresh); fresh = false; }
          }
          if (tap('b')) { name = typeKey(name, '⌫', fresh); fresh = false; }
          if (name !== p.name) s = { ...s, players: s.players.map((q, j) => (j === i ? { ...q, name } : q)) };
          if (close) setEditing((e) => { const n = { ...e }; delete n[p.device]; return n; });
          else if (cursor !== ed.cursor || fresh !== ed.fresh) setEditing((e) => ({ ...e, [p.device]: { cursor, fresh } }));
          prev.set(p.device, st);
          return;
        }
        if (tap('x')) s = { ...s, players: s.players.map((q, j) => (j === i ? { ...q, side: q.side === 'west' ? 'east' : 'west' } : q)) };
        if (tap('y') && isPad(p.device)) setEditing((e) => ({ ...e, [p.device]: { cursor: 0, fresh: /^Player \d$/.test(p.name) } }));
        if (i === 0) {
          const nav = navList(s);
          if (mv && mv.dy) setNavAt((n) => Math.max(0, Math.min(nav.length - 1, (n < 0 ? (mv.dy > 0 ? -1 : nav.length) : n) + mv.dy)));
          const item = nav[navRef.current];
          if (mv && mv.dx && item && item.id !== 'start') s = nudge(s, item.id, mv.dx);
          if ((tap('a') && item?.id === 'start') || tap('start')) { if (!L.problems.length) L.onStart(); }
        }
        prev.set(p.device, st);
      });
      if (s !== s0) setSetup(s);
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

  useEffect(() => { document.querySelector('.oe-navfocus')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }, [navAt]);
  const navId = navList(setup)[navAt]?.id;

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
        <p class="oe-hint">Press <kbd>A</kbd> on a controller to join (or <kbd>Space</kbd> / <kbd>/</kbd> for two players on one keyboard). Up to four. Player 1 can set everything below with their controller: stick up/down to pick a setting, left/right to change it, <kbd>Start</kbd> to begin.</p>
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
              ${editing[p.device] ? html`<div class="oe-osk">
                ${KEYS.map((k, j) => html`<span class=${'k' + (j === editing[p.device].cursor ? ' on' : '') + (k.length > 1 || k === ' ' ? ' wide' : '')}>${k === ' ' ? 'space' : k}</span>`)}
                <small><kbd>A</kbd> type · <kbd>B</kbd> delete · <kbd>Y</kbd> done</small>
              </div>` : html`<small class="oe-padhint">${isPad(p.device) ? html`<kbd>X</kbd> switch side · <kbd>Y</kbd> edit name` : html`<kbd>${KEYBOARDS[p.device].caps.X}</kbd> switch side · click the name to edit it`}</small>`}
            </div>`;
          })}
        </div>
        <h3>Builders on the site</h3>
        <div class=${'oe-side' + (navId === 'builders' ? ' oe-navfocus' : '')}>
          ${[4, 5, 6].map((n) => html`<button class=${setup.builders === n ? 'on' : ''} onClick=${() => setSetup({ ...setup, builders: n })}>${n}</button>`)}
        </div>
        ${setup.builders === 4 && html`<p class="oe-hint">Players do everything: assemblies, running pieces, holding the bridge.</p>`}
        ${setup.builders === 5 && html`<div class=${'oe-side' + (navId === 'npcRole' ? ' oe-navfocus' : '')}>
          <button class=${setup.npcRole === 'holder' ? 'on' : ''} onClick=${() => setSetup({ ...setup, npcRole: 'holder' })}>NPC holds the bridge</button>
          <button class=${setup.npcRole === 'assembler' ? 'on' : ''} onClick=${() => setSetup({ ...setup, npcRole: 'assembler' })}>NPC makes assemblies</button>
        </div>`}
        ${npcs.holder && html`<p class="oe-hint">The holder (${sides.holder} side) holds the bridge at the newest lateral until it stands, then bolts the buddy pieces.</p>`}
        ${npcs.assembler && html`<p class="oe-hint">The assembler (${sides.assembler} side) makes every assembly at its set time. Players can make assemblies alongside it to get ahead.</p>`}
      </section>

      <section class="oe-card">
        <h2>3 · Times</h2>
        ${TIMES.map((t) => html`<${Num} label=${t.label} unit=${t.unit} title=${t.title} focused=${navId === t.key} value=${setup.settings[t.key] ?? (t.key === 'assemblyTime' ? 4 : 0)} onChange=${(v) => setS({ [t.key]: Math.max(0, v) })} />`)}
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
      <button class=${'oe-go' + (navId === 'start' ? ' oe-navfocus' : '')} disabled=${problems.length > 0} onClick=${onStart}>Start building</button>
    </footer>
  </div>`;
}

function Num({ label, unit, value, onChange, title, focused }) {
  return html`<label class=${'oe-num' + (focused ? ' oe-navfocus' : '')} title=${title}><span>${label}</span><input type="number" min="0" step="any" value=${value}
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
