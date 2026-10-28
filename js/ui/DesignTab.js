// Tab 1: turn screenshots of the bridge (from your CAD program) into members and bolts by placing
// box outlines over them. Each view gets a checklist: add screenshot → set scale → place member
// boxes → place bolts → mark footing supports.
import { html, useState } from '../lib/preact.js';
import { updateProject } from '../model/store.js';
import { uid } from '../model/ids.js';
import { boxLimits } from '../model/schema.js';
import { autoBolts, clampBox, duplicateMember, enableMirror, materializeMirror, removeBolt, removeMember, squareUp } from '../model/edit.js';
import { boltMembers, footingPoints } from '../model/geometry.js';
import { imageFileToData, pickFile } from '../model/storage.js';
import { jointLabel } from '../model/plan.js';
import { Annotator, PLANE_COLORS, ftIn, loadViewImage } from './Annotator.js';
import { IsoView } from './IsoView.js';
import { Check, Hint, NumField, Section, SelectField, TextField } from './common.js';

const VIEW_PLANE = { sideA: 'A', sideB: 'B', top: 'L' };

export function DesignTab({ project, model }) {
  const d = project.design;
  const [view, setView] = useState('sideA');
  const [sel, setSel] = useState(null);
  const [mode, setMode] = useState('box');
  const views = [
    ['sideA', d.mirrorB ? 'Side view (both trusses)' : 'Side view · truss A'],
    ...(d.mirrorB ? [] : [['sideB', 'Side view · truss B']]),
    ['top', 'Top view · laterals'],
    ['iso', 'Isometric screenshots'],
    ['members', 'Member list'],
    ['connections', 'Connections'],
  ];
  const current = views.some((v) => v[0] === view) ? view : 'sideA';
  const bad = model.members.filter((m) => !m.box.fits).length;
  const isMarkup = current === 'sideA' || current === 'sideB' || current === 'top';
  const switchView = (k) => { setView(k); setSel(null); setMode('box'); };

  return html`<div class="tab-layout">
    <div class="main">
      <nav class="subtabs">
        ${views.map(([k, label]) => html`<button class=${current === k ? 'on' : ''} onClick=${() => switchView(k)}>
          ${label}${k === 'members' && bad ? html` <span class="badge bad">${bad}</span>` : ''}</button>`)}
      </nav>
      ${isMarkup && html`<${Annotator} project=${project} model=${model} viewKey=${current} sel=${sel} setSel=${setSel} mode=${mode} setMode=${setMode} />`}
      ${current === 'iso' && html`<${IsoRefs} project=${project} model=${model} />`}
      ${current === 'members' && html`<${MemberTable} project=${project} model=${model} sel=${sel} setSel=${setSel} />`}
      ${current === 'connections' && html`<${ConnectionTable} project=${project} model=${model} />`}
    </div>
    <aside class="side">
      ${isMarkup && html`<div data-tour="checklist"><${Checklist} project=${project} model=${model} viewKey=${current} mode=${mode} setMode=${setMode} /></div>`}
      ${sel && html`<${SelectionPanel} project=${project} model=${model} sel=${sel} setSel=${setSel} />`}
      <${BridgeSettings} project=${project} model=${model} open=${false} />
    </aside>
  </div>`;
}

function Checklist({ project, model, viewKey, mode, setMode }) {
  const d = project.design;
  const view = d.views[viewKey];
  const plane = VIEW_PLANE[viewKey];
  const lim = boxLimits(project);
  const [perEdge, setPerEdge] = useState(2);
  const members = model.members.filter((m) => m.plane === plane && d.members.some((x) => x.id === m.id));
  const tooBig = members.filter((m) => !m.box.fits);
  const contacts = model.contacts.filter((c) => c.plane === plane);
  const unbolted = contacts.filter((c) => c.bolts === 0);
  const bolts = model.bolts.filter((b) => b.plane === plane);
  const orphans = bolts.filter((b) => !b.jointId);
  const bearings = members.filter((m) => m.bearing).length;

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
      ${step(2, !!view.scaled, 'Set the scale', view.scaled ? 'Done. Redo it any time.' : isTop ? 'Click truss A at the west and east footing supports.' : `Click the west and east footing supports; they're placed ${ftIn(footingPoints(project).span)} apart.`, 'calibrate')}
      ${step(3, members.length > 0 && !tooBig.length, isTop ? 'Place lateral boxes' : 'Place member boxes',
        html`${members.length} member${members.length === 1 ? '' : 's'}. Each box is one welded member that fits ${lim.len} × ${lim.depth} × ${lim.thick} in. Draw, move, push/pull edges and drag corners all in this one tool.${tooBig.length ? html` <b class="bad">${tooBig.length} too big.</b>` : ''}`, 'box')}
      ${step(4, contacts.length > 0 && !unbolted.length && !orphans.length, 'Place the bolts',
        html`${contacts.length} place${contacts.length === 1 ? '' : 's'} where boxes touch, ${bolts.length} bolts.${unbolted.length ? html` <b class="bad">${unbolted.length} touching with no bolt.</b>` : ''}${orphans.length ? html` <b class="bad">${orphans.length} bolt${orphans.length === 1 ? '' : 's'} off a connection.</b>` : ''}`, 'bolt',
        html`<div class="row autofill"><span class="muted">Auto-fill</span>
          <input type="number" min="1" max="6" step="1" value=${perEdge} onInput=${(e) => setPerEdge(Math.max(1, parseInt(e.target.value) || 1))} />
          <span class="muted">per unbolted connection</span>
          <button class="small" disabled=${!unbolted.length} onClick=${() => updateProject((p) => { autoBolts(p, model, plane, perEdge); })}>Fill</button></div>`)}
      ${!isTop && step(5, bearings >= 2, 'Check footing supports', `${bearings} member${bearings === 1 ? '' : 's'} stand on a footing (found automatically when a box's bottom sits on one; click to change).`, 'bearing')}
    </ol>
    ${viewKey === 'sideA' && d.mirrorB && html`<${Hint}>Truss B is copied from this view as a mirror image. If your trusses differ, untick "Truss B mirrors truss A" in Bridge settings below and mark up a second side view.<//>`}
    ${isTop && html`<${Hint}>The trusses show up here automatically from the side view. Place only the laterals: pick their height, then drag each lateral from truss A to truss B so its ends snap against the trusses.<//>`}
  <//>`;
}

function BridgeSettings({ project, model, open }) {
  const d = project.design;
  const lim = boxLimits(project);
  const set = (fn, key) => updateProject((p) => fn(p.design), { key });
  return html`<${Section} title="Bridge settings" open=${open}>
    <${Check} label="Truss B mirrors truss A" checked=${d.mirrorB} title="When on, truss B is generated from truss A"
      onChange=${(v) => {
        if (v) {
          if (d.members.some((m) => m.plane === 'B') && !confirm('Replace your truss B markup with a mirror copy of truss A?')) return;
          updateProject((p) => enableMirror(p));
        } else updateProject((p) => materializeMirror(p, model));
      }} />
    <${NumField} label=${'Footing supports apart (' + ftIn(footingPoints(project).span) + ')'} unit="in" value=${footingPoints(project).span} min=${12}
      title="Distance between where the bridge stands on the two footings. Clicking the footings on a screenshot places them this far apart."
      onChange=${(v) => set((x) => { x.footingSpan = v; }, 'span')} />
    <${NumField} label="Truss spacing" unit="in" value=${d.trussSpacing} min=${1} title="Center-to-center distance between truss A and truss B"
      onChange=${(v) => set((x) => { x.trussSpacing = v; }, 'spacing')} />
    <${NumField} label="Default weight" unit="lb/ft" value=${d.lbPerFt} min=${0} onChange=${(v) => set((x) => { x.lbPerFt = v; }, 'lb')} />
    <${NumField} label="Bolts for a rigid connection" value=${d.rigidBoltCount} min=${1} step="1"
      title="A connection with at least this many bolts resists rotation, so it can cantilever"
      onChange=${(v) => set((x) => { x.rigidBoltCount = Math.round(v); }, 'rigid')} />
    <${Hint}>Member size box: ${lim.len} × ${lim.depth} × ${lim.thick} in (from this year's rules, set in the Site tab).<//>
  <//>`;
}

function SelectionPanel({ project, model, sel, setSel }) {
  const d = project.design;
  const lim = boxLimits(project);
  if (sel.type === 'member') {
    const m = model.memberById.get(sel.id);
    const raw = d.members.find((x) => x.id === sel.id);
    if (!m) return null;
    const joints = model.contacts.filter((c) => c.a === m.id || c.b === m.id);
    const nBolts = joints.reduce((s, c) => s + c.bolts, 0);
    const info = html`<table class="kv">
      <tr><td>Size</td><td class=${m.box.fits ? 'ok' : 'bad'}>${m.len.toFixed(2)} × ${m.depth.toFixed(2)} × ${m.thick.toFixed(2)} in ${m.box.fits ? '✔' : '✘ too big'}</td></tr>
      <tr><td>Weight</td><td>${m.weight.toFixed(2)} lb</td></tr>
      <tr><td>Touches</td><td>${joints.length ? joints.map((c) => html`<div class=${c.bolts ? '' : 'bad'}>${jointLabel(model, c).replace(m.name + ' ↔ ', '').replace(' ↔ ' + m.name, '')} · ${c.bolts} bolt${c.bolts === 1 ? '' : 's'}</div>`) : 'nothing yet'}</td></tr>
    </table>`;
    if (!raw) return html`<${Section} title=${'Member · ' + m.name}>${info}<${Hint}>Mirror copy of ${m.mirrorOf ? model.memberById.get(m.mirrorOf)?.name : 'a truss A member'}. Edit that one instead.<//><//>`;
    const set = (patch) => updateProject((p) => { const x = p.design.members.find((q) => q.id === sel.id); Object.assign(x, patch); if (!x.corners) clampBox(p, x); }, { key: 'mem' + sel.id + Object.keys(patch)[0] });
    return html`<${Section} title=${'Member · ' + m.name}>
      <${TextField} label="Name" value=${raw.name} onChange=${(v) => set({ name: v })} />
      ${info}
      ${raw.corners ? html`
        <${Hint}>Reshaped by its corners: ${m.len.toFixed(2)} × ${m.depth.toFixed(2)} in overall.<//>
        <button onClick=${() => updateProject((p) => squareUp(p, p.design.members.find((q) => q.id === sel.id)))}>Make rectangular again</button>`
      : html`
        <${NumField} label=${'Length (max ' + lim.len + ')'} unit="in" value=${raw.len} min=${0.5} onChange=${(v) => set({ len: v })} />
        <${NumField} label=${'Depth (max ' + lim.depth + ')'} unit="in" value=${raw.depth} min=${0.25} onChange=${(v) => set({ depth: v })} />
        <${NumField} label="Angle" unit="°" value=${raw.angle} onChange=${(v) => set({ angle: v })} />
        <div class="row2">
          <${NumField} label="Center x" unit="in" value=${raw.u} onChange=${(v) => set({ u: v })} />
          <${NumField} label=${raw.plane === 'L' ? 'Center y' : 'Center z'} unit="in" value=${raw.v} onChange=${(v) => set({ v })} />
        </div>`}
      <${NumField} label=${'Thickness (max ' + lim.thick + ')'} unit="in" value=${raw.thick} min=${0.125} title="Size out of the view" onChange=${(v) => set({ thick: Math.min(lim.thick, v) })} />
      ${raw.plane === 'L' && html`<${NumField} label="Height (z)" unit="in" value=${raw.z} onChange=${(v) => set({ z: v })} />`}
      ${raw.plane !== 'L' && html`<div class="row"><${Check} label=${'Stands on a footing' + (m.autoBearing ? ' (automatic)' : '')} checked=${m.bearing} onChange=${(v) => set({ bearing: v })} />
        ${!m.autoBearing && html`<button class="small" onClick=${() => updateProject((p) => { delete p.design.members.find((q) => q.id === sel.id).bearing; })}>Detect automatically</button>`}</div>`}
      <${NumField} label="Weight" unit="lb/ft" value=${raw.lbPerFt ?? d.lbPerFt} min=${0} onChange=${(v) => set({ lbPerFt: v })} />
      <label class="field"><span class="lbl">Color</span><span class="inp"><input type="color" value=${raw.color || PLANE_COLORS[raw.plane]} onInput=${(e) => set({ color: e.target.value })} /></span></label>
      <div class="row">
        <button onClick=${() => { let id; updateProject((p) => { id = duplicateMember(p, sel.id, 0, raw.depth); }); setSel({ type: 'member', id }); }}>Copy box</button>
        <button onClick=${() => updateProject((p) => { p.design.bolts = p.design.bolts.filter((b) => !boltMembers(b).includes(sel.id)); })}>Remove its bolts</button>
        <button class="danger" onClick=${() => { updateProject((p) => removeMember(p, sel.id)); setSel(null); }}>Delete</button>
      </div>
    <//>`;
  }
  if (sel.type === 'bolt') {
    const b = model.bolts.find((x) => x.id === sel.id);
    if (!b) return null;
    const names = b.memberIds.map((id) => model.memberById.get(id)?.name || '?');
    const raw = d.bolts.find((x) => x.id === sel.id);
    const joints = b.jointIds.map((id) => model.contacts.find((c) => c.id === id)).filter(Boolean);
    return html`<${Section} title="Bolt">
      <${Hint}>Through ${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}${b.jointId ? '' : html` · <b class="bad">no longer on a place where they touch</b>`}.<//>
      ${b.memberIds.length > 2 && html`<${SelectField} label="Put in" value=${b.when && b.when !== 'first' ? (b.when === 'all' ? 'all' : String(b.when).replace(/~B$/, '')) : 'first'}
        title="When this bolt goes through the stack during the build"
        options=${[['first', 'As soon as two of them are joined'], ['all', `Once all ${names.length} are in place`],
          ...b.memberIds.filter((id) => raw ? true : !id.endsWith('~B')).map((id) => [raw ? id : id.replace(/~B$/, ''), 'When ' + (model.memberById.get(id)?.name || '?') + ' is placed'])]}
        onChange=${(v) => updateProject((p) => { const x = p.design.bolts.find((q) => q.id === (raw ? sel.id : sel.id.replace(/~B$/, ''))); if (!x) return; if (v === 'first') delete x.when; else x.when = v; })} />
        <${Hint}>Until it goes in, the members it joins aren't held by it, so someone may have to keep holding them.<//>`}
      ${joints.map((c) => html`<${ConnTimes} key=${c.id} project=${project} model=${model} joint=${c} />`)}
      ${d.bolts.some((x) => x.id === sel.id)
        ? html`<button class="danger" onClick=${() => { updateProject((p) => removeBolt(p, sel.id)); setSel(null); }}>Delete bolt</button>`
        : html`<${Hint}>Mirror copy. Delete the truss A bolt instead.<//>`}
    <//>`;
  }
  return null;
}

// Time overrides for one connection (empty = the default for where it's made).
function setConnTime(joint, field, v) {
  updateProject((p) => {
    const all = (p.design.connections = p.design.connections || {});
    const t = { ...(all[joint.timeKey] || {}) };
    if (v == null) delete t[field]; else t[field] = v;
    if (Object.keys(t).length) all[joint.timeKey] = t; else delete all[joint.timeKey];
  }, { key: 'ct' + joint.timeKey + field });
}

function defaultTimes(project) {
  const T = project.timing;
  const tool = project.tools.filter((t) => t.kind === 'fastener').map((t) => t.boltTime);
  const bridgeBolt = tool.length ? Math.min(...tool) : T.boltTimeHand;
  return {
    align: `${T.alignTime} s in the bridge, ${T.assemblyAlignTime > 0 ? T.assemblyAlignTime : T.alignTime} s in the staging yard`,
    bolt: `${bridgeBolt} s with the tool in the bridge, ${T.assemblyBoltTime > 0 ? T.assemblyBoltTime : bridgeBolt} s in the staging yard`,
  };
}

function ConnTimes({ project, model, joint }) {
  const def = defaultTimes(project);
  return html`<div class="conn-times">
    <div class="muted small">${jointLabel(model, joint)} · ${joint.bolts} bolt${joint.bolts === 1 ? '' : 's'}</div>
    <div class="row2">
      <${NumField} label="Align" unit="s" optional placeholder="default" min=${0} value=${joint.alignTime} title=${'Empty = default (' + def.align + ')'} onChange=${(v) => setConnTime(joint, 'alignTime', v)} />
      <${NumField} label="Per bolt" unit="s" optional placeholder="default" min=${0} value=${joint.boltTime} title=${'Empty = default (' + def.bolt + ')'} onChange=${(v) => setConnTime(joint, 'boltTime', v)} />
    </div>
  </div>`;
}

// Every connection, with its own align and per-bolt times where the defaults don't fit.
function ConnectionTable({ project, model }) {
  const [filter, setFilter] = useState('');
  const d = project.design;
  const def = defaultTimes(project);
  const list = model.contacts
    .filter((c) => !(d.mirrorB && c.plane === 'B' && c.timeKey !== c.id))
    .filter((c) => jointLabel(model, c).toLowerCase().includes(filter.toLowerCase()));
  const custom = list.filter((c) => c.alignTime != null || c.boltTime != null).length;
  const [picked, setPicked] = useState(null);
  return html`<div class="split">
    <div class="table-wrap">
      <div class="row"><input type="search" placeholder="Filter connections" value=${filter} onInput=${(e) => setFilter(e.target.value)} />
        <span class="muted">${list.length} connections · ${custom} with their own times</span>
        ${custom > 0 && html`<button class="small" onClick=${() => updateProject((p) => { p.design.connections = {}; })}>Clear all overrides</button>`}</div>
      <${Hint}>Leave a time empty to use the default: align ${def.align}; per bolt ${def.bolt} (set in Crew → Timing and Tools). A time typed here is used for that connection wherever it's made.${d.mirrorB ? ' Truss B copies use the truss A times.' : ''}<//>
      <table class="grid">
        <thead><tr><th>Connection</th><th>View</th><th>Bolts</th><th>Align (s)</th><th>Per bolt (s)</th></tr></thead>
        <tbody>${list.map((c) => html`<tr class=${picked === c.id ? 'sel' : ''} onClick=${() => setPicked(c.id)}>
          <td>${jointLabel(model, c)}</td><td>${c.plane === 'L' ? 'Top' : 'Truss ' + c.plane}</td><td class=${c.bolts ? '' : 'bad'}>${c.bolts}</td>
          <td><input type="number" class="tiny" min="0" step="any" placeholder="default" value=${c.alignTime ?? ''} onInput=${(e) => { const v = e.target.value.trim(); setConnTime(c, 'alignTime', v === '' ? null : Math.max(0, parseFloat(v) || 0)); }} /></td>
          <td><input type="number" class="tiny" min="0" step="any" placeholder="default" value=${c.boltTime ?? ''} onInput=${(e) => { const v = e.target.value.trim(); setConnTime(c, 'boltTime', v === '' ? null : Math.max(0, parseFloat(v) || 0)); }} /></td>
        </tr>`)}</tbody>
      </table>
    </div>
    <${IsoView} model=${model} styleOf=${(m) => { const c = picked && model.contacts.find((x) => x.id === picked); return c ? (m.id === c.a || m.id === c.b ? { color: '#f59e0b' } : { opacity: 0.35 }) : null; }} />
  </div>`;
}

function MemberTable({ project, model, sel, setSel }) {
  const [filter, setFilter] = useState('');
  const list = model.members.filter((m) => m.name.toLowerCase().includes(filter.toLowerCase()));
  const totalW = model.members.reduce((a, m) => a + m.weight, 0);
  const selected = sel && sel.type === 'member' ? sel.id : null;
  return html`<div class="split">
    <div class="table-wrap">
      <div class="row"><input type="search" placeholder="Filter members" value=${filter} onInput=${(e) => setFilter(e.target.value)} />
        <span class="muted">${model.members.length} members · ${model.bolts.length} bolts · ${model.contacts.length} connections · ${totalW.toFixed(1)} lb</span></div>
      <table class="grid">
        <thead><tr><th>Name</th><th>Where</th><th>Size (in)</th><th>Fits box</th><th>Connections</th><th>Bolts</th><th>lb</th></tr></thead>
        <tbody>${list.map((m) => {
          const js = model.contacts.filter((c) => c.a === m.id || c.b === m.id);
          return html`<tr class=${selected === m.id ? 'sel' : ''} onClick=${() => setSel({ type: 'member', id: m.id })}>
          <td>${m.name}${m.bearing ? ' ▲' : ''}</td><td>${m.plane === 'L' ? 'Lateral' : 'Truss ' + m.plane}</td>
          <td>${m.len.toFixed(1)} × ${m.depth.toFixed(1)} × ${m.thick.toFixed(1)}</td><td class=${m.box.fits ? 'ok' : 'bad'}>${m.box.fits ? '✔' : '✘'}</td>
          <td class=${js.some((c) => !c.bolts) ? 'bad' : ''}>${js.length}</td><td>${js.reduce((s, c) => s + c.bolts, 0)}</td><td>${m.weight.toFixed(1)}</td></tr>`;
        })}</tbody>
      </table>
    </div>
    <${IsoView} model=${model} onPick=${(m) => setSel({ type: 'member', id: m.id })}
      styleOf=${(m) => (m.id === selected ? { color: '#f59e0b' } : !m.box.fits ? { color: '#dc2626' } : null)} />
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
      ${!refs.length && html`<${Hint}>No isometric screenshots yet. These are for reference: if the 3D view on the right doesn't match your CAD model, a box is placed wrong.<//>`}
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
