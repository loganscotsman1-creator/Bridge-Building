// Over Engineered: setup → (order editor) → play → results.
import { html, render, useEffect, useMemo, useState } from '../../js/lib/preact.js';
import { buildModel } from '../../js/model/geometry.js';
import { loadAutosave } from '../../js/model/storage.js';
import { normalizeProject } from '../../js/model/schema.js';
import { createExampleProject } from '../../js/model/example.js';
import { defaultFastenTime, defaultOrder, readOrderFile } from './order.js';
import { defaultSettings } from './world.js';
import { Setup } from './ui/setup.js';
import { OrderEditor } from './ui/ordereditor.js';
import { Play } from './ui/play.js';
import { Results } from './ui/results.js';

const SETUP_KEY = 'oe.setup.v1';
const CURRENT_KEY = 'oe.current.v1';

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
  const [order, setOrderState] = useState(() => {
    const cur = readJSON(CURRENT_KEY, null);
    if (cur && cur.projectName === project.name) {
      try {
        const items = readOrderFile(cur);
        if (items.every((it) => it.memberIds.every((id) => model.memberById.has(id)))) return items;
      } catch { /* fall through */ }
    }
    return defaultOrder(project, model);
  });
  const setOrder = (items) => { setOrderState(items); writeJSON(CURRENT_KEY, { projectName: project.name, items }); };
  const [setup, setSetupState] = useState(() => {
    const s = readJSON(SETUP_KEY, {});
    return { builders: 4, npcRole: 'holder', players: [], ...s, settings: { ...defaultSettings(project, defaultFastenTime(project)), ...(s.settings || {}) } };
  });
  const setSetup = (s) => { setSetupState(s); writeJSON(SETUP_KEY, { ...s, players: s.players.map((p) => ({ ...p })) }); };
  const [screen, setScreen] = useState('setup');
  const [result, setResult] = useState(null);
  const [runKey, setRunKey] = useState(0);

  const useProject = (p, src) => {
    const np = normalizeProject(p);
    const m = buildModel(np);
    setSource({ project: np, from: src });
    setOrderState(defaultOrder(np, m));
    writeJSON(CURRENT_KEY, null);
    setSetup({ ...setup, settings: { ...setup.settings, fastenTime: defaultFastenTime(np) } });
  };

  useEffect(() => { document.body.classList.toggle('playing', screen === 'play'); }, [screen]);

  if (screen === 'order') return html`<${OrderEditor} project=${project} model=${model} order=${order} setOrder=${setOrder} settings=${setup.settings} onDone=${() => setScreen('setup')} />`;
  if (screen === 'play') {
    return html`<${Play} key=${runKey} project=${project} order=${order} setup=${setup}
      onFinish=${(r) => { setResult(r); setScreen('results'); }} onQuit=${() => setScreen('setup')} onRestart=${() => setRunKey(runKey + 1)} />`;
  }
  if (screen === 'results') {
    return html`<${Results} result=${result} project=${project} order=${order} setup=${setup}
      onAgain=${() => { setRunKey(runKey + 1); setScreen('play'); }} onSetup=${() => setScreen('setup')} />`;
  }
  return html`<${Setup} project=${project} model=${model} from=${from} order=${order} setOrder=${setOrder} setup=${setup} setSetup=${setSetup}
    onProject=${useProject} onEditOrder=${() => setScreen('order')} onStart=${() => { setRunKey(runKey + 1); setScreen('play'); }} />`;
}

const root = document.getElementById('app');
root.textContent = '';
render(html`<${App} />`, root);
