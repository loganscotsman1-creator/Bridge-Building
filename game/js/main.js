// Over Engineered: setup → play → results. The build order comes from the Build Sequencer's plan
// (chosen there on the 3D bridge), and follows along live while the sequencer is open in another tab.
import { html, render, useEffect, useMemo, useState } from '../../js/lib/preact.js';
import { buildModel } from '../../js/model/geometry.js';
import { PROJECT_KEY, loadAutosave } from '../../js/model/storage.js';
import { activePlan, normalizeProject } from '../../js/model/schema.js';
import { planOrder } from '../../js/model/buildorder.js';
import { createExampleProject } from '../../js/model/example.js';
import { gameFastenTime } from './order.js';
import { defaultSettings } from './world.js';
import { Setup } from './ui/setup.js';
import { Play } from './ui/play.js';
import { Results } from './ui/results.js';
import { isMusicOn, playSong, setMusicOn, unlock } from './sound.js';

const SETUP_KEY = 'oe.setup.v1';
const SETTINGS_VERSION = 3;

function loadProject() {
  try {
    const saved = loadAutosave();
    if (saved) return { project: normalizeProject(saved), from: 'sequencer' };
  } catch (e) { console.error(e); }
  return { project: normalizeProject(createExampleProject()), from: 'example' };
}
const readJSON = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } };
const writeJSON = (key, v) => { try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* full or private */ } };

function App() {
  const [{ project, from }, setSource] = useState(loadProject);
  const model = useMemo(() => buildModel(project), [project]);
  // The order the sequencer's plan builds in (each item: an assembly or a single piece).
  const order = useMemo(() => gameOrder(project, model), [project, model]);
  // The sequencer saves the project as it's edited; follow along when it's open in another tab.
  useEffect(() => {
    const onStorage = (e) => {
      if (e.key !== PROJECT_KEY || !e.newValue) return;
      setSource((cur) => {
        if (cur.from !== 'sequencer') return cur;
        try { return { project: normalizeProject(JSON.parse(e.newValue)), from: 'sequencer' }; } catch { return cur; }
      });
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);
  const [setup, setSetupState] = useState(() => {
    const s = readJSON(SETUP_KEY, {});
    // Settings saved before the game's pace changed are dropped, so everyone gets the new defaults.
    const saved = s.settingsVersion === SETTINGS_VERSION ? s.settings || {} : {};
    return { builders: 4, npcRole: 'holder', players: [], ...s, settingsVersion: SETTINGS_VERSION, settings: { ...defaultSettings(project, gameFastenTime(project)), ...saved } };
  });
  const setSetup = (s) => { setSetupState(s); writeJSON(SETUP_KEY, { ...s, players: s.players.map((p) => ({ ...p })) }); };
  const [screen, setScreen] = useState('setup');
  const [result, setResult] = useState(null);
  const [runKey, setRunKey] = useState(0);
  const [quick, setQuick] = useState(false); // building again from the results: skip the controls window

  const useProject = (p, src) => {
    const np = normalizeProject(p);
    setSource({ project: np, from: src });
    setSetup({ ...setup, settings: { ...setup.settings, fastenTime: gameFastenTime(np) } });
  };

  useEffect(() => { document.body.classList.toggle('playing', screen === 'play'); }, [screen]);
  // Mellow music everywhere but the game itself (which plays its own). Browsers only let sound
  // start after a click or key press, so the first one starts it.
  const [musicOn, setMusicState] = useState(isMusicOn());
  useEffect(() => { if (screen !== 'play') playSong('menu'); }, [screen]);
  useEffect(() => {
    const go = () => unlock();
    window.addEventListener('pointerdown', go);
    window.addEventListener('keydown', go);
    return () => { window.removeEventListener('pointerdown', go); window.removeEventListener('keydown', go); };
  }, []);
  const musicButton = html`<button class="oe-music-btn" title="Music on or off (N during a run)" onClick=${() => { setMusicOn(!isMusicOn()); setMusicState(isMusicOn()); }}>${musicOn ? '♪ Music on' : '♪ Music off'}</button>`;

  if (screen === 'play') {
    return html`<${Play} key=${runKey} quick=${quick} project=${project} order=${order} setup=${setup}
      onFinish=${(r) => { setResult(r); setScreen('results'); }} onQuit=${() => setScreen('setup')} onRestart=${() => setRunKey(runKey + 1)} />`;
  }
  if (screen === 'results') {
    return html`${musicButton}<${Results} result=${result} project=${project} order=${order} setup=${setup}
      onAgain=${() => { setQuick(true); setRunKey(runKey + 1); setScreen('play'); }} onSetup=${() => setScreen('setup')} />`;
  }
  return html`${musicButton}<${Setup} project=${project} model=${model} from=${from} order=${order} setup=${setup} setSetup=${setSetup}
    onProject=${useProject} onStart=${() => { setQuick(false); setRunKey(runKey + 1); setScreen('play'); }} />`;
}

// The game's order: the plan's build order, as game items.
function gameOrder(project, model) {
  return planOrder(model, activePlan(project)).map((it) => ({ id: it.id, memberIds: it.memberIds, buddy: !!it.buddy, time: null }));
}

const root = document.getElementById('app');
root.textContent = '';
render(html`<${App} />`, root);
