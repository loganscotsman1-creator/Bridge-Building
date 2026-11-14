// The setup screens, one after another:
//   1 · the title: the game's name, players joining (and their sides and names), the computers
//   2 · game play: the bridge and its build order, staging, bumping, boost
//   3 · timing: how long things take, speeds, penalties
// Player 1 runs them all from a controller (or their keys), with no pointer: the stick or d-pad
// moves a highlight over the settings and buttons; A on a button presses it, A on a setting starts
// changing it (up/down, then A or B when done); Start goes on (and starts the game from the last
// screen), B goes back.
import { html, useEffect, useRef, useState } from '../../../js/lib/preact.js';
import { bridgeToSite, footingRanges } from '../../../js/model/geometry.js';
import { membersArea, sideOf } from '../../../js/model/plan.js';
import { loadAutosave, pickFile, readJSONFile } from '../../../js/model/storage.js';
import { createExampleProject } from '../../../js/model/example.js';
import { gameAssemblyTime, itemName, orderProblems, startFooting } from '../order.js';
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
  { key: 'bumpPenalty', label: 'Penalty for a piece dropped in a bump', unit: 's', step: 1, title: 'Only with bumping on' },
  { key: 'unplaceablePenalty', label: 'Penalty for each piece nobody can reach to place', unit: 's', step: 10, title: 'Added at the end' },
  { key: 'unreachablePenalty', label: 'Penalty for each bolt nobody can reach', unit: 's', step: 1, title: 'Added at the end' },
];
const COM_SPEED = { key: 'comSpeed', label: 'Computer speed factor', unit: '%', step: 5, title: "How fast every computer (COMs, the holder and the assembler) walks, carries, fastens and assembles, as a share of the players' speeds." };
const DEFAULTS = { assemblyTime: 4, comSpeed: 80, bumpPenalty: 5, unplaceablePenalty: 60, unreachablePenalty: 10 };
export const STEPS = ['Players', 'Game play', 'Timing'];
// Highlighted items that are buttons (A presses them); everything else is a setting (A edits it).
const BUTTONS = new Set(['next', 'back', 'start', 'src:example', 'src:mine']);
// The on-screen keyboard for typing a name with a controller.
const KEYS = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ', ' ', '-', '⌫', '✓'];
const KEY_COLS = 6;
const isPad = (device) => !KEYBOARDS[device];

// Player 1's list of things to move through with the d-pad on each screen, in screen order.
function navList(setup, step) {
  if (step === 0) {
    return [
      { id: 'builders' },
      ...(setup.builders === 5 ? [{ id: 'npcRole' }] : []),
      ...npcList(setup).helpers.map((_, k) => ({ id: 'com' + k })),
      ...(npcCount(npcList(setup)) ? [{ id: 'comSpeed' }] : []), // (only with computers playing)
      { id: 'next' },
    ];
  }
  if (step === 1) return [...(setup.sources || []).map((id) => ({ id })), { id: 'staging' }, { id: 'bumps' }, { id: 'boost' }, { id: 'back' }, { id: 'next' }];
  return [...TIMES.map((t) => ({ id: t.key, time: t })), { id: 'back' }, { id: 'start' }];
}
// Left/right on one of player 1's settings.
function nudge(setup, id, dir) {
  if (id === 'staging') return { ...setup, settings: { ...setup.settings, freeStaging: !setup.settings.freeStaging } };
  if (id === 'bumps') return { ...setup, settings: { ...setup.settings, bumps: !setup.settings.bumps } };
  if (id === 'boost') return { ...setup, settings: { ...setup.settings, boost: !setup.settings.boost } };
  if (id === 'builders') return { ...setup, builders: Math.max(4, Math.min(6, setup.builders + dir)) };
  if (id === 'npcRole') return { ...setup, npcRole: setup.npcRole === 'holder' ? 'assembler' : 'holder' };
  if (id.startsWith('com')) {
    const k = +id.slice(3), hs = npcList(setup).helpers;
    const cs = hs.map((h) => h.side);
    cs[k] = cs[k] === 'west' ? 'east' : 'west';
    return { ...setup, comSides: cs };
  }
  const t = id === 'comSpeed' ? COM_SPEED : TIMES.find((x) => x.key === id);
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

// The computer builders: the role NPCs (5 builders: one, holding or assembling; 6: both), plus a
// COM in every player spot left empty, up to the number of builders chosen. Each COM has a side.
export function npcList(setup) {
  const roles = setup.builders === 6 ? { holder: true, assembler: true } : setup.builders === 5 ? { [setup.npcRole]: true } : {};
  const n = Math.max(0, Math.min(4 - setup.players.length, setup.builders - setup.players.length - Object.keys(roles).length));
  return { ...roles, helpers: Array.from({ length: n }, (_, k) => ({ side: comSide(setup, k) })) };
}
export const npcCount = (npcs) => (npcs.holder ? 1 : 0) + (npcs.assembler ? 1 : 0) + (npcs.helpers?.length || 0);
// A COM's side: as set, else whichever side has fewer builders so far.
export function comSide(setup, k) {
  if (setup.comSides?.[k]) return setup.comSides[k];
  const on = { west: 0, east: 0 };
  for (const p of setup.players) on[p.side]++;
  for (let j = 0; j < k; j++) on[comSide(setup, j)]++;
  return on.west <= on.east ? 'west' : 'east';
}

export function setupProblems(project, model, order, setup) {
  const out = orderProblems(order, model, project.site.rules).map((p) => p.msg);
  if (!setup.players.length) out.push('Join at least one player: press A on a controller, or Space / slash on the keyboard.');
  const npcs = npcList(setup);
  const sides = npcSides(project, model, order);
  const on = { west: 0, east: 0 };
  for (const p of setup.players) on[p.side]++;
  if (npcs.holder) on[sides.holder]++;
  if (npcs.assembler) on[sides.assembler]++;
  for (const h of npcs.helpers) on[h.side]++;
  if (setup.players.length && (!on.west || !on.east)) out.push('Put at least one builder on each side of the river.');
  if (setup.players.length + npcCount(npcs) > (project.site.rules?.maxBuilders || 6)) out.push('Too many builders for the rules.');
  return out;
}

export function Setup({ project, model, from, order, setup, setSetup, onProject, onStart }) {
  const problems = setupProblems(project, model, order, setup);
  const setupRef = useRef(setup);
  setupRef.current = setup;
  const [flash, setFlash] = useState(null);
  // Player 1 moves through the settings with the stick: which one is highlighted.
  // (Both are kept in refs the controller loop reads and writes right away, mirrored into state to
  // redraw, so a quick press never acts on an out-of-date screen.)
  const [navAt, setNavAtState] = useState(0);
  const navRef = useRef(0);
  const setNavAt = (fn) => { navRef.current = fn(navRef.current); setNavAtState(navRef.current); };
  // Name editors open with Y: device -> {cursor, fresh}.
  const [editing, setEditingState] = useState({});
  const edRef = useRef({});
  const setEditing = (fn) => { edRef.current = fn(edRef.current); setEditingState(edRef.current); };
  // The setting player 1 is changing (up/down changes it, A or B is done), if any.
  const [navEdit, setNavEditState] = useState(null);
  const navEditRef = useRef(null);
  const setNavEdit = (id) => { navEditRef.current = id; setNavEditState(id); };
  // Which screen: 0 title and players, 1 game play, 2 timing.
  const [step, setStepState] = useState(0);
  const stepRef = useRef(0);
  const setStep = (n) => { stepRef.current = n; setStepState(n); navRef.current = 0; setNavAtState(0); setNavEdit(null); window.scrollTo(0, 0); };
  const live = useRef({});
  live.current = { problems, onStart, setStep, onProject };

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
        const step = stepRef.current;
        if (step === 0 && tap('x') && !tap('b')) s = { ...s, players: s.players.map((q, j) => (j === i ? { ...q, side: q.side === 'west' ? 'east' : 'west' } : q)) };
        if (step === 0 && tap('y') && isPad(p.device)) setEditing((e) => ({ ...e, [p.device]: { cursor: 0, fresh: /^Player \d$/.test(p.name) } }));
        if (i === 0) {
          // Player 1 moves the highlight (stick or d-pad), presses buttons and changes settings.
          const nav = navList(s, step);
          const editingId = navEditRef.current;
          if (editingId && nav.some((n) => n.id === editingId)) {
            // Changing a setting: up (or right) raises it or flips it, down (or left) lowers it.
            const dir = mv ? (mv.dy ? -mv.dy : mv.dx) : 0;
            if (dir) s = nudge(s, editingId, dir);
            if (tap('a') || tap('b') || tap('start')) setNavEdit(null);
          } else {
            if (editingId) setNavEdit(null);
            const d = mv ? mv.dy || mv.dx : 0;
            if (d) setNavAt((n) => Math.max(0, Math.min(nav.length - 1, (n < 0 ? 0 : n) + d)));
            const item = nav[Math.max(0, navRef.current)];
            const pressed = tap('a') ? item?.id : null;
            if (pressed && !BUTTONS.has(pressed)) setNavEdit(pressed);
            else if (pressed === 'back' || (tap('b') && step > 0)) L.setStep(step - 1);
            else if (pressed === 'next' || (tap('start') && step < 2)) L.setStep(step + 1);
            else if (pressed === 'start' || (tap('start') && step === 2)) { if (!L.problems.length) L.onStart(); }
            else if (pressed === 'src:example') L.onProject(createExampleProject(), 'example');
            else if (pressed === 'src:mine') { const saved = loadAutosave(); if (saved) L.onProject(saved, 'sequencer'); }
          }
        }
        prev.set(p.device, st);
      });
      if (s !== s0) setSetup(s);
      for (const d of now) {
        if (held.has(d) || stepRef.current !== 0) continue; // joining is on the first screen
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
  // The project buttons on the game play screen are in the highlight list too.
  const sources = [...(from !== 'example' ? ['src:example'] : []), ...(from !== 'sequencer' && loadAutosave() ? ['src:mine'] : [])];
  setupRef.current = { ...setup, sources }; // (the controller loop reads the list from here)
  const navId = navList({ ...setup, sources }, step)[navAt]?.id;
  const on = (id) => (navId === id ? (navEdit === id ? ' oe-navfocus oe-editing' : ' oe-navfocus') : '');

  const setPlayer = (i, patch) => setSetup({ ...setup, players: setup.players.map((p, j) => (j === i ? { ...p, ...patch } : p)) });
  const setS = (patch) => setSetup({ ...setup, settings: { ...setup.settings, ...patch } });
  const npcs = npcList(setup);
  const sides = npcSides(project, model, order);

  const openProject = async () => {
    const f = await pickFile('.json,application/json');
    if (!f) return;
    try { onProject(await readJSONFile(f), 'file'); } catch (e) { alert('Could not open that file: ' + e.message); }
  };

  const toggle = (id, key, offLabel, onLabel) => html`<div class=${'oe-side' + on(id)}>
    <button class=${!setup.settings[key] ? 'on' : ''} onClick=${() => setS({ [key]: false })}>${offLabel}</button>
    <button class=${setup.settings[key] ? 'on' : ''} onClick=${() => setS({ [key]: true })}>${onLabel}</button>
  </div>`;
  const num = (t) => html`<${Num} step=${t.step} label=${t.label} unit=${t.unit} title=${t.title} focus=${on(t.key)} value=${setup.settings[t.key] ?? DEFAULTS[t.key] ?? 0} onChange=${(v) => setS({ [t.key]: Math.max(0, v) })} />`;
  const who = `${setup.players.length} player${setup.players.length === 1 ? '' : 's'}${npcCount(npcs) ? ' + ' + npcCount(npcs) + ' computer' + (npcCount(npcs) === 1 ? '' : 's') : ''}`;

  return html`<div class=${'oe oe-setup step' + step}>
    <nav class="oe-steps">
      ${STEPS.map((name, i) => html`<button class=${(i === step ? 'on' : '') + (i < step ? ' done' : '')} onClick=${() => setStep(i)}><b>${i + 1}</b> ${name}</button>`)}
      <span class="spacer"></span>
      <a class="oe-link" href="../">← Build Sequencer</a>
    </nav>

    ${step === 0 && html`
      <header class="oe-title">
        <div class="oe-logo big">OVER<br />ENGINEERED</div>
        <div class="oe-tag">A co-op bridge build for practicing teamwork, on your bridge and this year's site.</div>
        <div class="oe-press">${setup.players.length ? html`<b>${who}</b> · more can join` : html`Press <kbd>A</kbd> on a controller to join, or <kbd>Space</kbd> / <kbd>/</kbd> on the keyboard`}</div>
      </header>
      <div class="oe-grid two">
        <section class="oe-card">
          <h2>Players</h2>
          <p class="oe-hint">Up to four. With a controller, <kbd>X</kbd> switches side and <kbd>Y</kbd> edits your name. Player 1 runs the menus: move the highlight with the stick or d-pad, <kbd>A</kbd> to press a button or change a setting (up/down to change it, <kbd>A</kbd> when done); <kbd>Start</kbd> goes on, <kbd>B</kbd> goes back.</p>
          <div class="oe-players">
            ${[0, 1, 2, 3].map((i) => {
              const p = setup.players[i];
              const k = i - setup.players.length;
              if (!p && k < npcs.helpers.length) {
                const side = npcs.helpers[k].side;
                const setSide = (v) => { const cs = [...(setup.comSides || [])]; for (let j = 0; j < npcs.helpers.length; j++) cs[j] = cs[j] || npcs.helpers[j].side; cs[k] = v; setSetup({ ...setup, comSides: cs }); };
                return html`<div class=${'oe-slot com' + on('com' + k)} style=${{ '--c': '#64748b' }}>
                  <div class="row"><span class="oe-com-badge">C${k + 1}</span><b>COM ${k + 1}</b><small class="oe-dev">computer</small></div>
                  <div class="oe-side">
                    ${['west', 'east'].map((s2) => html`<button class=${side === s2 ? 'on' : ''} onClick=${() => setSide(s2)}>${s2 === 'west' ? 'West side' : 'East side'}</button>`)}
                  </div>
                  <small class="oe-padhint">Does the nearest job. Press <kbd>A</kbd> to take this spot.</small>
                </div>`;
              }
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
        </section>
        <section class="oe-card">
          <h2>Computers</h2>
          <h3>Builders on the site</h3>
          <div class=${'oe-side' + on('builders')}>
            ${[4, 5, 6].map((n) => html`<button class=${setup.builders === n ? 'on' : ''} onClick=${() => setSetup({ ...setup, builders: n })}>${n}</button>`)}
          </div>
          <p class="oe-hint">Spots not taken by a player are filled by computer builders (COM) up to this number. Each COM's side is set on its card; COMs take whatever job is nearest on their side.</p>
          ${setup.builders === 5 && html`<div class=${'oe-side' + on('npcRole')}>
            <button class=${setup.npcRole === 'holder' ? 'on' : ''} onClick=${() => setSetup({ ...setup, npcRole: 'holder' })}>NPC holds the bridge</button>
            <button class=${setup.npcRole === 'assembler' ? 'on' : ''} onClick=${() => setSetup({ ...setup, npcRole: 'assembler' })}>NPC makes assemblies</button>
          </div>`}
          ${npcs.holder && html`<p class="oe-hint">The holder (${sides.holder} side) holds the bridge, walking out along it as it grows and bolting what it can reach, until it stands; then it does the nearest job.</p>`}
          ${npcs.assembler && html`<p class="oe-hint">The assembler (${sides.assembler} side) makes every assembly (at the computer speed below), then runs pieces. Players can make assemblies alongside it to get ahead.</p>`}
          ${npcCount(npcs) > 0 ? html`${num(COM_SPEED)}<p class="oe-hint">Every computer works at this share of the players' speeds: walking, carrying, fastening and assembling.</p>`
            : html`<p class="oe-hint">Every spot is a player: no computers this time.</p>`}
        </section>
      </div>`}

    ${step === 1 && html`
      <div class="oe-grid two">
        <section class="oe-card">
          <h2>Bridge & build order</h2>
          <div class="oe-src">
            <b>${project.name}</b>
            <span>${from === 'sequencer' ? 'from your Build Sequencer' : from === 'file' ? 'from a project file' : 'the example bridge'} · ${model.members.length} pieces · ${model.bolts.length} bolts</span>
          </div>
          <div class="row wrap">
            <button onClick=${openProject}>Open project file…</button>
            ${from !== 'example' && html`<button class=${on('src:example')} onClick=${() => onProject(createExampleProject(), 'example')}>Use the example bridge</button>`}
            ${from !== 'sequencer' && loadAutosave() && html`<button class=${on('src:mine')} onClick=${() => onProject(loadAutosave(), 'sequencer')}>Use my Build Sequencer bridge</button>`}
          </div>
          <${OrderSummary} project=${project} model=${model} order=${order} settings=${setup.settings} />
          <p class="oe-hint">${from === 'sequencer'
            ? html`The order and assemblies come from your Build Sequencer plan (5 · Build sequence → Build order). Change them there: with the sequencer open in another tab, this list follows along.`
            : 'The order and assemblies come from this project’s plan. To change them, open it in the Build Sequencer (5 · Build sequence → Build order).'}</p>
        </section>
        <section class="oe-card">
          <h2>Game play</h2>
          <h3>Staging</h3>
          ${toggle('staging', 'freeStaging', 'Pieces come out in order', 'Pick pieces yourself')}
          <p class="oe-hint">${setup.settings.freeStaging
            ? 'Every piece waits in the ready area and grabbing takes the one nearest you. Assemblies are made one at a time on a small bench in the corner, and each has to be moved off (set down in the ready area, or run to the bridge) before the next. Runners keep track of what goes next.'
            : 'Pieces appear in the ready area in build order, and grabbing always takes the next one.'}</p>
          <h3>Bumping into each other</h3>
          ${toggle('bumps', 'bumps', 'Off', 'On')}
          <p class="oe-hint">${setup.settings.bumps
            ? `Run into a teammate and you're both dizzy for a second. Anything you were carrying drops where you stand (+${setup.settings.bumpPenalty ?? 5} s each; pick it back up with A). Drop it over the river and it floats away downstream, turning up back in the ready area.`
            : 'Builders just slide past each other.'}</p>
          <h3>Boost</h3>
          ${toggle('boost', 'boost', 'Off', 'On')}
          <p class="oe-hint">${setup.settings.boost
            ? 'Every builder gets 8 seconds of boost to use whenever they like: hold RB (or Shift on the keyboard) to move 150% faster. A bar over their head drains as it’s used, and once it’s empty it’s gone for the rest of the build.'
            : 'Everyone moves at the set speeds.'}</p>
        </section>
      </div>`}

    ${step === 2 && html`
      <div class="oe-grid two">
        <section class="oe-card">
          <h2>Timing</h2>
          ${TIMES.map(num)}
          <p class="oe-hint">Defaults keep the game moving: quicker nuts and assemblies, brisker walking.</p>
        </section>
        <section class="oe-card">
          <h2>How to play</h2>
          <ul class="oe-how-list">
            <li><b>A</b>: grab the next item from the ready area (from anywhere in it) or from a teammate, place a piece where it goes (puts in its first bolt), place a bolt. Hold A while carrying to pass a piece across.</li>
            <li><b>X</b> (hold): fasten a nut, or make an assembly in the assembly area. Several builders can work there at once, on different assemblies or together on one.</li>
            <li><b>LB</b> (hold): hold the bridge up. While holding you can walk along the bridge on your side, and still bolt what's in reach; walk out as it grows. Let go with nobody else holding and it falls.</li>
            ${setup.settings.boost && html`<li><b>RB</b> (hold): boost, 150% speed, 8 s in all.</li>`}
            <li>A piece touching the bridge in one place needs one bolt; in two or more places, two bolts in different places. Until then whoever placed it holds it. ★ pieces need a buddy to bolt them.</li>
            <li>A bolt in a dashed amber ring is a long reach: stand right at the edge. A red ✕ (or a piece outlined in red) is out of anyone's reach: it's left undone, at a penalty when you finish.</li>
            <li>The bridge stands on its own once it reaches both footings with the trusses tied together. Then fasten everything and get back to a staging yard.</li>
          </ul>
        </section>
      </div>`}

    ${navEdit && html`<div class="oe-edit-hint">Changing a setting: <kbd>▲</kbd> <kbd>▼</kbd> to change it · <kbd>A</kbd> done</div>`}
    <footer class="oe-start">
      ${step > 0 && html`<button class=${'oe-back' + on('back')} onClick=${() => setStep(step - 1)}>← Back</button>`}
      ${step === 2
        ? (problems.length ? html`<ul class="oe-problems">${problems.map((p) => html`<li>${p}</li>`)}</ul>` : html`<span class="oe-ready">Ready: ${who}</span>`)
        : html`<span class="oe-ready muted">${step === 0 ? (setup.players.length ? `${who} · next: game play` : 'Join to play') : 'Next: timing'}</span>`}
      ${step < 2
        ? html`<button class=${'oe-go' + on('next')} onClick=${() => setStep(step + 1)}>Next →</button>`
        : html`<button class=${'oe-go' + on('start')} disabled=${problems.length > 0} onClick=${onStart}>Start building</button>`}
    </footer>
  </div>`;
}

function Num({ label, unit, value, onChange, title, focus = '', step }) {
  return html`<label class=${'oe-num' + focus} title=${title}><span>${label}</span><input type="number" min="0" step="any" data-step=${step} value=${value}
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
