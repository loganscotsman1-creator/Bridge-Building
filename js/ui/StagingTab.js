// Staging tab: plan where every member lies in the yard. Pull members from the list onto the plan,
// turn them, and for assemblies place the pieces touching where they bolt, which makes those
// connections faster to make.
import { html, useEffect, useMemo, useRef, useState } from '../lib/preact.js';
import { updateProject } from '../model/store.js';
import { uid } from '../model/ids.js';
import { activePlan, ZONE_TYPES } from '../model/schema.js';
import { pointInPoly, polyCentroid } from '../model/geometry.js';
import { assemblyConnections, flatRot, layOutAssembly, membersArea, stagedPoly, stagingSpots } from '../model/plan.js';
import { jointLabel } from '../model/plan.js';
import { fmt } from '../sim/simulate.js';
import { useCamera, gridLines } from './camera.js';
import { applySnap, snapPoly } from './snap.js';
import { ASM_COLORS } from './SequenceTab.js';
import { setConnTime } from './DesignTab.js';
import { Hint, NumField, Section, isTyping } from './common.js';

export function StagingTab({ project, model, sim }) {
  const site = project.site;
  const plan = activePlan(project);
  const T = project.timing;
  const [sel, setSel] = useState(null);
  const [filter, setFilter] = useState('');
  const [pulling, setPulling] = useState(null); // {id, x, y}: a member being dragged from the list
  const [guides, setGuides] = useState([]);
  const dragRef = useRef(null);

  const area = membersArea(site);
  const bounds = useMemo(() => ({ minU: area.x - 6, maxU: area.x + area.w + 6, minV: area.y - 6, maxV: area.y + area.h + 6 }), [area.x, area.y, area.w, area.h]);
  const cam = useCamera({ flipY: false, bounds });
  const { toScreen, toWorld, eventPos } = cam;
  const k = cam.cam.k;
  const S = ([x, y]) => { const q = toScreen(x, y); return q.x + ',' + q.y; };

  const spots = stagingSpots(project, model);
  const placed = model.members.filter((m) => site.staging[m.id]);
  const unplaced = model.members.filter((m) => !site.staging[m.id]);
  const asmOf = new Map();
  plan.assemblies.forEach((a, i) => { for (const id of a.memberIds) asmOf.set(id, { a, color: ASM_COLORS[i % ASM_COLORS.length] }); });
  const conns = assemblyConnections(project, model, plan, spots);
  const selMember = sel ? model.memberById.get(sel) : null;
  const polyOf = (m, spot = spots.get(m.id)) => stagedPoly(m, spot);

  const place = (id, spot, key) => updateProject((p) => { p.site.staging[id] = spot; }, { key });
  const unplace = (id) => { updateProject((p) => { delete p.site.staging[id]; }); setSel(null); };
  const turn = (id, by) => {
    const s = spots.get(id);
    place(id, { x: s.x, y: s.y, rot: ((s.rot ?? 0) + by + 360) % 360 });
  };

  // Snap a shape onto the edges of the other placed members.
  const snapped = (m, spot, free) => {
    const poly = stagedPoly(m, spot);
    if (free) return { spot, lines: [] };
    const targets = placed.filter((o) => o.id !== m.id).map((o) => polyOf(o));
    const s = snapPoly(poly, targets, 10 / k, { rotate: false });
    const c0 = polyCentroid(poly), c1 = polyCentroid(applySnap(poly, s));
    return { spot: { ...spot, x: spot.x + c1[0] - c0[0], y: spot.y + c1[1] - c0[1] }, lines: s.lines };
  };

  // --- dragging a member out of the list ---
  const pullSpot = (p) => {
    const r = cam.svgRef.current.getBoundingClientRect();
    if (p.x < r.left || p.x > r.right || p.y < r.top || p.y > r.bottom) return null;
    const w = toWorld(p.x - r.left, p.y - r.top);
    const m = model.memberById.get(p.id);
    return snapped(m, { x: w.u, y: w.v, rot: flatRot(m) }, p.shift);
  };
  const pullRef = useRef(null);
  pullRef.current = pullSpot;
  useEffect(() => {
    if (!pulling) return;
    const move = (e) => setPulling((p) => p && { ...p, x: e.clientX, y: e.clientY, shift: e.shiftKey });
    const up = (e) => {
      const p = { id: pulling.id, x: e.clientX, y: e.clientY, shift: e.shiftKey };
      const hit = pullRef.current(p);
      if (hit) { place(p.id, roundSpot(hit.spot)); setSel(p.id); }
      setPulling(null);
      setGuides([]);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
  }, [!!pulling]);
  const ghost = pulling ? pullSpot(pulling) : null;

  useEffect(() => {
    const onKey = (e) => {
      if (isTyping(e) || !sel) return;
      const key = e.key.toLowerCase();
      if (key === 'r') turn(sel, e.shiftKey ? -15 : 90);
      else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); unplace(sel); }
      else if (e.key === 'Escape') setSel(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // --- dragging on the plan ---
  const hit = (w) => {
    let best = null;
    for (const m of placed) {
      const q = polyOf(m);
      if (!pointInPoly([w.u, w.v], q, 2 / k)) continue;
      if (!best || m.long * m.wide < best.long * best.wide) best = m;
    }
    return best;
  };
  const onPointerDown = (e) => {
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* synthetic or finished pointer */ }
    const { sx, sy } = eventPos(e);
    const w = toWorld(sx, sy);
    const m = e.button === 0 ? hit(w) : null;
    if (m) {
      setSel(m.id);
      const s = spots.get(m.id);
      dragRef.current = { id: m.id, orig: { x: s.x, y: s.y, rot: s.rot }, start: w, key: 'stage-' + uid() };
      return;
    }
    if (e.button === 0) setSel(null);
    cam.beginPan(e);
  };
  const onPointerMove = (e) => {
    if (cam.movePan(e)) return;
    const d = dragRef.current;
    if (!d) return;
    const { sx, sy } = eventPos(e);
    const w = toWorld(sx, sy);
    const m = model.memberById.get(d.id);
    const s = snapped(m, { ...d.orig, x: d.orig.x + w.u - d.start.u, y: d.orig.y + w.v - d.start.v }, e.shiftKey);
    setGuides(s.lines);
    place(d.id, roundSpot(s.spot), d.key);
  };
  const onPointerUp = () => { cam.endPan(); dragRef.current = null; setGuides([]); };

  // --- drawing ---
  const zones = site.zones.filter((z) => ZONE_TYPES[z.type]?.stage || ZONE_TYPES[z.type]?.sub).sort((a, b) => b.w * b.h - a.w * a.h);
  const shown = model.members.filter((m) => m.name.toLowerCase().includes(filter.toLowerCase()));

  return html`<div class="tab-layout">
    <div class="main">
      <div class="toolbar">
        <span class="muted">Drag members from the list onto the yard. Drag to move (they snap together; Shift places freely), R turns 90°, Shift+R turns 15°, Delete sends one back to the list. Scroll to zoom, drag empty space to pan.</span>
        <span class="spacer"></span>
        <button onClick=${() => cam.fit(bounds)}>Members area</button>
        <button onClick=${() => cam.fit({ minU: 0, maxU: site.width, minV: 0, maxV: site.depth })}>Whole site</button>
      </div>
      <div class="plan" data-tour="staging-canvas">
        <svg ref=${cam.svgRef} class="canvas" onPointerDown=${onPointerDown} onPointerMove=${onPointerMove} onPointerUp=${onPointerUp} onContextMenu=${(e) => e.preventDefault()}>
          <rect x="0" y="0" width=${cam.size.w} height=${cam.size.h} fill="#f1f5f9" />
          ${gridLines(cam, { minor: 6, major: 12 }).map((l) => html`<line ...${l} stroke=${l.major ? '#e2e8f0' : '#eef2f7'} />`)}
          ${zones.map((z) => {
            const a = toScreen(z.x, z.y), b = toScreen(z.x + z.w, z.y + z.h);
            const color = ZONE_TYPES[z.type].color;
            return html`<g key=${z.id}><rect x=${a.x} y=${a.y} width=${b.x - a.x} height=${b.y - a.y} fill=${color} fill-opacity=${z.type === 'members' ? 0.1 : 0.04} stroke=${color} stroke-dasharray=${ZONE_TYPES[z.type].sub ? '4 3' : null} />
              <text x=${a.x + 4} y=${ZONE_TYPES[z.type].sub ? a.y + 14 : a.y - 5} font-size="11" font-weight="600" fill=${color}>${z.name}</text></g>`;
          })}
          ${placed.map((m) => {
            const q = polyOf(m);
            const on = sel === m.id;
            const color = asmOf.get(m.id)?.color || '#475569';
            const c = spots.get(m.id);
            const s = toScreen(c.x, c.y);
            const fits = m.long * k > m.name.length * 6;
            return html`<g key=${m.id}><polygon points=${q.map(S).join(' ')} fill=${color} fill-opacity=${on ? 0.55 : 0.3} stroke=${on ? '#f59e0b' : color} stroke-width=${on ? 2.5 : 1.2} />
              ${fits && html`<text x=${s.x} y=${s.y + 4} font-size="11" font-weight="600" text-anchor="middle" fill="#0f172a" class="halo" pointer-events="none">${m.name}</text>`}
              <title>${m.name}</title></g>`;
          })}
          ${conns.flatMap(({ joints }) => joints.filter((j) => j.touching).map((j) => {
            const s = toScreen(j.at[0], j.at[1]);
            return html`<circle key=${'t' + j.joint.id} cx=${s.x} cy=${s.y} r="6" fill="#16a34a" stroke="#fff" stroke-width="1.5" pointer-events="none"><title>${jointLabel(model, j.joint)}: touching where it bolts</title></circle>`;
          }))}
          ${guides.map(([a, b], i) => { const p = toScreen(a[0], a[1]), q = toScreen(b[0], b[1]); return html`<line key=${'g' + i} x1=${p.x} y1=${p.y} x2=${q.x} y2=${q.y} stroke="#ec4899" stroke-width="3" pointer-events="none" />`; })}
          ${ghost && html`<polygon points=${stagedPoly(model.memberById.get(pulling.id), ghost.spot).map(S).join(' ')} fill="#f59e0b" fill-opacity="0.3" stroke="#f59e0b" stroke-width="2" stroke-dasharray="6 4" pointer-events="none" />`}
        </svg>
      </div>
      <div class="hint-bar">${unplaced.length ? `${unplaced.length} member${unplaced.length === 1 ? ' is' : 's are'} not placed yet; until they are, the simulation stacks them in the members area.` : 'Every member has its own spot.'}
        ${placed.some((m) => !polyOf(m).every(([x, y]) => x >= area.x - 0.5 && x <= area.x + area.w + 0.5 && y >= area.y - 0.5 && y <= area.y + area.h + 0.5)) && html` <b class="bad">Some members hang outside the members area.</b>`}</div>
    </div>
    <aside class="side">
      <div data-tour="staging-list">
      <${Section} title=${`Members (${placed.length} of ${model.members.length} placed)`}>
        <input type="search" placeholder="Filter members" value=${filter} onInput=${(e) => setFilter(e.target.value)} />
        <ul class="stage-list">${shown.map((m) => {
          const a = asmOf.get(m.id);
          const on = !!site.staging[m.id];
          return html`<li key=${m.id} class=${(on ? 'placed ' : '') + (sel === m.id ? 'sel' : '')}
            onPointerDown=${(e) => { if (e.button !== 0) return; e.preventDefault(); setPulling({ id: m.id, x: e.clientX, y: e.clientY }); }}
            onClick=${() => on && setSel(m.id)} title="Drag onto the yard">
            <span class="grip">⋮⋮</span>
            ${a && html`<span class="dot" style=${{ background: a.color }}></span>`}
            <span class="nm">${m.name}</span>
            <span class="muted small">${m.long.toFixed(0)} × ${m.wide.toFixed(0)} in</span>
            <span class=${on ? 'ok small' : 'muted small'}>${on ? '✔' : ''}</span></li>`;
        })}</ul>
      <//>
      </div>
      ${selMember && html`<${Section} title=${'Member · ' + selMember.name}>
        <div class="row">
          <button onClick=${() => turn(sel, -90)}>⟲ 90°</button>
          <button onClick=${() => turn(sel, 90)}>⟳ 90°</button>
          <button onClick=${() => unplace(sel)}>Back to the list</button>
        </div>
        <${NumField} label="Turned" unit="°" value=${spots.get(sel)?.rot ?? 0} onChange=${(v) => { const s = spots.get(sel); place(sel, { x: s.x, y: s.y, rot: v }, 'rot' + sel); }} />
        ${asmOf.get(sel) && html`<${Hint}>Part of ${asmOf.get(sel).a.name}.<//>`}
      <//>`}
      <div data-tour="staging-assemblies">
      <${Section} title="Assemblies made in the yard">
        ${!plan.assemblies.length && html`<${Hint}>Make assemblies in tab 5 (Build sequence). Their members show up here in the same colors.<//>`}
        ${plan.assemblies.length > 0 && html`<${Hint}>Place an assembly's members touching where they bolt (or press Lay out) and those connections need less lining up. A green dot marks each one. Empty times use the defaults below.<//>`}
        ${conns.map(({ assembly: a, joints }) => {
          const col = asmOf.get(a.memberIds[0])?.color || '#475569';
          const total = (sim?.segments || []).filter((s) => s.kind === 'assemble' && s.unitKey === 'a:' + a.id).reduce((t, s) => t + s.t1 - s.t0, 0);
          const ready = joints.filter((j) => j.touching).length;
          return html`<div class="asm" key=${a.id} style=${{ borderLeft: '4px solid ' + col }}>
            <div class="row"><b>${a.name}</b><span class="spacer"></span>
              ${total > 0 && html`<span class="muted small" title="Time to bolt this assembly together in this plan">${fmt(total)} to assemble</span>`}
              <button class="small" title="Place its members the way they go together, touching where they bolt"
                onClick=${() => updateProject((p) => { if (!layOutAssembly(p, model, p.plans.find((x) => x.id === p.activePlanId).assemblies.find((x) => x.id === a.id))) alert(`${a.name} doesn't fit in a free part of the members area, so it was placed in the middle. Move other members or make the area bigger.`); })}>Lay out</button></div>
            <div class=${ready === joints.length && joints.length ? 'ok small' : 'muted small'}>${ready} of ${joints.length} connection${joints.length === 1 ? '' : 's'} touching</div>
            ${joints.map(({ joint: j, touching }) => html`<div class="conn-times" key=${j.id}>
              <div class="small"><span class=${touching ? 'ok' : 'muted'}>${touching ? '● ' : '○ '}</span>${jointLabel(model, j)} · ${j.bolts} bolt${j.bolts === 1 ? '' : 's'}</div>
              <div class="row2">
                <${NumField} label="Align" unit="s" optional placeholder=${String(touching ? T.stagedAlignTime : T.assemblyAlignTime > 0 ? T.assemblyAlignTime : T.alignTime)} min=${0} value=${j.alignTime} title="Empty uses the default" onChange=${(v) => setConnTime(j, 'alignTime', v)} />
                <${NumField} label="Per bolt" unit="s" optional placeholder="default" min=${0} value=${j.boltTime} title="Empty uses the default" onChange=${(v) => setConnTime(j, 'boltTime', v)} />
              </div></div>`)}
          </div>`;
        })}
        <div class="row2">
          <${NumField} label="Align, touching" unit="s" min=${0} value=${T.stagedAlignTime} title="Default for connections staged touching" onChange=${(v) => updateProject((p) => { p.timing.stagedAlignTime = v; }, { key: 'tsa' })} />
          <${NumField} label="Per bolt, touching" unit="s" min=${0} value=${T.stagedBoltTime} title="0 = the staging-yard bolt time" onChange=${(v) => updateProject((p) => { p.timing.stagedBoltTime = v; }, { key: 'tsb' })} />
        </div>
      <//>
      </div>
    </aside>
  </div>`;
}

const roundSpot = (s) => ({ x: Math.round(s.x * 100) / 100, y: Math.round(s.y * 100) / 100, rot: s.rot });
