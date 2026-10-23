// Tab 1: turn screenshots of the bridge (from your CAD program) into members and bolts.
// Each view gets a checklist: add screenshot → set scale → trace lines → group into members →
// mark bolts → mark bearings.
import { html, useState } from '../lib/preact.js';
import { updateProject } from '../model/store.js';
import { uid } from '../model/ids.js';
import { autoBolts, enableMirror, materializeMirror, removeBolt, removeMember, removeNode } from '../model/edit.js';
import { imageFileToData, pickFile } from '../model/storage.js';
import { Annotator, PLANE_COLORS, loadViewImage } from './Annotator.js';
import { IsoView } from './IsoView.js';
import { Check, Hint, NumField, Section, TextField } from './common.js';

const VIEW_PLANE = { sideA: 'A', sideB: 'B', top: 'L' };

export function DesignTab({ project, model }) {
  const d = project.design;
  const [view, setView] = useState('sideA');
  const [sel, setSel] = useState(null);
  const [mode, setMode] = useState('select');
  const [group, setGroup] = useState(null);
  const views = [
    ['sideA', d.mirrorB ? 'Side view (both trusses)' : 'Side view · truss A'],
    ...(d.mirrorB ? [] : [['sideB', 'Side view · truss B']]),
    ['top', 'Top view · laterals'],
    ['iso', 'Isometric screenshots'],
    ['members', 'Member list & size check'],
  ];
  const current = views.some((v) => v[0] === view) ? view : 'sideA';
  const bad = model.members.filter((m) => !m.box.fits).length;
  const isMarkup = current === 'sideA' || current === 'sideB' || current === 'top';
  const switchView = (k) => { setView(k); setSel(null); setGroup(null); setMode('select'); };

  return html`<div class="tab-layout">
    <div class="main">
      <nav class="subtabs">
        ${views.map(([k, label]) => html`<button class=${current === k ? 'on' : ''} onClick=${() => switchView(k)}>
          ${label}${k === 'members' && bad ? html` <span class="badge bad">${bad}</span>` : ''}</button>`)}
      </nav>
      ${isMarkup && html`<${Annotator} project=${project} model=${model} viewKey=${current} sel=${sel} setSel=${setSel}
        mode=${mode} setMode=${(m) => { setMode(m); if (m !== 'group') setGroup(null); }} group=${group} setGroup=${setGroup} />`}
      ${current === 'iso' && html`<${IsoRefs} project=${project} model=${model} />`}
      ${current === 'members' && html`<${MemberTable} project=${project} model=${model} sel=${sel} setSel=${setSel} />`}
    </div>
    <aside class="side">
      ${isMarkup && html`<${Checklist} project=${project} model=${model} viewKey=${current} mode=${mode} setMode=${setMode} />`}
      ${sel && html`<${SelectionPanel} project=${project} model=${model} sel=${sel} setSel=${setSel} />`}
      <${BridgeSettings} project=${project} model=${model} open=${false} />
    </aside>
  </div>`;
}

function Checklist({ project, model, viewKey, mode, setMode }) {
  const d = project.design;
  const view = d.views[viewKey];
  const plane = VIEW_PLANE[viewKey];
  const [perEnd, setPerEnd] = useState(1);
  const members = model.members.filter((m) => m.plane === plane && d.members.some((x) => x.id === m.id));
  const nodes = [...model.nodes.values()].filter((n) => n.plane === plane);
  const segs = members.reduce((a, m) => a + m.segments.length, 0);
  const tooBig = members.filter((m) => !m.box.fits);
  const bolts = model.bolts.filter((b) => members.some((m) => m.id === b.memberId));
  const bearings = nodes.filter((n) => n.bearing).length;

  // Member ends that meet another member but have no bolt.
  const touching = new Map();
  for (const m of model.members) for (const n of m.nodeIds) touching.set(n, (touching.get(n) || 0) + 1);
  let bareEnds = 0;
  for (const m of members) {
    for (const n of m.nodeIds) {
      if ((touching.get(n) || 0) < 2) continue;
      if (!bolts.some((b) => b.memberId === m.id && b.nodeId === n)) bareEnds++;
    }
  }

  const step = (n, done, title, detail, modeKey, extra) => html`<li class=${(done ? 'done ' : '') + (mode === modeKey ? 'active' : '')}>
    <span class="tick">${done ? '✔' : n}</span>
    <div class="what">
      <div class="row"><b>${title}</b><span class="spacer"></span>
        ${modeKey && html`<button class=${'small ' + (mode === modeKey ? 'on' : '')} onClick=${() => setMode(modeKey)}>${mode === modeKey ? 'Doing' : 'Go'}</button>`}</div>
      <div class="muted">${detail}</div>
      ${extra}
    </div>
  </li>`;

  const isTop = viewKey === 'top';
  return html`<${Section} title=${isTop ? 'Mark up the top view' : 'Mark up the side view'}>
    <ol class="checklist">
      ${step(1, !!view.imageId, 'Add the screenshot', view.imageId ? project.images[view.imageId]?.name || 'Loaded' : 'Drag it onto the canvas, paste with Ctrl+V, or choose a file.', null,
        html`<button class="small" onClick=${async () => {
          const f = await pickFile('image/*');
          if (!f) return;
          await loadViewImage(project, model, viewKey, f);
          setMode('calibrate');
        }}>${view.imageId ? 'Replace' : 'Choose file'}</button>`)}
      ${step(2, !!view.scaled, 'Set the scale', view.scaled ? 'Done. Redo it any time.' : 'Click two known points (e.g. the bearings) and type their positions.', 'calibrate')}
      ${step(3, segs > 0, 'Trace the lines', `${nodes.length} joints, ${segs} lines. Click joint to joint along the bridge.`, 'trace')}
      ${step(4, members.length > 0 && !tooBig.length, 'Group lines into members', html`${members.length} members${tooBig.length ? html`, <b class="bad">${tooBig.length} too big for the ${d.box.join('×')} box</b>` : ''}. Click the lines that are one welded piece.`, 'group')}
      ${step(5, bolts.length > 0 && !bareEnds, 'Mark the bolts', html`${bolts.length} bolts${bareEnds ? html`, <b class="bad">${bareEnds} member ends with none</b>` : ''}.`, 'bolt',
        html`<div class="row autofill"><span class="muted">Auto-fill</span>
          <input type="number" min="1" max="6" step="1" value=${perEnd} onInput=${(e) => setPerEnd(Math.max(1, parseInt(e.target.value) || 1))} />
          <span class="muted">per member end</span>
          <button class="small" disabled=${!members.length} onClick=${() => {
            let n = 0;
            updateProject((p) => { n = autoBolts(p, model, plane, perEnd); });
            if (!n) alert('Every member end that meets another member already has that many bolts.');
          }}>Fill</button></div>`)}
      ${!isTop && step(6, bearings >= 2, 'Mark the bearings', `${bearings} joint${bearings === 1 ? '' : 's'} rest on the footings.`, 'bearing')}
    </ol>
    ${viewKey === 'sideA' && d.mirrorB && html`<${Hint}>Truss B is copied from this view as a mirror image. If your trusses differ, untick "Truss B mirrors truss A" in Bridge settings below and mark up a second side view.<//>`}
    ${isTop && html`<${Hint}>The trusses appear here automatically from the side view. Trace only the laterals: pick the chord level, then click from a truss A joint to a truss B joint.<//>`}
  <//>`;
}

function BridgeSettings({ project, model, open }) {
  const d = project.design;
  const set = (fn, key) => updateProject((p) => fn(p.design), { key });
  return html`<${Section} title="Bridge settings & rules" open=${open}>
    <${Check} label="Truss B mirrors truss A" checked=${d.mirrorB} title="When on, truss B is generated from truss A"
      onChange=${(v) => {
        if (v) {
          if (d.nodes.some((n) => n.plane === 'B') && !confirm('Replace your truss B markup with a mirror copy of truss A?')) return;
          updateProject((p) => enableMirror(p));
        } else updateProject((p) => materializeMirror(p, model));
      }} />
    <${NumField} label="Truss spacing" unit="in" value=${d.trussSpacing} min=${1} title="Center-to-center distance between truss A and truss B"
      onChange=${(v) => set((x) => { x.trussSpacing = v; }, 'spacing')} />
    <div class="row3">
      <span class="lbl">Size box</span>
      ${[0, 1, 2].map((i) => html`<${NumField} label="" unit="in" value=${d.box[i]} min=${0.1} onChange=${(v) => set((x) => { x.box = x.box.map((b, j) => (j === i ? v : b)); }, 'box' + i)} />`)}
    </div>
    <${NumField} label="Default tube, out of plane" unit="in" value=${d.tube.w} min=${0.05} onChange=${(v) => set((x) => { x.tube = { ...x.tube, w: v }; }, 'tw')} />
    <${NumField} label="Default tube, in plane" unit="in" value=${d.tube.d} min=${0.05} onChange=${(v) => set((x) => { x.tube = { ...x.tube, d: v }; }, 'td')} />
    <${NumField} label="Default weight" unit="lb/ft" value=${d.lbPerFt} min=${0} onChange=${(v) => set((x) => { x.lbPerFt = v; }, 'lb')} />
    <${NumField} label="Bolts for a rigid joint" value=${d.rigidBoltCount} min=${1} step="1"
      title="A member end with at least this many bolts resists rotation, so it can cantilever"
      onChange=${(v) => set((x) => { x.rigidBoltCount = Math.round(v); }, 'rigid')} />
  <//>`;
}

function SelectionPanel({ project, model, sel, setSel }) {
  const d = project.design;
  if (sel.type === 'node') {
    const n = d.nodes.find((x) => x.id === sel.id);
    const mn = model.nodes.get(sel.id);
    if (!mn) return null;
    if (!n) return html`<${Section} title="Joint (mirror copy)"><${Hint}>This joint is copied from truss A. Edit the truss A joint instead.<//><//>`;
    const set = (fn) => updateProject((p) => fn(p.design.nodes.find((x) => x.id === sel.id)), { key: 'node' + sel.id });
    const usedBy = model.members.filter((m) => m.nodeIds.includes(sel.id)).map((m) => m.name);
    return html`<${Section} title=${'Joint · ' + (n.plane === 'L' ? 'lateral' : 'truss ' + n.plane)}>
      <${NumField} label="x (along span)" unit="in" value=${n.x} onChange=${(v) => set((x) => { x.x = v; })} />
      ${n.plane === 'L' && html`<${NumField} label="y (across)" unit="in" value=${n.y} onChange=${(v) => set((x) => { x.y = v; })} />`}
      <${NumField} label="z (height)" unit="in" value=${n.z} onChange=${(v) => set((x) => { x.z = v; })} />
      <${Check} label="Bearing (rests on a footing)" checked=${n.bearing} onChange=${(v) => set((x) => { x.bearing = v; })} />
      <${Hint}>Part of: ${usedBy.length ? usedBy.join(', ') : 'no members yet'}<//>
      <button class="danger" onClick=${() => { updateProject((p) => removeNode(p, sel.id)); setSel(null); }}>Delete joint</button>
    <//>`;
  }
  if (sel.type === 'member') {
    const m = model.memberById.get(sel.id);
    const raw = d.members.find((x) => x.id === sel.id);
    if (!m) return null;
    const bolts = model.bolts.filter((b) => b.memberId === m.id);
    const byNode = {};
    for (const b of bolts) byNode[b.nodeId] = (byNode[b.nodeId] || 0) + 1;
    const info = html`<table class="kv">
      <tr><td>Length</td><td>${m.length.toFixed(2)} in (${m.segments.length} line${m.segments.length === 1 ? '' : 's'})</td></tr>
      <tr><td>Weight</td><td>${m.weight.toFixed(2)} lb</td></tr>
      <tr><td>Outline</td><td class=${m.box.fits ? 'ok' : 'bad'}>${m.box.dims.join(' × ')} in ${m.box.fits ? (m.box.tilted ? '✔ fits tilted' : '✔ fits') : '✘ too big'}</td></tr>
      <tr><td>Bolts</td><td>${bolts.length} (${Object.values(byNode).join(' + ') || 0} by joint)</td></tr>
    </table>`;
    if (!raw) return html`<${Section} title=${'Member · ' + m.name}>${info}<${Hint}>Mirror copy of ${m.mirrorOf ? model.memberById.get(m.mirrorOf)?.name : 'a truss A member'}. Edit that one instead.<//><//>`;
    const set = (fn) => updateProject((p) => fn(p.design.members.find((x) => x.id === sel.id)), { key: 'mem' + sel.id });
    return html`<${Section} title=${'Member · ' + m.name}>
      <${TextField} label="Name" value=${raw.name} onChange=${(v) => set((x) => { x.name = v; })} />
      ${info}
      <${NumField} label="Tube, out of plane" unit="in" value=${m.tube.w} min=${0.05} onChange=${(v) => set((x) => { x.tube = { ...(x.tube || {}), w: v }; })} />
      <${NumField} label="Tube, in plane" unit="in" value=${m.tube.d} min=${0.05} onChange=${(v) => set((x) => { x.tube = { ...(x.tube || {}), d: v }; })} />
      <${NumField} label="Weight" unit="lb/ft" value=${raw.lbPerFt ?? d.lbPerFt} min=${0} onChange=${(v) => set((x) => { x.lbPerFt = v; })} />
      <label class="field"><span class="lbl">Color</span><span class="inp"><input type="color" value=${raw.color || PLANE_COLORS[raw.plane]} onInput=${(e) => set((x) => { x.color = e.target.value; })} /></span></label>
      <div class="row">
        <button onClick=${() => updateProject((p) => { p.design.bolts = p.design.bolts.filter((b) => b.memberId !== sel.id); })}>Remove its bolts</button>
        <button class="danger" onClick=${() => { updateProject((p) => removeMember(p, sel.id)); setSel(null); }}>Delete member</button>
      </div>
    <//>`;
  }
  if (sel.type === 'bolt') {
    const b = model.bolts.find((x) => x.id === sel.id);
    if (!b) return null;
    const m = model.memberById.get(b.memberId);
    return html`<${Section} title="Bolt">
      <${Hint}>On ${m ? m.name : '?'}, connecting at the joint at x = ${model.nodes.get(b.nodeId)?.x} in.<//>
      ${d.bolts.some((x) => x.id === sel.id)
        ? html`<button class="danger" onClick=${() => { updateProject((p) => removeBolt(p, sel.id)); setSel(null); }}>Delete bolt</button>`
        : html`<${Hint}>Mirror copy. Delete the truss A bolt instead.<//>`}
    <//>`;
  }
  return null;
}

function MemberTable({ project, model, sel, setSel }) {
  const [filter, setFilter] = useState('');
  const list = model.members.filter((m) => m.name.toLowerCase().includes(filter.toLowerCase()));
  const totalW = model.members.reduce((a, m) => a + m.weight, 0);
  const selected = sel && sel.type === 'member' ? sel.id : null;
  return html`<div class="split">
    <div class="table-wrap">
      <div class="row"><input type="search" placeholder="Filter members" value=${filter} onInput=${(e) => setFilter(e.target.value)} />
        <span class="muted">${model.members.length} members · ${model.bolts.length} bolts · ${totalW.toFixed(1)} lb</span></div>
      <table class="grid">
        <thead><tr><th>Name</th><th>Where</th><th>Length</th><th>Outline (in)</th><th>Fits box</th><th>Bolts</th><th>lb</th></tr></thead>
        <tbody>${list.map((m) => html`<tr class=${selected === m.id ? 'sel' : ''} onClick=${() => setSel({ type: 'member', id: m.id })}>
          <td>${m.name}</td><td>${m.plane === 'L' ? 'Lateral' : 'Truss ' + m.plane}</td><td>${m.length.toFixed(1)}</td>
          <td>${m.box.dims.join(' × ')}</td><td class=${m.box.fits ? 'ok' : 'bad'}>${m.box.fits ? (m.box.tilted ? '✔ tilted' : '✔') : '✘'}</td>
          <td>${model.bolts.filter((b) => b.memberId === m.id).length}</td><td>${m.weight.toFixed(1)}</td></tr>`)}</tbody>
      </table>
    </div>
    <${IsoView} model=${model} onPick=${(m) => setSel({ type: 'member', id: m.id })}
      styleOf=${(m) => (m.id === selected ? { color: '#f59e0b', width: Math.max(2, m.tube.d * 2) } : !m.box.fits ? { color: '#dc2626' } : null)} />
  </div>`;
}

function IsoRefs({ project, model }) {
  const refs = project.design.isoRefs;
  const add = async (file) => {
    if (!file) return;
    const data = await imageFileToData(file);
    const id = uid('img');
    updateProject((p) => { p.images = { ...p.images, [id]: data }; p.design.isoRefs.push({ imageId: id, caption: file.name }); });
  };
  return html`<div class="split">
    <div class="refs" onDragOver=${(e) => e.preventDefault()} onDrop=${(e) => { e.preventDefault(); [...e.dataTransfer.files].forEach(add); }}>
      <div class="row"><button class="primary" onClick=${async () => add(await pickFile('image/*'))}>Add isometric screenshot</button>
        <span class="muted">Or drag images here. Compare them with the 3D view built from your markup.</span></div>
      ${!refs.length && html`<${Hint}>No isometric screenshots yet. These are for reference: if the 3D view on the right doesn't match your CAD model, a member or joint is marked wrong.<//>`}
      <div class="ref-grid">
        ${refs.map((r, i) => {
          const img = project.images[r.imageId];
          return html`<figure key=${r.imageId}>
            ${img && html`<img src=${img.url} alt=${r.caption} />`}
            <figcaption>
              <input type="text" value=${r.caption} onInput=${(e) => updateProject((p) => { p.design.isoRefs[i].caption = e.target.value; }, { key: 'cap' + i })} />
              <button class="danger small" onClick=${() => updateProject((p) => { p.images = { ...p.images }; delete p.images[r.imageId]; p.design.isoRefs.splice(i, 1); })}>Remove</button>
            </figcaption>
          </figure>`;
        })}
      </div>
    </div>
    <${IsoView} model=${model} label="Built from your markup (drag to rotate)" />
  </div>`;
}
