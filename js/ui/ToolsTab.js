// Tools tab: fastening tools, temporary supports and anything else builders can use.
import { html } from '../lib/preact.js';
import { updateProject } from '../model/store.js';
import { uid } from '../model/ids.js';
import { TOOL_KINDS } from '../model/schema.js';
import { Hint, NumField, Section, SelectField, TextField } from './common.js';

export function ToolsTab({ project }) {
  const tools = project.tools;
  const set = (id, fn) => updateProject((p) => fn(p.tools.find((t) => t.id === id)), { key: 'tool' + id });
  const add = (kind) => updateProject((p) => {
    const presets = {
      fastener: { name: 'Impact driver', boltTime: 4 },
      support: { name: 'Jack stand', placeTime: 6, removeTime: 5 },
      other: { name: 'New tool' },
    };
    // New tools start in the first tools area (drag them elsewhere in the Site tab).
    const area = p.site.zones.find((z) => z.type === 'tools') || p.site.zones.find((z) => z.type === 'staging') || { x: 0, y: 0, w: 60, h: 60 };
    const n = p.tools.length;
    const start = { x: Math.round(area.x + 10 + ((n * 14) % Math.max(14, area.w - 20))), y: Math.round(area.y + 12 + Math.floor((n * 14) / Math.max(14, area.w - 20)) * 14) };
    p.tools.push({ id: uid('t'), kind, count: 1, boltTime: 4, placeTime: 6, removeTime: 5, start, notes: '', ...presets[kind] });
  });
  const remove = (id) => updateProject((p) => {
    p.tools = p.tools.filter((t) => t.id !== id);
    for (const b of p.builders) b.loadout = b.loadout.filter((t) => t !== id);
    for (const pl of p.plans) pl.steps = pl.steps.filter((s) => !(s.kind === 'support' && s.toolId === id));
  });

  return html`<div class="page" data-tour="tools">
    <div class="row">
      <button class="primary" onClick=${() => add('fastener')}>+ Fastening tool</button>
      <button class="primary" onClick=${() => add('support')}>+ Temporary support</button>
      <button onClick=${() => add('other')}>+ Other tool</button>
    </div>
    <${Hint}>Builders can carry any number of tools along with one member. Tools are picked up after the clock starts from their tools area (drag them in the Site tab), and builders can't cross the river to get one, so give each side of the river its own. Every tool must fit the ${(project.site.rules?.box || [42, 6, 4]).join(' × ')} in box (10.2.4) and be battery-powered or manual (10.2.3). Who grabs which tool is set in the Crew tab.<//>
    <div class="cards">
      ${tools.map((t) => html`<div class="card" key=${t.id}>
        <div class="card-head"><${TextField} label="Name" value=${t.name} onChange=${(v) => set(t.id, (x) => { x.name = v; })} />
          <button class="danger small" onClick=${() => remove(t.id)}>Delete</button></div>
        <${SelectField} label="Kind" value=${t.kind} options=${Object.entries(TOOL_KINDS)} onChange=${(v) => set(t.id, (x) => { x.kind = v; })} />
        <${NumField} label="How many" value=${t.count} min=${0} step="1" onChange=${(v) => set(t.id, (x) => { x.count = Math.round(v); })} />
        ${t.kind === 'fastener' && html`<${NumField} label="Time per bolt" unit="s" value=${t.boltTime} min=${0} title="Insert and tighten one bolt with this tool" onChange=${(v) => set(t.id, (x) => { x.boltTime = v; })} />`}
        ${t.kind === 'support' && html`
          <${NumField} label="Time to place" unit="s" value=${t.placeTime} min=${0} onChange=${(v) => set(t.id, (x) => { x.placeTime = v; })} />
          <${NumField} label="Time to remove" unit="s" value=${t.removeTime} min=${0} onChange=${(v) => set(t.id, (x) => { x.removeTime = v; })} />
          <${Hint}>A support under a joint counts as one fixed point, like a bearing. Add "place support" steps in the Sequence tab.<//>`}
        <label class="field col"><span class="lbl">Notes</span><textarea rows="2" value=${t.notes} onInput=${(e) => set(t.id, (x) => { x.notes = e.target.value; })}></textarea></label>
      </div>`)}
    </div>
    ${!tools.length && html`<${Section} title="No tools yet"><${Hint}>Without a fastening tool, bolts take the hand time set in the Crew tab.<//><//>`}
  </div>`;
}
