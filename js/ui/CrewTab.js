// Crew tab: builders (side of the river, allowed zones, what they grab at the start) and timing assumptions.
import { html } from '../lib/preact.js';
import { updateProject } from '../model/store.js';
import { uid } from '../model/ids.js';
import { DEFAULT_COLORS, DEFAULT_TIMING, ZONE_TYPES } from '../model/schema.js';
import { sideOf } from '../model/plan.js';
import { Check, Hint, NumField, Section, SelectField, TextField } from './common.js';

const TIMING_FIELDS = [
  ['walkSpeed', 'Walking speed', 'in/s', 'Empty-handed (54 in/s = 4.5 ft/s)'],
  ['carrySpeed', 'Carrying speed', 'in/s', 'While carrying a member or assembly'],
  ['pickupTime', 'Pick up, set down or hand off a piece', 's', ''],
  ['alignTime', 'Align one bolted connection', 's', 'Line up holes before the bolt goes in'],
  ['boltTimeHand', 'Fasten a nut by hand', 's', 'Used when the builder has no fastening tool'],
  ['insertTime', 'Place a bolt', 's', 'Push a bolt through a member. Fastening its nut is a separate step.'],
  ['assemblyAlignTime', 'Align a connection in the staging yard', 's', 'When making assemblies. 0 = same as above'],
  ['assemblyBoltTime', 'Fasten a nut in the staging yard', 's', "When making assemblies. 0 = the fastening tool's time"],
  ['stagedAlignTime', 'Align when staged touching', 's', 'Assembly connections whose members are placed touching in the Staging tab'],
  ['stagedBoltTime', 'Fasten a nut when staged touching', 's', '0 = the staging-yard bolt time'],
  ['gearUpTime', 'Grab one tool / the nuts & bolts', 's', 'At the start, after the clock begins'],
  ['soloMultiplier', 'Slowdown when multitasking', '×', 'A step done at the same time as another, like fastening a nut while supporting the bridge'],
  ['maxReach', 'Reach', 'in', 'How far a builder can reach from where they stand (e.g. over the river)'],
  ['passReach', 'Hand-off distance', 'in', 'How far apart two builders can stand and still pass a piece, e.g. across the river'],
];

// Move a builder's start to the builders area on that side of the river.
function moveToSide(site, b, side) {
  const inSide = (z) => sideOf(site, { x: z.x + z.w / 2, y: z.y + z.h / 2 }) === side;
  const area = site.zones.find((z) => z.type === 'builders' && inSide(z)) || site.zones.find((z) => ZONE_TYPES[z.type]?.stage && !ZONE_TYPES[z.type]?.sub && inSide(z));
  if (area) b.start = { x: Math.round(area.x + area.w / 2), y: Math.round(area.y + area.h / 2) };
}

export function CrewTab({ project }) {
  const T = project.timing;
  const zones = project.site.zones;
  const setB = (id, fn) => updateProject((p) => fn(p.builders.find((b) => b.id === id)), { key: 'b' + id });
  const max = project.site.rules?.maxBuilders;
  const add = () => updateProject((p) => {
    const n = p.builders.length;
    // Alternate between builders areas (e.g. west and east of the river).
    const areas = p.site.zones.filter((z) => z.type === 'builders');
    const area = areas.length ? areas[n % areas.length] : p.site.zones.find((z) => z.type === 'staging');
    const k = areas.length ? Math.floor(n / areas.length) : n;
    const start = area ? { x: Math.round(area.x + area.w / 2), y: Math.round(area.y + 15 + ((k * 22) % Math.max(22, area.h - 25))) } : { x: 20 + n * 25, y: 20 };
    p.builders.push({ id: uid('w'), name: 'Builder ' + (n + 1), color: DEFAULT_COLORS[n % DEFAULT_COLORS.length], start, allowedZones: null, loadout: [], hardware: true });
  });
  const remove = (id) => updateProject((p) => {
    p.builders = p.builders.filter((b) => b.id !== id);
    for (const pl of p.plans) if (pl.tasks) pl.tasks = pl.tasks.filter((t) => t.builder !== id && t.to !== id);
  });

  return html`<div class="page two-col">
    <div data-tour="crew">
      <div class="row"><button class="primary" onClick=${add} disabled=${max && project.builders.length >= max} title=${max ? `The rules allow at most ${max} builders` : ''}>+ Builder</button>
        <span class=${max && project.builders.length > max ? 'bad' : 'muted'}>${project.builders.length} builder${project.builders.length === 1 ? '' : 's'}${max ? ` (at most ${max} allowed)` : ''}. Start points are dragged in the Site tab; which side of the river a builder starts on is the side they work from.</span></div>
      <div class="cards">
        ${project.builders.map((b, i) => html`<div class="card" key=${b.id}>
          <div class="card-head">
            <input type="color" value=${b.color} onInput=${(e) => setB(b.id, (x) => { x.color = e.target.value; })} title="Color" />
            <span class="num">${i + 1}</span>
            <${TextField} label="Name" value=${b.name} onChange=${(v) => setB(b.id, (x) => { x.name = v; })} />
            <button class="danger small" onClick=${() => remove(b.id)}>Delete</button>
          </div>
          ${sideOf(project.site, b.start) && html`<${SelectField} label="Side of the river" value=${sideOf(project.site, b.start)} options=${[['west', 'West'], ['east', 'East']]}
            title="Builders can't cross the river, so this is the side they work from. Changing it moves their start to that side's builders area (or drag it in the Site tab)."
            onChange=${(v) => setB(b.id, (x) => { moveToSide(project.site, x, v); })} />`}
          <div class="field col"><span class="lbl">May be in</span>
            <div class="chips">
              <${Check} label="Anywhere (except no-go)" checked=${!b.allowedZones} onChange=${(v) => setB(b.id, (x) => { x.allowedZones = v ? null : zones.filter((z) => z.type !== 'nogo').map((z) => z.id); })} />
              ${b.allowedZones && zones.filter((z) => z.type !== 'nogo').map((z) => html`<${Check} label=${html`<span class="dot" style=${{ background: ZONE_TYPES[z.type]?.color }}></span>${z.name}`}
                checked=${b.allowedZones.includes(z.id)}
                onChange=${(v) => setB(b.id, (x) => { x.allowedZones = v ? [...x.allowedZones, z.id] : x.allowedZones.filter((id) => id !== z.id); })} />`)}
            </div>
          </div>
          <div class="field col"><span class="lbl">Grabs at the start</span>
            <div class="chips">
              <${Check} label="Nuts & bolts" checked=${b.hardware} onChange=${(v) => setB(b.id, (x) => { x.hardware = v; })} />
              ${b.hardware && html`<${NumField} label="Bolts carried" optional placeholder="as needed" min=${0} step="1" value=${b.boltCount ?? null}
                title="How many bolts they take at the start. Leave empty for as many as they need. The Simulate tab shows this counting down."
                onChange=${(v) => setB(b.id, (x) => { x.boltCount = v == null ? null : Math.round(v); })} />`}
              ${project.tools.map((t) => html`<${Check} label=${t.name} checked=${b.loadout.includes(t.id)}
                onChange=${(v) => setB(b.id, (x) => { x.loadout = v ? [...x.loadout, t.id] : x.loadout.filter((id) => id !== t.id); })} />`)}
            </div>
          </div>
        </div>`)}
      </div>
    </div>
    <div data-tour="timing">
      <${Section} title="Timing">
        ${TIMING_FIELDS.map(([k, label, unit, title]) => html`<${NumField} label=${label} unit=${unit} title=${title} value=${T[k]} min=${0}
          onChange=${(v) => updateProject((p) => { p.timing[k] = v; }, { key: 't' + k })} />`)}
        <button onClick=${() => updateProject((p) => { p.timing = { ...DEFAULT_TIMING }; })}>Reset to defaults</button>
      <//>
      <${Hint}>Who does what is set step by step in the Build sequence tab. Construction cost counts every builder for the whole build, so more builders only pay off if they cut the time enough (6.2.5).<//>
    </div>
  </div>`;
}
