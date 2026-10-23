// Site tab: lay out the staging yard, construction zone, assembly areas and no-go zones, place
// the bridge, and say where builders, tools, nuts & bolts and members start.
import { html, useEffect, useState } from '../lib/preact.js';
import { updateProject } from '../model/store.js';
import { uid } from '../model/ids.js';
import { ZONE_TYPES, normalizeSite } from '../model/schema.js';
import { stagingSpots } from '../model/plan.js';
import { deleteMySite, downloadJSON, fetchLibrarySite, fetchSiteLibrary, mySites, pickFile, readJSONFile, safeFilename, saveMySite, siteForSharing } from '../model/storage.js';
import { PlanView } from './PlanView.js';
import { Hint, NumField, Section, SelectField, TextField } from './common.js';

export function SiteTab({ project, model }) {
  const [sel, setSel] = useState(null);
  const site = project.site;
  const spots = stagingSpots(project, model);
  const yard = site.zones.find((z) => z.type === 'staging');
  const overflow = yard ? [...spots.values()].filter((s) => s.auto && s.y > yard.y + yard.h).length : 0;

  const addZone = (type) => {
    const id = uid('z');
    updateProject((p) => {
      p.site.zones.push({ id, name: ZONE_TYPES[type].label, type, x: Math.round(p.site.width / 2 - 60), y: Math.round(p.site.depth / 2 - 40), w: 120, h: 80 });
    });
    setSel({ type: 'zone', id });
  };

  return html`<div class="tab-layout">
    <div class="main">
      <div class="toolbar">
        <span class="muted">Add zone:</span>
        ${Object.entries(ZONE_TYPES).map(([t, z]) => html`<button onClick=${() => addZone(t)}><span class="dot" style=${{ background: z.color }}></span>${z.label}</button>`)}
        <span class="sep"></span>
        <button onClick=${() => updateProject((p) => { p.site.staging = {}; })} title="Forget dragged positions and lay members out in rows in the staging yard">Re-stack members</button>
      </div>
      <${PlanView} project=${project} model=${model} spots=${spots} sel=${sel} setSel=${setSel} editable=${true} />
      <div class="hint-bar">Drag zones, corners, the bridge, builders, tools, nuts & bolts and members to place them. Scroll to zoom, drag empty space to pan.
        ${overflow > 0 && html` <b class="bad">${overflow} member${overflow === 1 ? " doesn't" : "s don't"} fit in the staging yard; make it bigger or drag ${overflow === 1 ? 'it' : 'them'}.</b>`}</div>
    </div>
    <aside class="side">
      ${sel && html`<${SelectedPanel} project=${project} sel=${sel} setSel=${setSel} />`}
      <${Section} title="Site">
        <${TextField} label="Layout name" value=${site.name} onChange=${(v) => updateProject((p) => { p.site.name = v; }, { key: 'sname' })} />
        <${TextField} label="Competition year" value=${site.year} onChange=${(v) => updateProject((p) => { p.site.year = v; }, { key: 'syear' })} />
        <${NumField} label="Width (x)" unit="in" value=${site.width} min=${24} onChange=${(v) => updateProject((p) => { p.site.width = v; }, { key: 'sw' })} />
        <${NumField} label="Depth (y)" unit="in" value=${site.depth} min=${24} onChange=${(v) => updateProject((p) => { p.site.depth = v; }, { key: 'sd' })} />
        <${NumField} label="Bridge rotation" unit="°" value=${site.bridge.rotation} onChange=${(v) => updateProject((p) => { p.site.bridge.rotation = v; }, { key: 'srot' })} />
        <${NumField} label="Path grid" unit="in" value=${site.cell} min=${2} title="Smaller is more precise around zone edges but slower" onChange=${(v) => updateProject((p) => { p.site.cell = v; }, { key: 'scell' })} />
        <label class="field col"><span class="lbl">Notes</span><textarea rows="2" value=${site.notes} onInput=${(e) => updateProject((p) => { p.site.notes = e.target.value; }, { key: 'snotes' })}></textarea></label>
      <//>
      <${Section} title=${`Zones (${site.zones.length})`}>
        ${!site.zones.length && html`<${Hint}>No zones yet. Add the staging yard, construction zone, assembly areas and the river (no-go).<//>`}
        <ul class="list">${site.zones.map((z) => html`<li class=${sel && sel.id === z.id ? 'sel' : ''} onClick=${() => setSel({ type: 'zone', id: z.id })}>
          <span class="dot" style=${{ background: ZONE_TYPES[z.type]?.color }}></span>${z.name}<span class="muted"> ${Math.round(z.w)}×${Math.round(z.h)} in</span></li>`)}</ul>
        <${Hint}>Builders who aren't restricted can walk anywhere in the site except no-go zones. Restrict builders to zones in the Crew tab.<//>
      <//>
      <${SiteLibrary} project=${project} />
    </aside>
  </div>`;
}

function SelectedPanel({ project, sel, setSel }) {
  const site = project.site;
  if (sel.type === 'zone') {
    const z = site.zones.find((x) => x.id === sel.id);
    if (!z) return null;
    const set = (fn) => updateProject((p) => fn(p.site.zones.find((x) => x.id === sel.id)), { key: 'zone' + sel.id });
    return html`<${Section} title="Zone">
      <${TextField} label="Name" value=${z.name} onChange=${(v) => set((x) => { x.name = v; })} />
      <${SelectField} label="Type" value=${z.type} options=${Object.entries(ZONE_TYPES).map(([k, v]) => [k, v.label])} onChange=${(v) => set((x) => { x.type = v; })} />
      <div class="row2">
        <${NumField} label="x" unit="in" value=${z.x} onChange=${(v) => set((x) => { x.x = v; })} />
        <${NumField} label="y" unit="in" value=${z.y} onChange=${(v) => set((x) => { x.y = v; })} />
        <${NumField} label="Width" unit="in" value=${z.w} min=${1} onChange=${(v) => set((x) => { x.w = v; })} />
        <${NumField} label="Depth" unit="in" value=${z.h} min=${1} onChange=${(v) => set((x) => { x.h = v; })} />
      </div>
      <button class="danger" onClick=${() => { updateProject((p) => { p.site.zones = p.site.zones.filter((x) => x.id !== sel.id); }); setSel(null); }}>Delete zone</button>
    <//>`;
  }
  const pointEditor = (title, pt, setPt, extra) => html`<${Section} title=${title}>
    <div class="row2">
      <${NumField} label="x" unit="in" value=${pt.x} onChange=${(v) => setPt({ ...pt, x: v })} />
      <${NumField} label="y" unit="in" value=${pt.y} onChange=${(v) => setPt({ ...pt, y: v })} />
    </div>${extra}<//>`;
  if (sel.type === 'builder') {
    const b = project.builders.find((x) => x.id === sel.id);
    return b && pointEditor(b.name + ' starts at', b.start, (pt) => updateProject((p) => { p.builders.find((x) => x.id === sel.id).start = pt; }, { key: 'bs' + sel.id }), html`<${Hint}>Roles, zones and tools are set in the Crew tab.<//>`);
  }
  if (sel.type === 'tool') {
    const t = project.tools.find((x) => x.id === sel.id);
    return t && pointEditor(t.name + ' starts at', t.start, (pt) => updateProject((p) => { p.tools.find((x) => x.id === sel.id).start = pt; }, { key: 'ts' + sel.id }));
  }
  if (sel.type === 'hardware') return pointEditor('Nuts & bolts start at', site.hardware, (pt) => updateProject((p) => { p.site.hardware = pt; }, { key: 'hw' }));
  if (sel.type === 'bridge') return pointEditor('Bridge origin (x = 0, truss A)', site.bridge, (pt) => updateProject((p) => { p.site.bridge = { ...p.site.bridge, x: pt.x, y: pt.y }; }, { key: 'br' }));
  if (sel.type === 'piece') {
    const spot = project.site.staging[sel.id];
    return html`<${Section} title="Member in staging">
      <${Hint}>${spot ? 'Dragged to a fixed spot.' : 'Placed automatically.'}<//>
      ${spot && html`<button onClick=${() => { updateProject((p) => { delete p.site.staging[sel.id]; }); setSel(null); }}>Put back in the automatic rows</button>`}
    <//>`;
  }
  return null;
}

function SiteLibrary({ project }) {
  const [shared, setShared] = useState(null);
  const [err, setErr] = useState(null);
  const [mine, setMine] = useState(mySites());
  useEffect(() => {
    fetchSiteLibrary().then(setShared).catch((e) => setErr(e.message));
  }, []);

  const apply = (site) => {
    if (!confirm(`Replace the current site layout with "${site.name}"? Builders, tools and members keep their start points.`)) return;
    updateProject((p) => {
      const keepStaging = p.site.staging;
      p.site = { ...normalizeSite(site), staging: keepStaging };
      delete p.site.kind;
      delete p.site.savedAt;
      // Builder zone restrictions refer to zone ids; keep the ones that still exist.
      const ids = new Set(p.site.zones.map((z) => z.id));
      for (const b of p.builders) if (b.allowedZones) b.allowedZones = b.allowedZones.filter((id) => ids.has(id));
    });
  };

  const importFile = async () => {
    const f = await pickFile('.json,application/json');
    if (!f) return;
    try {
      const data = await readJSONFile(f);
      apply(data.site && !data.zones ? data.site : data);
    } catch (e) {
      alert('Could not read that file: ' + e.message);
    }
  };

  return html`<${Section} title="Save & share layouts">
    <${Hint}>Layouts carry over from project to project and year to year. Saving to this browser keeps a copy just for you. To share a layout with everyone, download it and add it to the repo's library (see README).<//>
    <div class="row wrap">
      <button onClick=${() => { saveMySite(project.site); setMine(mySites()); }}>Save to this browser</button>
      <button onClick=${() => downloadJSON(siteForSharing(project.site), safeFilename(project.site.name, '.site.json'))}>Download file</button>
      <button onClick=${importFile}>Load file…</button>
    </div>
    <h4>Shared library</h4>
    ${err && html`<${Hint}>${err}. (When you open index.html straight from disk the library can't load; use a local server or the GitHub Pages link.)<//>`}
    ${shared && !shared.length && html`<${Hint}>The library is empty.<//>`}
    <ul class="list">${(shared || []).map((s) => html`<li>
      <span><b>${s.name}</b> <span class="muted">${s.year || ''} ${s.description || ''}</span></span>
      <span class="spacer"></span><button class="small" onClick=${async () => { try { apply(await fetchLibrarySite(s.file)); } catch (e) { alert(e.message); } }}>Use</button></li>`)}</ul>
    <h4>Saved in this browser</h4>
    ${!mine.length && html`<${Hint}>Nothing saved yet.<//>`}
    <ul class="list">${mine.map((s) => html`<li>
      <span><b>${s.name}</b> <span class="muted">${s.year || ''}</span></span><span class="spacer"></span>
      <button class="small" onClick=${() => apply(s)}>Use</button>
      <button class="small danger" onClick=${() => { deleteMySite(s.name); setMine(mySites()); }}>✕</button></li>`)}</ul>
  <//>`;
}
