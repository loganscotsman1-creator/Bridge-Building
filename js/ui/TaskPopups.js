// The pop-ups that open when a task lands on the timeline, to say which piece, which connection or
// which pieces it's about. Each shows the staging yard or the bridge, and a list beside it.
import { html, useEffect, useMemo, useRef, useState } from '../lib/preact.js';
import { pointInPoly, polyArea } from '../model/geometry.js';
import { ZONE_TYPES } from '../model/schema.js';
import { assemblyConnections, jointLabel, membersArea, stagedPoly, stagingSpots } from '../model/plan.js';
import { ASM_COLORS, connectionChoices, onStagingSide, pieceChoices } from '../model/timeline.js';
import { useCamera, gridLines } from './camera.js';
import { IsoView } from './IsoView.js';
import { Check, Hint, SelectField, TextField } from './common.js';

export function Popup({ title, onClose, children, wide = true }) {
  useEffect(() => {
    const key = (e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  });
  return html`<div class="pop-back" onPointerDown=${(e) => { if (e.target === e.currentTarget) onClose(); }}>
    <div class=${'pop' + (wide ? ' wide' : '')} role="dialog" aria-label=${title}>
      <div class="pop-head"><b>${title}</b><span class="spacer"></span><button class="small" title="Cancel (Esc)" onClick=${onClose}>✕</button></div>
      ${children}
    </div>
  </div>`;
}

// The staging yard from above. Pick a piece by clicking it; scroll to zoom, drag to pan.
function YardView({ project, model, styleOf, onPick }) {
  const site = project.site;
  const area = membersArea(site);
  const bounds = useMemo(() => ({ minU: area.x - 4, maxU: area.x + area.w + 4, minV: area.y - 4, maxV: area.y + area.h + 4 }), [area.x, area.y, area.w, area.h]);
  const cam = useCamera({ flipY: false, bounds });
  const { toScreen, toWorld, eventPos } = cam;
  const k = cam.cam.k;
  const spots = useMemo(() => stagingSpots(project, model), [project.site, model]);
  const press = useRef(null);
  const S = ([x, y]) => { const q = toScreen(x, y); return q.x + ',' + q.y; };
  const polyOf = (m) => stagedPoly(m, spots.get(m.id));
  const hit = (w) => {
    let best = null;
    for (const m of model.members) {
      const q = polyOf(m);
      if (!pointInPoly([w.u, w.v], q, 5 / k)) continue;
      if (!best || Math.abs(polyArea(q)) < Math.abs(polyArea(polyOf(best)))) best = m;
    }
    return best;
  };
  const zones = site.zones.filter((z) => ZONE_TYPES[z.type]?.stage || ZONE_TYPES[z.type]?.sub);
  return html`<svg ref=${cam.svgRef} class="canvas pop-yard"
    onPointerDown=${(e) => { try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ } press.current = { ...eventPos(e), moved: false }; cam.beginPan(e); }}
    onPointerMove=${(e) => { if (press.current) { const p = eventPos(e); if (Math.hypot(p.sx - press.current.sx, p.sy - press.current.sy) > 4) press.current.moved = true; } cam.movePan(e); }}
    onPointerUp=${(e) => { cam.endPan(); const was = press.current; press.current = null; if (was && !was.moved) { const p = eventPos(e); const m = hit(toWorld(p.sx, p.sy)); if (m) onPick(m); } }}>
    <rect x="0" y="0" width=${cam.size.w} height=${cam.size.h} fill="#f1f5f9" />
    ${gridLines(cam, { minor: 6, major: 12 }).map((l) => html`<line ...${l} stroke=${l.major ? '#e2e8f0' : '#eef2f7'} />`)}
    ${zones.map((z) => {
      const a = toScreen(z.x, z.y), b = toScreen(z.x + z.w, z.y + z.h);
      const color = ZONE_TYPES[z.type].color;
      return html`<rect key=${z.id} x=${a.x} y=${a.y} width=${b.x - a.x} height=${b.y - a.y} fill=${color} fill-opacity=${z.type === 'members' ? 0.08 : 0.03} stroke=${color} />`;
    })}
    ${model.members.map((m) => {
      const st = styleOf(m);
      const s = spots.get(m.id), c = toScreen(s.x, s.y);
      return html`<g key=${m.id} style=${{ cursor: 'pointer' }}>
        <polygon points=${polyOf(m).map(S).join(' ')} fill=${st.color} fill-opacity=${st.dim ? 0.12 : st.on ? 0.75 : 0.35} stroke=${st.outline || st.color} stroke-opacity=${st.dim ? 0.35 : 1} stroke-width=${st.outline ? 2.5 : 1.2} />
        ${!st.dim && html`<text x=${c.x} y=${c.y + 4} font-size="11" font-weight="600" text-anchor="middle" fill="#0f172a" class="halo" pointer-events="none">${m.name}</text>`}
        <title>${m.name}${st.note ? ': ' + st.note : ''}</title></g>`;
    })}
  </svg>`;
}

// Staging yard or bridge, whichever this builder is looking at.
function PickCanvas({ view, setView, project, model, styleOf, onPick, label }) {
  const isoStyle = (m) => {
    const st = styleOf(m);
    return st.dim ? { color: '#cbd5e1', opacity: 0.3 } : { color: st.color, opacity: 0.95, outline: st.outline };
  };
  return html`<div class="pop-canvas">
    <div class="pop-views">
      <button class=${view === 'yard' ? 'on' : ''} data-view="yard" onClick=${() => setView('yard')}>Staging yard</button>
      <button class=${view === 'bridge' ? 'on' : ''} data-view="bridge" onClick=${() => setView('bridge')}>Bridge</button>
      <span class="muted small">${label}</span>
    </div>
    ${view === 'yard'
      ? html`<${YardView} key="yard" project=${project} model=${model} styleOf=${styleOf} onPick=${onPick} />`
      : html`<${IsoView} key="bridge" model=${model} styleOf=${isoStyle} onPick=${onPick} />`}
  </div>`;
}

const READY = '#2563eb', LATER = '#94a3b8', NO = '#cbd5e1', PICKED = '#facc15', PARTNER = '#16a34a';
const GROUPS = {
  run: { ready: 'In the yard', later: '', no: 'Already taken care of' },
  receive: { ready: 'Ready for them', later: 'Not on its way yet', no: 'Already placed' },
  support: { ready: 'On the bridge by now', later: 'Placed later in the plan', no: 'Not placed yet' },
  stand: { ready: 'Pieces', later: '', no: '' },
};

// A step about one piece. Clicking a piece finishes it.
export function PiecePopup({ kind, title, project, model, plan, sim, builderId, t, firstView, onPick, onClose, extra }) {
  const [view, setView] = useState(firstView);
  const choices = useMemo(() => pieceChoices(project, model, plan, sim, kind, builderId, t), [plan, sim, kind, builderId, t]);
  const colorOf = useMemo(() => {
    const out = new Map();
    plan.assemblies.forEach((a, i) => a.memberIds.forEach((id) => out.set(id, ASM_COLORS[i % ASM_COLORS.length])));
    return out;
  }, [plan]);
  const [hover, setHover] = useState(null);
  const styleOf = (m) => {
    const c = choices.get(m.id);
    if (!c) return { color: NO, dim: true };
    const on = !!hover && c.unitKey === hover;
    return { color: on ? PICKED : c.status === 'ready' ? colorOf.get(m.id) || READY : LATER, dim: c.status !== 'ready' && !on, note: c.note, outline: on ? '#b45309' : null, on };
  };
  // One line per thing that gets picked: a whole assembly when carrying, one member when supporting.
  const wholeUnits = kind === 'run' || kind === 'receive';
  const rows = [];
  const seen = new Set();
  for (const m of model.members) {
    const c = choices.get(m.id);
    if (!c || (wholeUnits && seen.has(c.unitKey))) continue;
    seen.add(c.unitKey);
    rows.push({ key: wholeUnits ? c.unitKey : m.id, memberId: m.id, name: wholeUnits ? c.unit.name : m.name, ...c });
  }
  const names = GROUPS[kind] || GROUPS.stand;
  const section = (status) => rows.filter((r) => r.status === status);
  const row = (r) => html`<li key=${r.key}><button class=${'pop-row ' + r.status} data-pick=${r.memberId} onClick=${() => onPick(r.memberId)}
    onPointerEnter=${() => setHover(r.unitKey)} onPointerLeave=${() => setHover(null)}>
    ${colorOf.has(r.memberId) && html`<span class="dot" style=${{ background: colorOf.get(r.memberId) }}></span>`}
    <b>${r.name}</b><small>${r.note}</small></button></li>`;
  return html`<${Popup} title=${title} onClose=${onClose}>
    <div class="pop-body">
      <${PickCanvas} view=${view} setView=${setView} project=${project} model=${model} styleOf=${styleOf} onPick=${(m) => onPick(m.id)} label="Click a piece" />
      <div class="pop-list">
        ${extra}
        ${section('ready').length > 0 && html`<h4>${names.ready}</h4><ul>${section('ready').map(row)}</ul>`}
        ${!section('ready').length && html`<${Hint}>Nothing is ready for this builder at this point in the plan. ${kind === 'receive' ? 'Have someone run a piece to the river first.' : kind === 'support' ? 'Have someone place a piece first.' : ''}<//>`}
        ${section('later').length > 0 && html`<details open=${!section('ready').length}><summary>${names.later} (${section('later').length})</summary><ul>${section('later').map(row)}</ul></details>`}
        ${section('no').length > 0 && html`<details><summary>${names.no} (${section('no').length})</summary><ul>${section('no').map(row)}</ul></details>`}
      </div>
    </div>
  <//>`;
}

// A bolt or nut: which two pieces it goes between.
export function ConnectionPopup({ kind, title, project, model, plan, sim, t, firstView, carried, initial, onDone, onClose }) {
  const rows = useMemo(() => connectionChoices(model, plan, sim, kind, t), [plan, sim, kind, t]);
  const [view, setView] = useState(firstView);
  const [first, setFirst] = useState(initial?.member || null);
  const [jointId, setJointId] = useState(initial?.jointId || null);
  const [which, setWhich] = useState('all');
  const [where, setWhere] = useState(null);
  const [also, setAlso] = useState(false);
  const [msg, setMsg] = useState('');
  const row = rows.find((r) => r.joint.id === jointId);
  const nameOf = (id) => model.memberById.get(id)?.name || '?';
  const partners = new Set(first ? rows.filter((r) => r.status !== 'no' && (r.joint.a === first || r.joint.b === first)).map((r) => (r.joint.a === first ? r.joint.b : r.joint.a)) : []);
  const useful = new Set(rows.filter((r) => r.status === 'ready').flatMap((r) => [r.joint.a, r.joint.b]));
  const someUse = new Set(rows.filter((r) => r.status !== 'no').flatMap((r) => [r.joint.a, r.joint.b]));
  const styleOf = (m) => {
    if (row && (row.joint.a === m.id || row.joint.b === m.id)) return { color: PICKED, outline: '#b45309', on: true };
    if (m.id === first) return { color: PICKED, outline: '#b45309', on: true };
    if (first) return partners.has(m.id) ? { color: PARTNER, note: 'Bolts to the first piece', on: true } : { color: NO, dim: true };
    if (useful.has(m.id)) return { color: READY };
    if (someUse.has(m.id)) return { color: LATER };
    return { color: NO, dim: true };
  };
  const choose = (r, from) => { setFirst(from || r.joint.a); setJointId(r.joint.id); setWhich('all'); setWhere(null); setMsg(''); };
  const click = (m) => {
    setMsg('');
    if (row || !first || m.id === first) { setJointId(null); setFirst(m.id === first ? null : m.id); return; }
    const r = rows.find((x) => (x.joint.a === first && x.joint.b === m.id) || (x.joint.b === first && x.joint.a === m.id));
    if (r) { choose(r, first); return; }
    setMsg(`${nameOf(first)} and ${m.name} have no bolts between them. Pick a piece it goes with, in green.`);
  };
  const handMember = carried && row && (carried.memberIds.includes(row.joint.a) ? row.joint.a : carried.memberIds.includes(row.joint.b) ? row.joint.b : null);
  const place = where || (kind === 'bolt' && handMember ? 'hand' : row?.inside ? 'staging' : 'bridge');
  const boltChoices = row ? (kind === 'nut' ? row.ready : row.left.length ? row.left : row.joint.boltIds) : [];
  const done = () => onDone({
    member: place === 'hand' && handMember ? handMember : first || row.joint.a,
    jointId: row.joint.id,
    boltIds: which === 'all' ? (boltChoices.length ? boltChoices : row.joint.boltIds) : [which],
    where: place,
    also,
  });
  const listed = rows.filter((r) => !first || r.joint.a === first || r.joint.b === first);
  const line = (r) => html`<li key=${r.joint.id}><button class=${'pop-row ' + r.status + (r === row ? ' chosen' : '')} data-joint=${r.joint.id} onClick=${() => choose(r, first)}>
    <b>${jointLabel(model, r.joint)}</b><small>${r.left.length} of ${r.joint.bolts} ${kind === 'nut' ? 'nuts' : 'bolts'} left · ${r.note}</small></button></li>`;
  const section = (s) => listed.filter((r) => r.status === s);
  return html`<${Popup} title=${title} onClose=${onClose}>
    <div class="pop-body">
      <${PickCanvas} view=${view} setView=${setView} project=${project} model=${model} styleOf=${styleOf} onPick=${click}
        label=${row ? 'Between these two' : first ? `${nameOf(first)} and… click the second piece` : 'Click the two pieces it goes between'} />
      <div class="pop-list">
        ${msg && html`<div class="bad small">${msg}</div>`}
        ${section('ready').length > 0 && html`<h4>Ready now</h4><ul>${section('ready').map(line)}</ul>`}
        ${!section('ready').length && html`<${Hint}>${kind === 'nut' ? 'No placed bolts are waiting for a nut here at this point in the plan.' : 'No connections are within reach here at this point in the plan.'}<//>`}
        ${section('later').length > 0 && html`<details open=${!section('ready').length}><summary>Not ready yet (${section('later').length})</summary><ul>${section('later').map(line)}</ul></details>`}
        ${section('no').length > 0 && html`<details><summary>Already planned (${section('no').length})</summary><ul>${section('no').map(line)}</ul></details>`}
      </div>
    </div>
    <div class="pop-foot">
      ${row ? html`<b>${jointLabel(model, row.joint)}</b>
        ${boltChoices.length > 1 && html`<${SelectField} label=${kind === 'nut' ? 'Which nuts' : 'Which bolts'} value=${which} options=${[['all', `All ${boltChoices.length}`], ...boltChoices.map((id, i) => [id, `${kind === 'nut' ? 'Nut' : 'Bolt'} ${i + 1}`])]} onChange=${setWhich} />`}
        <${SelectField} label="Where" value=${place} options=${[['bridge', 'At the bridge'], ['staging', 'In the staging yard'], ...(kind === 'bolt' && handMember ? [['hand', `While ${carried.name} is carried`]] : [])]} onChange=${setWhere} />
        ${kind === 'bolt' && !initial && html`<${Check} label="Then fasten the nuts too" checked=${also} onChange=${setAlso} />`}` : html`<span class="muted">Pick the two pieces, or a line from the list.</span>`}
      <span class="spacer"></span>
      <button onClick=${onClose}>Cancel</button>
      <button class="primary" data-confirm disabled=${!row} onClick=${done}>${initial ? 'Change it' : kind === 'nut' ? 'Add nut step' : 'Add bolt step'}</button>
    </div>
  <//>`;
}

// Make an assembly: click the pieces in the yard that go together.
export function AssemblyPopup({ title, project, model, plan, initial, onDone, onClose }) {
  const [ids, setIds] = useState(initial?.memberIds || []);
  const [name, setName] = useState(initial?.name || 'Assembly ' + (plan.assemblies.length + 1));
  const [layOut, setLayOut] = useState(false);
  const [view, setView] = useState('yard');
  const max = project.site.rules?.maxAssemblyMembers ?? Infinity;
  const spots = useMemo(() => stagingSpots(project, model), [project.site, model]);
  const asmOf = new Map();
  plan.assemblies.forEach((a, i) => { if (a.id !== initial?.id) a.memberIds.forEach((id) => asmOf.set(id, { a, color: ASM_COLORS[i % ASM_COLORS.length] })); });
  const placedAlone = new Set((plan.tasks || []).filter((t) => t.kind === 'receive' && t.unit?.type === 'member').map((t) => t.unit.id));
  const toggle = (id) => setIds((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : cur.length >= max ? cur : [...cur, id]));
  // Does this piece bolt to something already picked?
  const partners = new Set(model.contacts.filter((c) => c.bolts > 0 && (ids.includes(c.a) || ids.includes(c.b))).flatMap((c) => [c.a, c.b]));
  const styleOf = (m) => {
    if (ids.includes(m.id)) return { color: PICKED, outline: '#b45309', on: true };
    if (ids.length && partners.has(m.id)) return { color: PARTNER, note: 'Bolts to what you picked', on: true };
    const other = asmOf.get(m.id);
    if (other) return { color: other.color, note: 'In ' + other.a.name };
    return { color: ids.length ? LATER : READY };
  };
  const draft = { ...plan, assemblies: [{ id: 'draft', name, memberIds: ids }] };
  const conn = assemblyConnections(project, model, draft, spots)[0]?.joints || [];
  // Are the picked pieces all bolted into one piece?
  const linked = new Set(ids.slice(0, 1));
  for (let grew = true; grew;) {
    grew = false;
    for (const { joint: j } of conn) if (j.bolts > 0 && linked.has(j.a) !== linked.has(j.b)) { linked.add(j.a); linked.add(j.b); grew = true; }
  }
  const apart = ids.length > 1 && linked.size < ids.length;
  const bolts = conn.reduce((n, { joint: j }) => n + (j.bolts || 0), 0);
  const touching = conn.filter((j) => j.touching).length;
  return html`<${Popup} title=${title} onClose=${onClose}>
    <div class="pop-body">
      <${PickCanvas} view=${view} setView=${setView} project=${project} model=${model} styleOf=${styleOf} onPick=${(m) => toggle(m.id)} label="Click the pieces that go together" />
      <div class="pop-list">
        <${TextField} label="Name" value=${name} onChange=${setName} />
        <h4>Picked ${ids.length}${max < Infinity ? ` of at most ${max}` : ''}</h4>
        ${!ids.length && html`<${Hint}>Click pieces in the yard, or in the list below.<//>`}
        <ul>${ids.map((id) => html`<li key=${id}><button class="pop-row chosen" onClick=${() => toggle(id)}><b>${model.memberById.get(id)?.name}</b><small>Click to take it out</small></button></li>`)}</ul>
        <h4>Members</h4>
        <ul>${model.members.filter((m) => !ids.includes(m.id)).map((m) => html`<li key=${m.id}><button class=${'pop-row ' + (partners.has(m.id) && ids.length ? 'partner' : 'ready')} data-pick=${m.id} disabled=${ids.length >= max} onClick=${() => toggle(m.id)}>
          <b>${m.name}</b><small>${asmOf.has(m.id) ? 'Now in ' + asmOf.get(m.id).a.name : placedAlone.has(m.id) ? 'Already placed on its own' : partners.has(m.id) && ids.length ? 'Bolts to what you picked' : ''}</small></button></li>`)}</ul>
      </div>
    </div>
    <div class="pop-foot">
      ${ids.length > 1 ? html`<span>${conn.length} connection${conn.length === 1 ? '' : 's'}, ${bolts} bolt${bolts === 1 ? '' : 's'}${touching ? ` · ${touching} touching in the yard` : ''}</span>` : html`<span class="muted">Pick at least 2 pieces.</span>`}
      ${apart && html`<b class="bad">These pieces don't all bolt together.</b>`}
      <${Check} label="Lay them out touching in the yard" checked=${layOut} title="Moves them in the yard so they touch where they bolt, which needs less lining up" onChange=${setLayOut} />
      <span class="spacer"></span>
      <button onClick=${onClose}>Cancel</button>
      <button class="primary" data-confirm disabled=${ids.length < 2 || !name.trim()} onClick=${() => onDone({ ids, name: name.trim(), layOut })}>${initial ? 'Change it' : 'Add assembly step'}</button>
    </div>
  <//>`;
}

// Which view a builder starts from: the yard on the members' side of the river, the bridge opposite.
// (What's being supported is on the bridge, whichever side they're on.)
export function firstViewFor(project, kind, builderId) {
  if (kind === 'support' || kind === 'stand') return 'bridge';
  return onStagingSide(project.site, project.builders.find((b) => b.id === builderId)) ? 'yard' : 'bridge';
}
