// Crew tab: builders (role, allowed zones, what they grab at the start) and timing assumptions.
import { html } from '../lib/preact.js';
import { updateProject } from '../model/store.js';
import { uid } from '../model/ids.js';
import { DEFAULT_COLORS, DEFAULT_TIMING, ROLES, ZONE_TYPES } from '../model/schema.js';
import { Check, Hint, NumField, Section, SelectField, TextField } from './common.js';

const TIMING_FIELDS = [
  ['walkSpeed', 'Walking speed', 'in/s', 'Empty-handed (54 in/s = 4.5 ft/s)'],
  ['carrySpeed', 'Carrying speed', 'in/s', 'While carrying a member or assembly'],
  ['pickupTime', 'Pick up / set down a piece', 's', ''],
  ['alignTime', 'Align one bolted joint', 's', 'Line up holes before the bolt goes in'],
  ['boltTimeHand', 'One bolt by hand', 's', 'Used when the fastener has no fastening tool'],
  ['assemblyJoinTime', 'Add a member to a ground assembly', 's', '0 = align time + bolt times'],
  ['gearUpTime', 'Grab one tool / the nuts & bolts', 's', 'At the start, after the clock begins'],
  ['soloMultiplier', 'Slowdown when fastening while holding', '×', 'A carrier fastening their own piece one-handed'],
  ['maxReach', 'Reach', 'in', 'How far a builder can reach from where they stand (e.g. over the river)'],
];

export function CrewTab({ project }) {
  const T = project.timing;
  const zones = project.site.zones;
  const setB = (id, fn) => updateProject((p) => fn(p.builders.find((b) => b.id === id)), { key: 'b' + id });
  const add = () => updateProject((p) => {
    const n = p.builders.length;
    const stage = p.site.zones.find((z) => z.type === 'staging');
    const start = stage ? { x: stage.x + 20 + (n % 5) * 25, y: stage.y + 20 } : { x: 20 + n * 25, y: 20 };
    p.builders.push({ id: uid('w'), name: 'Builder ' + (n + 1), color: DEFAULT_COLORS[n % DEFAULT_COLORS.length], role: 'any', start, allowedZones: null, loadout: [], hardware: true });
  });
  const remove = (id) => updateProject((p) => {
    p.builders = p.builders.filter((b) => b.id !== id);
    for (const pl of p.plans) for (const s of pl.steps) {
      for (const k of ['carrier', 'fastener', 'builder']) if (s[k] === id) s[k] = 'auto';
    }
  });

  return html`<div class="page two-col">
    <div data-tour="crew">
      <div class="row"><button class="primary" onClick=${add}>+ Builder</button>
        <span class="muted">${project.builders.length} builder${project.builders.length === 1 ? '' : 's'}. Start points are dragged in the Site tab.</span></div>
      <div class="cards">
        ${project.builders.map((b, i) => html`<div class="card" key=${b.id}>
          <div class="card-head">
            <input type="color" value=${b.color} onInput=${(e) => setB(b.id, (x) => { x.color = e.target.value; })} title="Color" />
            <span class="num">${i + 1}</span>
            <${TextField} label="Name" value=${b.name} onChange=${(v) => setB(b.id, (x) => { x.name = v; })} />
            <button class="danger small" onClick=${() => remove(b.id)}>Delete</button>
          </div>
          <${SelectField} label="Role" value=${b.role} options=${Object.entries(ROLES)} onChange=${(v) => setB(b.id, (x) => { x.role = v; })}
            title="Automatic assignment only gives builders tasks that fit their role. Steps can still name a builder directly." />
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
      <${Section} title="Roles">
        <ul class="plain">
          <li><b>Any task</b>: adapts to whatever needs doing.</li>
          <li><b>Carrier / holder</b>: carries pieces from staging and holds them until they're stable.</li>
          <li><b>Fastener</b>: aligns joints and fastens bolts on the bridge; can also assemble on the ground.</li>
          <li><b>Ground assembler</b>: fetches members to the assembly area and bolts assemblies together.</li>
        </ul>
        <${Hint}>Everyone can place and remove supports. A step in the Sequence tab can name a specific builder, which overrides roles.<//>
      <//>
    </div>
  </div>`;
}
