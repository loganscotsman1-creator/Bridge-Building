// Design tab: annotate the side view(s) and top view, check member sizes, keep isometric references.
import { html, useState } from '../lib/preact.js';
import { updateProject } from '../model/store.js';
import { uid } from '../model/ids.js';
import { enableMirror, materializeMirror, removeBolt, removeMember, removeNode } from '../model/edit.js';
import { imageFileToData, pickFile } from '../model/storage.js';
import { Annotator, PLANE_COLORS } from './Annotator.js';
import { IsoView } from './IsoView.js';
import { Check, Hint, NumField, Section, TextField } from './common.js';

export function DesignTab({ project, model }) {
  const d = project.design;
  const [view, setView] = useState('sideA');
  const [sel, setSel] = useState(null);
  const views = [
    ['sideA', 'Side view · truss A'],
    ...(d.mirrorB ? [] : [['sideB', 'Side view · truss B']]),
    ['top', 'Top view · laterals'],
    ['iso', 'Isometric references'],
    ['members', 'Members & size check'],
  ];
  const current = views.some((v) => v[0] === view) ? view : 'sideA';
  const bad = model.members.filter((m) => !m.box.fits).length;

  return html`<div class="tab-layout">
    <div class="main">
      <nav class="subtabs">
        ${views.map(([k, label]) => html`<button class=${current === k ? 'on' : ''} onClick=${() => { setView(k); setSel(null); }}>
          ${label}${k === 'members' && bad ? html` <span class="badge bad">${bad}</span>` : ''}</button>`)}
      </nav>
      ${(current === 'sideA' || current === 'sideB' || current === 'top') && html`<${Annotator} project=${project} model=${model} viewKey=${current} sel=${sel} setSel=${setSel} />`}
      ${current === 'iso' && html`<${IsoRefs} project=${project} model=${model} />`}
      ${current === 'members' && html`<${MemberTable} project=${project} model=${model} sel=${sel} setSel=${setSel} />`}
    </div>
    <aside class="side">
      ${sel && html`<${SelectionPanel} project=${project} model=${model} sel=${sel} setSel=${setSel} />`}
      <${DesignSettings} project=${project} model=${model} />
      <${Section} title="How to enter a design" open=${!d.nodes.length}>
        <ol class="steps">
          <li><b>Load image</b>: a side-view screenshot of your truss from your CAD model.</li>
          <li><b>Calibrate</b>: click two points you know (e.g. both bearings) and type their real positions in inches. x runs along the span, z is up.</li>
          <li><b>Draw member</b>: click joints in order. Each member must fit in the ${d.box.join(' × ')} in box; members that don't are drawn red.</li>
          <li><b>Add bolt</b>: click a member near each joint where a bolt goes. Two or more bolts at one member end make that end rigid.</li>
          <li>Select the joints that rest on the footings and tick <b>Bearing</b>.</li>
          <li>If truss B isn't a mirror image of A, untick <b>Truss B mirrors truss A</b> and annotate the second side view.</li>
          <li><b>Top view</b>: draw the laterals between the trusses. Pick the chord level first so clicks snap to the right joints.</li>
        </ol>
      <//>
    </aside>
  </div>`;
}

function DesignSettings({ project, model }) {
  const d = project.design;
  const set = (fn, key) => updateProject((p) => fn(p.design), { key });
  return html`<${Section} title="Bridge settings">
    <${Check} label="Truss B mirrors truss A" checked=${d.mirrorB} title="When on, truss B is generated from truss A"
      onChange=${(v) => {
        if (v) {
          if (d.nodes.some((n) => n.plane === 'B') && !confirm('Replace the truss B drawing with a mirror copy of truss A?')) return;
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
    if (!n) return html`<${Section} title="Joint (generated)"><${Hint}>This joint is a mirror copy of a truss A joint. Edit the truss A joint instead.<//><//>`;
    const set = (fn) => updateProject((p) => fn(p.design.nodes.find((x) => x.id === sel.id)), { key: 'node' + sel.id });
    const usedBy = model.members.filter((m) => m.nodeIds.includes(sel.id)).map((m) => m.name);
    return html`<${Section} title=${'Joint · ' + (n.plane === 'L' ? 'lateral' : 'truss ' + n.plane)}>
      <${NumField} label="x (along span)" unit="in" value=${n.x} onChange=${(v) => set((x) => { x.x = v; })} />
      ${n.plane === 'L' && html`<${NumField} label="y (across)" unit="in" value=${n.y} onChange=${(v) => set((x) => { x.y = v; })} />`}
      <${NumField} label="z (height)" unit="in" value=${n.z} onChange=${(v) => set((x) => { x.z = v; })} />
      <${Check} label="Bearing (rests on a footing)" checked=${n.bearing} onChange=${(v) => set((x) => { x.bearing = v; })} />
      <${Hint}>Used by: ${usedBy.length ? usedBy.join(', ') : 'no members yet'}<//>
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
      <tr><td>Length</td><td>${m.length.toFixed(2)} in</td></tr>
      <tr><td>Weight</td><td>${m.weight.toFixed(2)} lb</td></tr>
      <tr><td>Outline</td><td class=${m.box.fits ? 'ok' : 'bad'}>${m.box.dims.join(' × ')} in ${m.box.fits ? (m.box.tilted ? '✔ fits tilted' : '✔ fits') : '✘ too big'}</td></tr>
      <tr><td>Bolts</td><td>${bolts.length} (${Object.values(byNode).join(' + ') || 0} by joint)</td></tr>
    </table>`;
    if (!raw) return html`<${Section} title=${'Member · ' + m.name}>${info}<${Hint}>Mirror copy of ${m.mirrorOf ? model.memberById.get(m.mirrorOf)?.name : 'truss A'}. Edit the truss A member instead.<//><//>`;
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
      <${Hint}>On ${m ? m.name : '?'}, ${Math.round(b.s * 100)}% along its segment, at the joint x=${model.nodes.get(b.nodeId)?.x}.<//>
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
        <thead><tr><th>Name</th><th>Plane</th><th>Length</th><th>Outline (in)</th><th>Fits box</th><th>Bolts</th><th>lb</th></tr></thead>
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
  const add = async () => {
    const file = await pickFile('image/*');
    if (!file) return;
    const data = await imageFileToData(file);
    const id = uid('img');
    updateProject((p) => { p.images = { ...p.images, [id]: data }; p.design.isoRefs.push({ imageId: id, caption: file.name }); });
  };
  return html`<div class="split">
    <div class="refs">
      <div class="row"><button class="primary" onClick=${add}>Add isometric image</button>
        <span class="muted">Screenshots from your CAD model to compare with the generated 3D view.</span></div>
      ${!refs.length && html`<${Hint}>No reference images yet. Add one or more isometric views of the bridge model.<//>`}
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
    <${IsoView} model=${model} label="Generated from your annotations (drag to rotate)" />
  </div>`;
}
