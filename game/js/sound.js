// Sound effects, made on the fly with the Web Audio API (nothing to download). Every action has
// one: grabbing, passing, placing (a steel clank), bolting, the ratchet while fastening, the
// hammer while assembling, alarms, falls and fanfares. M toggles sound; the choice is remembered.
const KEY = 'oe.sound';
let ctx = null, master = null, noiseBuf = null;
let muted = (() => { try { return localStorage.getItem(KEY) === 'off'; } catch { return false; } })();

export const isMuted = () => muted;
export function setMuted(m) {
  muted = m;
  try { localStorage.setItem(KEY, m ? 'off' : 'on'); } catch { /* private window */ }
  if (master) master.gain.value = m ? 0 : 0.7;
}

function ac() {
  if (ctx) { if (ctx.state === 'suspended') ctx.resume(); return ctx; }
  try {
    ctx = new AudioContext();
    master = ctx.createGain();
    master.gain.value = muted ? 0 : 0.7;
    const comp = ctx.createDynamicsCompressor();
    master.connect(comp).connect(ctx.destination);
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  } catch { ctx = null; }
  return ctx;
}

function tone(freq, dur, { type = 'sine', vol = 0.1, slide = 0, delay = 0, attack = 0.004 } = {}) {
  const c = ac(); if (!c || muted) return;
  const t = c.currentTime + delay;
  const o = c.createOscillator(), g = c.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(20, freq + slide), t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(master);
  o.start(t); o.stop(t + dur + 0.02);
}

function noise(dur, { vol = 0.1, type = 'bandpass', freq = 1000, q = 1, to = 0, delay = 0, attack = 0.002 } = {}) {
  const c = ac(); if (!c || muted) return;
  const t = c.currentTime + delay;
  const s = c.createBufferSource(), f = c.createBiquadFilter(), g = c.createGain();
  s.buffer = noiseBuf;
  f.type = type; f.Q.value = q;
  f.frequency.setValueAtTime(freq, t);
  if (to) f.frequency.exponentialRampToValueAtTime(to, t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  s.connect(f).connect(g).connect(master);
  s.start(t, Math.random() * 0.5); s.stop(t + dur + 0.02);
}

export const SFX = {
  // Picking something up: a quick rising pop.
  grab: () => { tone(380, 0.09, { type: 'triangle', vol: 0.12, slide: 320 }); noise(0.04, { vol: 0.05, freq: 2500, q: 2 }); },
  // Passing across the river: a whoosh.
  pass: () => { noise(0.32, { vol: 0.14, freq: 500, to: 3000, q: 1.5 }); tone(500, 0.2, { type: 'sine', vol: 0.05, slide: 400, delay: 0.05 }); },
  // Setting steel in place: a clank with a metallic ring.
  place: () => {
    noise(0.12, { vol: 0.22, freq: 1800, q: 6 });
    tone(170, 0.18, { type: 'square', vol: 0.07, slide: -60 });
    tone(1240, 0.5, { type: 'sine', vol: 0.05 }); tone(1870, 0.35, { type: 'sine', vol: 0.03 });
  },
  // A bolt pushed through.
  bolt: () => { noise(0.03, { vol: 0.12, type: 'highpass', freq: 3000 }); tone(900, 0.05, { type: 'triangle', vol: 0.06, slide: -300 }); },
  // One click of a ratchet / impact driver (repeated while fastening).
  ratchet: () => { noise(0.025, { vol: 0.07, freq: 3200, q: 8 }); tone(240, 0.03, { type: 'square', vol: 0.02 }); },
  // Nut tight: a bright ding.
  fastened: () => { tone(1320, 0.3, { type: 'sine', vol: 0.09 }); tone(1980, 0.25, { type: 'sine', vol: 0.05, delay: 0.04 }); },
  // A hammer tap (repeated while assembling).
  hammer: () => { noise(0.05, { vol: 0.12, type: 'lowpass', freq: 900 }); tone(130, 0.07, { type: 'triangle', vol: 0.08, slide: -40 }); tone(2100, 0.06, { type: 'sine', vol: 0.015 }); },
  // A piece has its bolts: it holds.
  secure: () => { tone(520, 0.1, { type: 'triangle', vol: 0.08 }); tone(780, 0.16, { type: 'triangle', vol: 0.08, delay: 0.08 }); },
  // Something new is ready to grab.
  ready: () => { tone(660, 0.18, { type: 'sine', vol: 0.07 }); tone(880, 0.22, { type: 'sine', vol: 0.07, delay: 0.1 }); },
  // Hold-the-bridge alarm (repeated during the countdown).
  alarm: () => { tone(880, 0.09, { type: 'square', vol: 0.05 }); tone(660, 0.09, { type: 'square', vol: 0.05, delay: 0.11 }); },
  // A bolt left too long starts flashing.
  flash: () => tone(330, 0.12, { type: 'triangle', vol: 0.05, slide: -60 }),
  // The bridge falls: a crash and a slide down.
  fall: () => {
    noise(0.9, { vol: 0.3, type: 'lowpass', freq: 2500, to: 150 });
    tone(220, 0.8, { type: 'sawtooth', vol: 0.08, slide: -170 });
    for (let i = 0; i < 4; i++) noise(0.1, { vol: 0.14, freq: 1500 + i * 400, q: 5, delay: 0.1 + i * 0.12 });
  },
  // Someone has hold of it again.
  held: () => { tone(440, 0.1, { type: 'triangle', vol: 0.08 }); tone(554, 0.14, { type: 'triangle', vol: 0.08, delay: 0.09 }); },
  // The bridge stands on its own.
  stands: () => [523, 659, 784, 1046].forEach((f, i) => tone(f, 0.28, { type: 'triangle', vol: 0.08, delay: i * 0.1 })),
  // Finished!
  done: () => {
    [523, 659, 784, 1046, 784, 1046, 1318].forEach((f, i) => tone(f, i === 6 ? 0.8 : 0.22, { type: 'triangle', vol: 0.09, delay: i * 0.12 }));
    noise(1.2, { vol: 0.08, type: 'highpass', freq: 6000, delay: 0.72 });
  },
  // A soft footstep.
  step: () => noise(0.04, { vol: 0.025, type: 'lowpass', freq: 500 }),
};
export const unlock = () => ac();

// ---------- background music ----------
// An upbeat chiptune loop, written out here and played by a small look-ahead scheduler: kick,
// hi-hat, a bouncing bass and a lead tune over C, Am, F, G. N toggles it; the choice is remembered.
const MUSIC_KEY = 'oe.music';
let musicOn = (() => { try { return localStorage.getItem(MUSIC_KEY) !== 'off'; } catch { return true; } })();
let musicBus = null, timer = null, nextAt = 0, step = 0;
const BPM = 132, STEP = 60 / BPM / 4; // sixteenth notes
const midi = (n) => 440 * Math.pow(2, (n - 69) / 12);
const CHORDS = [[48, 52, 55], [45, 48, 52], [41, 45, 48], [43, 47, 50]]; // C, Am, F, G
// Lead tune: one note (MIDI) or null per sixteenth, two 4-bar phrases.
const LEAD = [
  72, null, 76, null, 79, null, 76, 79, 81, null, 79, null, 76, null, 74, null,
  72, null, 76, null, 77, null, 76, null, 72, null, 69, null, 72, null, null, null,
  69, null, 72, null, 77, null, 76, 77, 81, null, 77, null, 76, null, 72, null,
  74, null, 79, null, 83, null, 81, 79, 77, null, 74, null, 71, null, null, null,
  72, 72, null, 76, null, 79, null, 84, 83, null, 79, null, 76, null, 79, null,
  81, null, 79, null, 76, null, 72, null, 69, 72, 76, null, 72, null, null, null,
  77, null, 81, null, 84, null, 81, null, 79, null, 77, null, 76, null, 74, null,
  74, null, 76, null, 77, null, 79, null, 83, null, 86, null, 84, null, null, null,
];

function note(freq, at, dur, type, vol) {
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.type = type; o.frequency.setValueAtTime(freq, at);
  g.gain.setValueAtTime(0.0001, at);
  g.gain.exponentialRampToValueAtTime(vol, at + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  o.connect(g).connect(musicBus);
  o.start(at); o.stop(at + dur + 0.02);
}
function drum(at, kind) {
  if (kind === 'kick') {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.frequency.setValueAtTime(150, at); o.frequency.exponentialRampToValueAtTime(45, at + 0.12);
    g.gain.setValueAtTime(0.5, at); g.gain.exponentialRampToValueAtTime(0.0001, at + 0.16);
    o.connect(g).connect(musicBus); o.start(at); o.stop(at + 0.18);
    return;
  }
  const s = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
  s.buffer = noiseBuf; f.type = 'highpass'; f.frequency.value = kind === 'snare' ? 1500 : 7000;
  const dur = kind === 'snare' ? 0.12 : 0.04;
  g.gain.setValueAtTime(kind === 'snare' ? 0.25 : 0.12, at); g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  s.connect(f).connect(g).connect(musicBus); s.start(at, Math.random() * 0.5); s.stop(at + dur + 0.02);
}
function playStep(i, at) {
  const bar = Math.floor(i / 16) % 4, s = i % 16, ch = CHORDS[bar];
  if (s % 4 === 0) drum(at, 'kick');
  if (s === 4 || s === 12) drum(at, 'snare');
  if (s % 2 === 1) drum(at, 'hat');
  // Bass: root and fifth, bouncing.
  if (s % 2 === 0) note(midi(ch[0] - 12 + (s % 8 === 4 ? 7 : 0)), at, STEP * 1.6, 'triangle', 0.32);
  // Chord stabs on the off-beats.
  if (s % 4 === 2) for (const n of ch) note(midi(n + 12), at, STEP * 0.9, 'square', 0.025);
  const l = LEAD[i % LEAD.length];
  if (l) note(midi(l), at, STEP * 1.8, 'square', 0.05);
}
function tick() {
  if (!ctx) return;
  while (nextAt < ctx.currentTime + 0.25) { playStep(step, nextAt); step++; nextAt += STEP; }
}
export const isMusicOn = () => musicOn;
export function setMusicOn(on) {
  musicOn = on;
  try { localStorage.setItem(MUSIC_KEY, on ? 'on' : 'off'); } catch { /* private window */ }
  if (musicBus) musicBus.gain.value = on ? 0.35 : 0;
}
// Quieter while paused.
export function duckMusic(d) { if (musicBus && musicOn) musicBus.gain.value = d ? 0.12 : 0.35; }
export function startMusic() {
  const c = ac(); if (!c || timer) return;
  musicBus = musicBus || (() => { const g = c.createGain(); g.connect(master); return g; })();
  musicBus.gain.value = musicOn ? 0.35 : 0;
  step = 0; nextAt = c.currentTime + 0.1;
  timer = setInterval(tick, 60);
  tick();
}
export function stopMusic() {
  if (timer) clearInterval(timer);
  timer = null;
  if (musicBus) { const g = musicBus; g.gain.setTargetAtTime(0, ctx.currentTime, 0.1); musicBus = null; setTimeout(() => g.disconnect(), 600); }
}
// Countdown: three beeps then a higher one for GO.
SFX.count = () => tone(660, 0.18, { type: 'square', vol: 0.09 });
SFX.go = () => { tone(1320, 0.4, { type: 'square', vol: 0.1 }); tone(990, 0.4, { type: 'triangle', vol: 0.08 }); };
