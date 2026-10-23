// App shell: header with file actions, the six tabs, and the simulation shared by the last two.
import { html, useEffect, useMemo, useState } from '../lib/preact.js';
import { canRedo, canUndo, redo, setProject, undo, updateProject, useProject } from '../model/store.js';
import { emptyProject, normalizeProject, activePlan } from '../model/schema.js';
import { createExampleProject } from '../model/example.js';
import { buildModel } from '../model/geometry.js';
import { downloadJSON, onAutosaveStatus, pickFile, readJSONFile, safeFilename } from '../model/storage.js';
import { simulate, fmt } from '../sim/simulate.js';
import { isTyping } from './common.js';
import { DesignTab } from './DesignTab.js';
import { SiteTab } from './SiteTab.js';
import { ToolsTab } from './ToolsTab.js';
import { CrewTab } from './CrewTab.js';
import { SequenceTab } from './SequenceTab.js';
import { SimulateTab } from './SimulateTab.js';

const TABS = [
  ['design', '1 · Members & bolts'],
  ['site', '2 · Site & zones'],
  ['tools', '3 · Tools'],
  ['crew', '4 · Crew & timing'],
  ['sequence', '5 · Build sequence'],
  ['simulate', '6 · Simulate'],
];

export function App() {
  const project = useProject();
  const [tab, setTab] = useState(() => {
    try { return localStorage.getItem('bss.tab') || 'design'; } catch { return 'design'; }
  });
  const [saveOk, setSaveOk] = useState(true);
  useEffect(() => onAutosaveStatus(setSaveOk), []);
  useEffect(() => { try { localStorage.setItem('bss.tab', tab); } catch { /* private mode */ } }, [tab]);

  useEffect(() => {
    const onKey = (e) => {
      if (isTyping(e)) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const model = useMemo(() => buildModel(project), [project.design]);
  const needsSim = tab === 'sequence' || tab === 'simulate';
  const sim = useMemo(() => (needsSim ? simulate(project, activePlan(project)) : null), [project, needsSim]);

  const openFile = async () => {
    const f = await pickFile('.json,application/json');
    if (!f) return;
    try {
      const data = await readJSONFile(f);
      if (data.kind === 'bridge-site' || (data.zones && !data.design)) {
        alert('That is a site layout file. Load it from the Site tab → Save & share layouts.');
        return;
      }
      setProject(normalizeProject(data), { resetHistory: false });
    } catch (e) {
      alert('Could not open that file: ' + e.message);
    }
  };

  return html`<div class="app">
    <header class="top">
      <div class="brand">Steel Bridge<br /><b>Build Sequencer</b></div>
      <input class="project-name" type="text" value=${project.name} title="Project name"
        onInput=${(e) => updateProject((p) => { p.name = e.target.value; }, { key: 'pname' })} />
      <div class="file-actions">
        <button onClick=${() => confirm('Start a new, empty project? (Save the current one first if you need it.)') && setProject(emptyProject(), { resetHistory: false })}>New</button>
        <button onClick=${() => confirm('Load the example project? Your current project will be replaced (you can undo).') && setProject(normalizeProject(createExampleProject()), { resetHistory: false })}>Example</button>
        <button onClick=${openFile}>Open…</button>
        <button class="primary" onClick=${() => downloadJSON(project, safeFilename(project.name, '.bridge.json'))} title="Download the whole project as a file you can share">Save file</button>
        <span class="sep"></span>
        <button disabled=${!canUndo()} onClick=${undo} title="Undo (Ctrl+Z)">↶</button>
        <button disabled=${!canRedo()} onClick=${redo} title="Redo (Ctrl+Shift+Z)">↷</button>
      </div>
      <div class="status">
        ${!saveOk && html`<span class="bad" title="Your browser's storage is full (usually big images). Use Save file to keep your work.">⚠ Autosave failed, use Save file</span>`}
        ${sim && html`<span class=${sim.errors.length ? 'bad' : 'ok'}>${sim.aborted ? 'Plan incomplete' : 'Build time ' + fmt(sim.endTime)}</span>`}
      </div>
    </header>
    <nav class="tabs">
      ${TABS.map(([k, label]) => html`<button class=${tab === k ? 'on' : ''} onClick=${() => setTab(k)}>${label}</button>`)}
      <span class="spacer"></span>
      <a class="help-link" href="https://github.com/loganscotsman1-creator/Bridge-Building#readme" target="_blank" rel="noopener">Help</a>
    </nav>
    <main class="content">
      ${tab === 'design' && html`<${DesignTab} project=${project} model=${model} />`}
      ${tab === 'site' && html`<${SiteTab} project=${project} model=${model} />`}
      ${tab === 'tools' && html`<${ToolsTab} project=${project} />`}
      ${tab === 'crew' && html`<${CrewTab} project=${project} />`}
      ${tab === 'sequence' && html`<${SequenceTab} project=${project} model=${model} sim=${sim} />`}
      ${tab === 'simulate' && html`<${SimulateTab} project=${project} model=${model} sim=${sim} />`}
    </main>
  </div>`;
}
