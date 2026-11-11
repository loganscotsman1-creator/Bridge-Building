// The game itself: a full-window canvas, a fixed-step loop, controllers in, sounds out.
import { html, useEffect, useRef, useState } from '../../../js/lib/preact.js';
import { createGame, results, stepGame } from '../world.js';
import { draw, makeView } from '../render.js';
import { deviceName, endFrame, readDevice } from '../input.js';
import { npcList } from './setup.js';

const DT = 1 / 60;

// Tiny synth sounds, so nothing needs downloading.
let audio = null;
function beep(freq, dur = 0.08, type = 'square', vol = 0.05, slide = 0) {
  try {
    audio = audio || new AudioContext();
    const o = audio.createOscillator(), g = audio.createGain();
    o.type = type; o.frequency.value = freq;
    if (slide) o.frequency.linearRampToValueAtTime(freq + slide, audio.currentTime + dur);
    g.gain.value = vol;
    g.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + dur);
    o.connect(g).connect(audio.destination);
    o.start(); o.stop(audio.currentTime + dur);
  } catch { /* no audio */ }
}
const SOUNDS = {
  grab: () => beep(520, 0.05), pass: () => beep(660, 0.08, 'triangle'), place: () => beep(330, 0.12, 'square', 0.06),
  bolt: () => beep(880, 0.04), fastened: () => beep(990, 0.09, 'triangle', 0.05, 300), secure: () => beep(740, 0.12, 'triangle'),
  ready: () => beep(600, 0.1, 'sine', 0.05, 200), fall: () => beep(200, 0.5, 'sawtooth', 0.08, -150), stands: () => { beep(523, 0.15, 'triangle'); setTimeout(() => beep(784, 0.25, 'triangle'), 150); },
  held: () => beep(440, 0.1, 'triangle'), done: () => [523, 659, 784, 1046].forEach((f, i) => setTimeout(() => beep(f, 0.2, 'triangle', 0.06), i * 130)),
};

export function Play({ project, order, setup, onFinish, onQuit, onRestart }) {
  const canvasRef = useRef(null);
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(false);
  pausedRef.current = paused;
  const stateRef = useRef(null);

  useEffect(() => {
    const players = setup.players.map((p, i) => ({ id: 'p' + (i + 1), name: p.name, color: p.color, side: p.side, device: p.device }));
    const S = createGame({ project, order, settings: setup.settings, players, npcs: npcList(setup) });
    stateRef.current = S;
    const devOf = new Map(players.map((p) => [p.id, p.device]));
    const numOf = new Map(players.map((p, i) => [p.id, i + 1]));
    const ui = { now: 0, banners: [], paused: false, numberOf: (a) => numOf.get(a.id) || '', deviceOf: (a) => deviceName(devOf.get(a.id) || '') };
    const canvas = canvasRef.current;
    const g = canvas.getContext('2d');
    let raf, last = performance.now(), acc = 0, startWas = false, finished = false;
    const itemLabel = (id) => '#' + (S.items.find((x) => x.id === id).idx + 1);

    const frame = (ts) => {
      const W = canvas.clientWidth, H = canvas.clientHeight, dpr = window.devicePixelRatio || 1;
      if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) { canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr); }
      const inputs = new Map();
      let start = false;
      for (const p of players) { const d = readDevice(p.device); inputs.set(p.id, d); if (d.start) start = true; }
      if (start && !startWas && !finished) setPaused((x) => !x);
      startWas = start;
      if (pausedRef.current || finished) endFrame();
      const dtReal = Math.min(0.1, (ts - last) / 1000);
      last = ts;
      ui.now += dtReal;
      ui.paused = pausedRef.current;
      if (!pausedRef.current && !finished) {
        acc += dtReal;
        let stepped = false;
        while (acc >= DT) { stepGame(S, inputs, DT); acc -= DT; stepped = true; }
        if (stepped) endFrame(); // (a tap waits for the next step)
        for (const e of S.events.splice(0)) {
          SOUNDS[e.kind]?.();
          const text = e.kind === 'fall' ? `Bridge fell! +${S.settings.fallPenalty} s` : e.kind === 'stands' ? 'The bridge stands on its own!' : e.kind === 'ready' && e.made ? itemLabel(e.item) + ' is ready' : e.kind === 'held' ? 'Holding again: back to work' : null;
          if (text) ui.banners.push({ text, color: e.kind === 'fall' ? '#dc2626' : e.kind === 'ready' ? '#2563eb' : '#16a34a', t0: ui.now });
          if (e.kind === 'done') finished = true;
        }
        if (ui.banners.length > 6) ui.banners.splice(0, ui.banners.length - 6);
      }
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      draw(g, S, makeView(S, W, H), ui);
      if (finished) { cancelAnimationFrame(raf); setTimeout(() => onFinish(results(S)), 1200); return; }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    window.__oeGame = S; // for debugging in the console
    return () => cancelAnimationFrame(raf);
  }, []);

  return html`<div class="oe-play">
    <canvas ref=${canvasRef} class="oe-canvas"></canvas>
    ${paused && html`<div class="oe-pause">
      <div class="oe-pause-card">
        <h2>Paused</h2>
        <button class="oe-go" onClick=${() => setPaused(false)}>Resume</button>
        <button onClick=${onRestart}>Restart</button>
        <button onClick=${() => onFinish(results(stateRef.current))}>End and see results</button>
        <button onClick=${onQuit}>Back to setup</button>
      </div>
    </div>`}
  </div>`;
}
