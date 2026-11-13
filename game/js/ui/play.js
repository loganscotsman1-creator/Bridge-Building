// The game itself: a full-window canvas, a fixed-step loop, controllers in, sounds out.
import { html, useEffect, useRef, useState } from '../../../js/lib/preact.js';
import { createGame, results, shelfSlot, stepGame } from '../world.js';
import { addFx, draw, makeView } from '../render.js';
import { SFX, duckMusic, isMusicOn, isMuted, setMusicOn, setMuted, startMusic, stopMusic, unlock } from '../sound.js';
import { KEYBOARDS, deviceName, endFrame, readDevice } from '../input.js';
import { npcList } from './setup.js';

const DT = 1 / 60;

export function Play({ project, order, setup, onFinish, onQuit, onRestart }) {
  const canvasRef = useRef(null);
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(false);
  pausedRef.current = paused;
  const stateRef = useRef(null);
  const [soundOn, setSoundOn] = useState(!isMuted());
  const [musicState, setMusicState] = useState(isMusicOn());

  useEffect(() => {
    const players = setup.players.map((p, i) => ({ id: 'p' + (i + 1), name: p.name, color: p.color, side: p.side, device: p.device }));
    const S = createGame({ project, order, settings: setup.settings, players, npcs: npcList(setup) });
    stateRef.current = S;
    const devOf = new Map(players.map((p) => [p.id, p.device]));
    const numOf = new Map(players.map((p, i) => [p.id, i + 1]));
    const ui = { now: 0, banners: [], fx: [], shakeUntil: 0, muted: isMuted(), countdown: 3, paused: false, numberOf: (a) => numOf.get(a.id) || '', deviceOf: (a) => deviceName(devOf.get(a.id) || ''), keysOf: (a) => KEYBOARDS[devOf.get(a.id)]?.caps || null };
    const canvas = canvasRef.current;
    const g = canvas.getContext('2d');
    let raf, last = performance.now(), acc = 0, startWas = false, finished = false, finishedAt = 0;
    const itemLabel = (id) => '#' + (S.items.find((x) => x.id === id).idx + 1);
    unlock();
    startMusic();
    let lastCount = 4;
    const onKey = (e) => {
      if (e.code === 'KeyM' || e.key === 'm' || e.key === 'M') { setMuted(!isMuted()); ui.muted = isMuted(); }
      if (e.code === 'KeyN' || e.key === 'n' || e.key === 'N') setMusicOn(!isMusicOn());
    };
    window.addEventListener('keydown', onKey);

    // Where an event happened, for its effect.
    const actorAt = (id) => S.actors.find((a) => a.id === id);
    const itemAt = (id) => {
      const it = S.items.find((x) => x.id === id);
      const pts = it.memberIds.flatMap((m) => S.members.get(m).m.corners3);
      const xy = it.memberIds.flatMap((m) => S.members.get(m).poly);
      return { x: xy.reduce((t, q) => t + q[0], 0) / xy.length, y: xy.reduce((t, q) => t + q[1], 0) / xy.length, z: pts.reduce((t, q) => t + q[2], 0) / pts.length };
    };
    const bridgeAt = () => {
      const xy = [...S.installed].flatMap((m) => S.members.get(m).poly);
      return xy.length ? { x: xy.reduce((t, q) => t + q[0], 0) / xy.length, y: xy.reduce((t, q) => t + q[1], 0) / xy.length, z: 16 } : { x: S.site.width / 2, y: S.site.depth / 2, z: 16 };
    };
    const boltAt = (id) => S.bolts.find((b) => b.id === id);
    const effect = (e) => {
      if (e.kind === 'fastened') { const b = boltAt(e.bolt); addFx(ui, 'sparks', b.x, b.y, b.z); addFx(ui, 'ring', b.x, b.y, b.z, { color: '#22c55e', size: 8 }); }
      else if (e.kind === 'bolt') { const b = boltAt(e.bolt); addFx(ui, 'ring', b.x, b.y, b.z, { color: '#fff', size: 6 }); }
      else if (e.kind === 'flash') { const b = boltAt(e.bolt); addFx(ui, 'ring', b.x, b.y, b.z, { color: '#ef4444', size: 10 }); }
      else if (e.kind === 'place') { const p = itemAt(e.item); addFx(ui, 'dust', p.x, p.y, Math.max(0, p.z - 8)); }
      else if (e.kind === 'secure') { const p = itemAt(e.item); addFx(ui, 'ring', p.x, p.y, p.z, { color: '#22c55e', size: 18, life: 0.6 }); }
      else if (e.kind === 'grab') { const a = actorAt(e.by); addFx(ui, 'ring', a.x, a.y, 0, { color: a.color, size: 10 }); }
      else if (e.kind === 'pass') { const a = actorAt(e.from), b = actorAt(e.to); addFx(ui, 'swoosh', a.x, a.y, 0, { x2: b.x, y2: b.y, color: b.color }); }
      else if (e.kind === 'ready' && e.made) { const sl = shelfSlot(S, S.items.find((x) => x.id === e.item)); if (sl) { addFx(ui, 'ring', sl.x, sl.y, 0, { color: '#facc15', size: 24, life: 0.7 }); addFx(ui, 'dust', sl.x, sl.y, 0); } }
      else if (e.kind === 'fall') { const p = bridgeAt(); addFx(ui, 'splash', p.x, p.y, p.z); addFx(ui, 'text', p.x, p.y, p.z + 10, { text: '+' + S.settings.fallPenalty + ' s', color: '#f87171', life: 1.8 }); ui.shakeUntil = ui.now + 0.6; }
      else if (e.kind === 'held') { for (const id of S.support.holders.keys()) { const a = actorAt(id); addFx(ui, 'ring', a.x, a.y, 0, { color: '#22c55e', size: 14 }); } }
      else if (e.kind === 'stands') { const p = bridgeAt(); addFx(ui, 'confetti', p.x, p.y, p.z, { n: 90 }); addFx(ui, 'text', p.x, p.y, p.z + 14, { text: 'It stands!', color: '#4ade80', life: 2 }); }
      else if (e.kind === 'done') { const p = bridgeAt(); addFx(ui, 'confetti', p.x, p.y, p.z, { n: 200 }); addFx(ui, 'text', p.x, p.y, p.z + 16, { text: 'BUILT!', color: '#facc15', life: 2.4 }); }
    };
    // Sounds that repeat while something keeps happening.
    const loops = { ratchet: 0, hammer: 0, alarm: 0, step: 0 };
    const loopSounds = (dt) => {
      const every = (name, on, period) => { if (!on) { loops[name] = 0; return; } loops[name] -= dt; if (loops[name] <= 0) { SFX[name](); loops[name] = period; } };
      every('ratchet', S.actors.some((a) => a.work?.kind === 'fasten'), 0.09);
      every('hammer', S.actors.some((a) => a.work?.kind === 'assemble'), 0.39);
      every('alarm', S.support.needed && !S.support.holders.size && !S.support.fallen && !S.support.standing, 0.5);
      every('step', S.actors.some((a) => !a.npc && a.moving), 0.27);
    };

    const frame = (ts) => {
      const W = canvas.clientWidth, H = canvas.clientHeight, dpr = window.devicePixelRatio || 1;
      if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) { canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr); }
      const inputs = new Map();
      let start = false;
      for (const p of players) { const d = readDevice(p.device); inputs.set(p.id, d); if (d.start) start = true; }
      if (start && !startWas && !finished) setPaused((x) => !x);
      startWas = start;
      if (pausedRef.current || finished || ui.countdown > 0) endFrame();
      const dtReal = Math.min(0.1, (ts - last) / 1000);
      last = ts;
      ui.now += dtReal;
      ui.paused = pausedRef.current;
      ui.muted = isMuted();
      ui.music = isMusicOn();
      duckMusic(ui.paused);
      // 3, 2, 1, GO! Nothing moves until it's done.
      if (ui.countdown > -1 && !ui.paused) {
        ui.countdown -= dtReal;
        const n = Math.ceil(ui.countdown);
        if (n !== lastCount && n >= 0) { lastCount = n; n > 0 ? SFX.count() : SFX.go(); }
      }
      if (!pausedRef.current && !finished && ui.countdown <= 0) {
        acc += dtReal;
        let stepped = false;
        while (acc >= DT) { stepGame(S, inputs, DT); acc -= DT; stepped = true; }
        if (stepped) endFrame(); // (a tap waits for the next step)
        if (stepped) loopSounds(dtReal);
        for (const e of S.events.splice(0)) {
          SFX[e.kind]?.();
          effect(e);
          const text = e.kind === 'fall' ? `Bridge fell! +${S.settings.fallPenalty} s` : e.kind === 'stands' ? 'The bridge stands on its own!' : e.kind === 'ready' && e.made ? itemLabel(e.item) + ' is ready' : e.kind === 'held' ? 'Holding again: back to work' : null;
          if (text) ui.banners.push({ text, color: e.kind === 'fall' ? '#dc2626' : e.kind === 'ready' ? '#2563eb' : '#16a34a', t0: ui.now });
          if (e.kind === 'done') { finished = true; finishedAt = ui.now; }
        }
        if (ui.banners.length > 6) ui.banners.splice(0, ui.banners.length - 6);
      }
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      draw(g, S, makeView(S, W, H), ui);
      // Let the confetti fly for a moment before the results.
      if (finished && ui.now - finishedAt > 2.8) { onFinish(results(S)); return; }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    window.__oeGame = S; // for debugging in the console
    return () => { cancelAnimationFrame(raf); window.removeEventListener('keydown', onKey); stopMusic(); };
  }, []);

  return html`<div class="oe-play">
    <canvas ref=${canvasRef} class="oe-canvas"></canvas>
    ${paused && html`<div class="oe-pause">
      <div class="oe-pause-card">
        <h2>Paused</h2>
        <button class="oe-go" onClick=${() => setPaused(false)}>Resume</button>
        <button onClick=${() => { setMuted(!isMuted()); setSoundOn(!isMuted()); }}>Sound: ${soundOn ? 'on' : 'off'} (M)</button>
        <button onClick=${() => { setMusicOn(!isMusicOn()); setMusicState(isMusicOn()); }}>Music: ${musicState ? 'on' : 'off'} (N)</button>
        <button onClick=${onRestart}>Restart</button>
        <button onClick=${() => onFinish(results(stateRef.current))}>End and see results</button>
        <button onClick=${onQuit}>Back to setup</button>
      </div>
    </div>`}
  </div>`;
}
