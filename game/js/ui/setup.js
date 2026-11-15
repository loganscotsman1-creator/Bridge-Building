// The setup screens, one after another:
//   1 · the title: the game's name, players joining (and their sides and names), the computers
//   2 · game play: the bridge and its build order, staging, bumping, boost
//   3 · timing: how long things take, speeds, penalties
// Player 1 runs them all from a controller (or their keys), with no pointer: the stick or d-pad
// moves a highlight to the button or setting beside, above or below it on screen (every element
// marked data-nav); A presses a button, or starts changing a number (up/down within its range, then
// A or B when done); Start goes on (and starts the game from the last screen), B goes back.
import { html, useEffect, useRef, useState } from '../../../js/lib/preact.js';
import { bridgeToSite, footingRanges } from '../../../js/model/geometry.js';
import { membersArea, sideOf } from '../../../js/model/plan.js';
import { loadAutosave, pickFile, readJSONFile } from '../../../js/model/storage.js';
import { createExampleProject } from '../../../js/model/example.js';
import { gameAssemblyTime, itemName, orderProblems, startFooting } from '../order.js';
import { KEYBOARDS, deviceHelp, deviceName, endFrame, pressedDevices, readDevice } from '../input.js';

export const PLAYER_COLORS = ['#e11d48', '#2563eb', '#16a34a', '#d97706'];

// The time settings, each with how far one press moves it and the range it can be set to.
const TIMES = [
  { key: 'fastenTime', label: 'Fasten one nut (hold X)', unit: 's', step: 0.1, min: 0.2, max: 10 },
  { key: 'assemblyTime', label: 'Make an assembly (hold X)', unit: 's', step: 0.5, min: 0, max: 30, title: "Every assembly takes this long. 0 uses each assembly's time from the sequencer." },
  { key: 'fallPenalty', label: 'Penalty when the bridge falls', unit: 's', step: 5, min: 0, max: 120 },
  { key: 'grace', label: 'Time to take hold of the bridge', unit: 's', step: 0.5, min: 0.5, max: 10 },
  { key: 'neglect', label: 'Unfastened bolts flash after', unit: 's', step: 1, min: 1, max: 30 },
  { key: 'walkSpeed', label: 'Walking speed', unit: 'in/s', step: 2, min: 20, max: 150 },
  { key: 'carrySpeed', label: 'Carrying speed', unit: 'in/s', step: 2, min: 10, max: 120 },
  { key: 'reach', label: 'Reach', unit: 'in', step: 2, min: 20, max: 80 },
  { key: 'passReach', label: 'Reach to pass a piece', unit: 'in', step: 5, min: 60, max: 150 },
  { key: 'bumpPenalty', label: 'Penalty for a piece dropped in a bump', unit: 's', step: 1, min: 0, max: 30, title: 'Only with bumping on' },
  { key: 'unplaceablePenalty', label: 'Penalty for each piece nobody can reach to place', unit: 's', step: 10, min: 0, max: 300, title: 'Added at the end' },
  { key: 'unreachablePenalty', label: 'Penalty for each bolt nobody can reach', unit: 's', step: 1, min: 0, max: 60, title: 'Added at the end' },
];
const COM_SPEED = { key: 'comSpeed', label: 'Computer speed factor', unit: '%', step: 5, min: 10, max: 150, title: "How fast every computer (COMs, the holder and the assembler) walks, carries, fastens and assembles, as a share of the players' speeds." };
const NUMBERS = new Map([...TIMES, COM_SPEED].map((t) => [t.key, t]));
const DEFAULTS = { assemblyTime: 4, comSpeed: 80, bumpPenalty: 5, unplaceablePenalty: 60, unreachablePenalty: 10 };
export const STEPS = ['Players', 'Game play', 'Timing'];

// A number kept to its range and to its step (so 0.1 steps don't drift to 0.30000004).
export function clampSetting(key, v) {
  const t = NUMBERS.get(key);
  if (!t) return v;
  const r = Math.round(Math.min(t.max, Math.max(t.min, v)) / t.step) * t.step;
  return Math.round(Math.min(t.max, Math.max(t.min, r)) * 1000) / 1000;
}
// Up / down on a number being changed.
function nudgeNumber(setup, key, dir) {
  const t = NUMBERS.get(key);
  const v = setup.settings[key] ?? DEFAULTS[key] ?? t.min;
  return { ...setup, settings: { ...setup.settings, [key]: clampSetting(key, v + dir * t.step) } };
}
// From one highlighted element, the nearest one in a direction on screen: to the side of it (in
// its row first), or above or below it (in its column first).
export function nextNav(els, cur, dx, dy) {
  const r = cur.getBoundingClientRect();
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  let best = null, bs = Infinity;
  for (const e of els) {
    if (e === cur) continue;
    const q = e.getBoundingClientRect();
    const ex = q.left + q.width / 2, ey = q.top + q.height / 2;
    let ahead, off;
    if (dx) {
      ahead = (ex - cx) * dx;
      off = q.bottom > r.top + 2 && q.top < r.bottom - 2 ? 0 : Math.abs(ey - cy); // same row: no offset
    } else {
      ahead = (ey - cy) * dy;
      off = q.right > r.left + 2 && q.left < r.right - 2 ? 0 : Math.abs(ex - cx); // same column
    }
    if (ahead < 4) continue;
    const score = ahead + off * 3;
    if (score < bs) { bs = score; best = e; }
  }
  return best;
}
// The on-screen keyboard for typing a name with a controller.
const KEYS = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ', ' ', '-', '⌫', '✓'];
const KEY_COLS = 6;
const isPad = (device) => !KEYBOARDS[device];

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
  // What player 1 has highlighted: the data-nav id of a button or setting on screen.
  // (Kept in a ref the controller loop reads and writes right away, mirrored into state to redraw,
  // so a quick press never acts on an out-of-date screen.)
  const [navId, setNavIdState] = useState(null);
  const navRef = useRef(null);
  const setNavId = (id) => { navRef.current = id; setNavIdState(id); };
  // Name editors open with Y: device -> {cursor, fresh}.
  const [editing, setEditingState] = useState({});
  const edRef = useRef({});
  const setEditing = (fn) => { edRef.current = fn(edRef.current); setEditingState(edRef.current); };
  // The number player 1 is changing (up/down changes it, A or B is done), if any.
  const [navEdit, setNavEditState] = useState(null);
  const navEditRef = useRef(null);
  const setNavEdit = (id) => { navEditRef.current = id; setNavEditState(id); };
  // Which screen: 0 title and players, 1 game play, 2 timing.
  const [step, setStepState] = useState(0);
  const stepRef = useRef(0);
  const setStep = (n) => { stepRef.current = n; setStepState(n); setNavId(null); setNavEdit(null); window.scrollTo(0, 0); };
  const live = useRef({});
  live.current = { problems, onStart, setStep };

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
          // Player 1 moves the highlight (stick or d-pad), presses buttons and changes numbers.
          const els = [...document.querySelectorAll('.oe-setup [data-nav]')].filter((e) => e.offsetParent && !e.disabled);
          let cur = els.find((e) => e.dataset.nav === navRef.current);
          if (!cur && els.length) { cur = els.find((e) => !e.dataset.nav.startsWith('tab')) || els[0]; setNavId(cur.dataset.nav); }
          const changing = navEditRef.current;
          if (changing) {
            // Changing a number: up (or right) raises it, down (or left) lowers it, within its range.
            const dir = mv ? (mv.dy ? -mv.dy : mv.dx) : 0;
            if (dir) s = nudgeNumber(s, changing, dir);
            if (tap('a') || tap('b') || tap('start')) setNavEdit(null);
          } else {
            if (mv && cur) { const nx = nextNav(els, cur, mv.dx, mv.dy); if (nx) setNavId(nx.dataset.nav); }
            if (tap('a') && cur) { if (cur.dataset.num) setNavEdit(cur.dataset.num); else cur.click(); }
            else if (tap('b') && step > 0) L.setStep(step - 1);
            else if (tap('start')) { if (step < 2) L.setStep(step + 1); else if (!L.problems.length) L.onStart(); }
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

  useEffect(() => { document.querySelector('.oe-navfocus')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }, [navId]);
  const on = (id) => (navId === id ? (navEdit === id ? ' oe-navfocus oe-editing' : ' oe-navfocus') : '');
  // A button player 1 can highlight and press with A.
  const nb = (id, chosen, onClick, label, cls = '') => html`<button data-nav=${id} class=${(chosen ? 'on' : '') + cls + on(id)} onClick=${onClick}>${label}</button>`;

  const setPlayer = (i, patch) => setSetup({ ...setup, players: setup.players.map((p, j) => (j === i ? { ...p, ...patch } : p)) });
  const setS = (patch) => setSetup({ ...setup, settings: { ...setup.settings, ...patch } });
  const npcs = npcList(setup);
  const sides = npcSides(project, model, order);

  const openProject = async () => {
    const f = await pickFile('.json,application/json');
    if (!f) return;
    try { onProject(await readJSONFile(f), 'file'); } catch (e) { alert('Could not open that file: ' + e.message); }
  };

  const toggle = (id, key, offLabel, onLabel) => html`<div class="oe-side">
    ${nb(id + ':off', !setup.settings[key], () => setS({ [key]: false }), offLabel)}
    ${nb(id + ':on', !!setup.settings[key], () => setS({ [key]: true }), onLabel)}
  </div>`;
  const num = (t) => html`<${Num} t=${t} focus=${on(t.key)} value=${setup.settings[t.key] ?? DEFAULTS[t.key] ?? t.min} onChange=${(v) => setS({ [t.key]: clampSetting(t.key, v) })} />`;
  const who = `${setup.players.length} player${setup.players.length === 1 ? '' : 's'}${npcCount(npcs) ? ' + ' + npcCount(npcs) + ' computer' + (npcCount(npcs) === 1 ? '' : 's') : ''}`;

  return html`<div class=${'oe oe-setup step' + step}>
    <nav class="oe-steps">
      ${STEPS.map((name, i) => nb('tab' + i, i === step, () => setStep(i), html`<b>${i + 1}</b> ${name}`, i < step ? ' done' : ''))}
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
          <p class="oe-hint">Up to four. With a controller, <kbd>X</kbd> switches side and <kbd>Y</kbd> edits your name. Player 1 runs the menus: move the highlight with the stick or d-pad (left/right to what's beside, up/down to what's above or below), <kbd>A</kbd> to press a button or change a number (up/down to change it, <kbd>A</kbd> when done); <kbd>Start</kbd> goes on, <kbd>B</kbd> goes back.</p>
          <div class="oe-players">
            ${[0, 1, 2, 3].map((i) => {
              const p = setup.players[i];
              const k = i - setup.players.length;
              if (!p && k < npcs.helpers.length) {
                const side = npcs.helpers[k].side;
                const setSide = (v) => { const cs = [...(setup.comSides || [])]; for (let j = 0; j < npcs.helpers.length; j++) cs[j] = cs[j] || npcs.helpers[j].side; cs[k] = v; setSetup({ ...setup, comSides: cs }); };
                return html`<div class="oe-slot com" style=${{ '--c': '#64748b' }}>
                  <div class="row"><span class="oe-com-badge">C${k + 1}</span><b>COM ${k + 1}</b><small class="oe-dev">computer</small></div>
                  <div class="oe-side">
                    ${['west', 'east'].map((s2) => nb('com' + k + ':' + s2, side === s2, () => setSide(s2), s2 === 'west' ? 'West side' : 'East side'))}
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
                  ${['west', 'east'].map((s) => nb('p' + i + ':' + s, p.side === s, () => setPlayer(i, { side: s }), s === 'west' ? 'West side' : 'East side'))}
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
          <div class="oe-side">
            ${[4, 5, 6].map((n) => nb('b' + n, setup.builders === n, () => setSetup({ ...setup, builders: n }), String(n)))}
          </div>
          <p class="oe-hint">Spots not taken by a player are filled by computer builders (COM) up to this number. Each COM's side is set on its card; COMs take whatever job is nearest on their side.</p>
          ${setup.builders === 5 && html`<div class="oe-side">
            ${nb('role:holder', setup.npcRole === 'holder', () => setSetup({ ...setup, npcRole: 'holder' }), 'NPC holds the bridge')}
            ${nb('role:assembler', setup.npcRole === 'assembler', () => setSetup({ ...setup, npcRole: 'assembler' }), 'NPC makes assemblies')}
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
            ${from !== 'example' && nb('src:example', false, () => onProject(createExampleProject(), 'example'), 'Use the example bridge')}
            ${from !== 'sequencer' && loadAutosave() && nb('src:mine', false, () => onProject(loadAutosave(), 'sequencer'), 'Use my Build Sequencer bridge')}
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

    ${navEdit && NUMBERS.get(navEdit) && html`<div class="oe-edit-hint">${NUMBERS.get(navEdit).label}: <kbd>▲</kbd> <kbd>▼</kbd> to change (${NUMBERS.get(navEdit).min} to ${NUMBERS.get(navEdit).max} ${NUMBERS.get(navEdit).unit}) · <kbd>A</kbd> done</div>`}
    <footer class="oe-start">
      ${step > 0 && nb('back', false, () => setStep(step - 1), '← Back', 'oe-back')}
      ${step === 2
        ? (problems.length ? html`<ul class="oe-problems">${problems.map((p) => html`<li>${p}</li>`)}</ul>` : html`<span class="oe-ready">Ready: ${who}</span>`)
        : html`<span class="oe-ready muted">${step === 0 ? (setup.players.length ? `${who} · next: game play` : 'Join to play') : 'Next: timing'}</span>`}
      ${step < 2
        ? nb('next', false, () => setStep(step + 1), 'Next →', 'oe-go')
        : html`<button data-nav="start" class=${'oe-go' + on('start')} disabled=${problems.length > 0} onClick=${onStart}>Start building</button>`}
    </footer>
  </div>`;
}

// A number setting: − and + step it within its range (with a controller, highlight it, press A,
// then up/down); typing works too, kept to the range.
function Num({ t, value, onChange, focus = '' }) {
  return html`<div class=${'oe-num' + focus} data-nav=${t.key} data-num=${t.key} title=${(t.title ? t.title + ' ' : '') + `(${t.min} to ${t.max} ${t.unit})`}>
    <span>${t.label}</span>
    <span class="oe-stepper">
      <button tabindex="-1" disabled=${value <= t.min} onClick=${() => onChange(value - t.step)}>−</button>
      <input type="number" min=${t.min} max=${t.max} step=${t.step} value=${value}
        onChange=${(e) => { const v = parseFloat(e.target.value); onChange(Number.isFinite(v) ? v : value); }} />
      <button tabindex="-1" disabled=${value >= t.max} onClick=${() => onChange(value + t.step)}>+</button>
    </span>
    <em>${t.unit}</em>
  </div>`;
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
