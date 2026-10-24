// Top-down site plan: zones, the bridge footprint, staging piles, tools, builders.
// In edit mode things can be dragged; in playback mode it draws the simulation state at time t.
import { html, useMemo, useRef } from '../lib/preact.js';
import { updateProject } from '../model/store.js';
import { uid } from '../model/ids.js';
import { ZONE_TYPES } from '../model/schema.js';
import { bridgeToSite, pointInPoly, pointSegment } from '../model/geometry.js';
import { useCamera, gridLines } from './camera.js';

const STATUS_COLORS = { held: '#f97316', working: '#eab308', stable: '#475569', unstable: '#dc2626' };

export function PlanView({ project, model, spots, state = null, sel, setSel, editable = false }) {
  const site = project.site;
  const bounds = useMemo(() => ({ minU: 0, maxU: site.width, minV: 0, maxV: site.depth }), [site.width, site.depth]);
  const cam = useCamera({ flipY: false, bounds });
  const { toScreen, toWorld, eventPos } = cam;
  const k = cam.cam.k;
  const dragRef = useRef(null);
  const S = (p) => toScreen(p.x, p.y);
  const isSel = (type, id) => sel && sel.type === type && sel.id === id;

  // --- hit testing (screen px) ---
  const hits = () => {
    const list = [];
    const builders = state ? state.builders.map((b) => ({ id: b.id, x: b.x, y: b.y })) : project.builders.map((b) => ({ id: b.id, x: b.start.x, y: b.start.y }));
    for (const b of builders) list.push({ type: 'builder', id: b.id, x: b.x, y: b.y, r: Math.max(10, 9 * k) });
    if (!state) for (const t of project.tools) list.push({ type: 'tool', id: t.id, x: t.start.x, y: t.start.y, r: 10 });
    return list;
  };
  const sitePoly = (m) => m.footprint.map(([x, y]) => bridgeToSite(site, x, y));

  const onPointerDown = (e) => {
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* synthetic or finished pointer */ }
    const { sx, sy } = eventPos(e);
    const w = toWorld(sx, sy);
    const wp = { x: w.u, y: w.v };
    if (e.button === 1 || e.button === 2 || !editable) {
      if (!editable && setSel) {
        const h = hits().find((h) => Math.hypot(S(h).x - sx, S(h).y - sy) < h.r);
        setSel(h ? { type: h.type, id: h.id } : null);
      }
      cam.beginPan(e);
      return;
    }
    const start = (type, id, orig) => { dragRef.current = { type, id, orig, start: wp, key: 'drag-' + uid() }; setSel({ type, id }); };
    // Corner handles of the selected zone
    if (sel && sel.type === 'zone') {
      const z = site.zones.find((x) => x.id === sel.id);
      if (z) {
        const corners = [[z.x, z.y], [z.x + z.w, z.y], [z.x, z.y + z.h], [z.x + z.w, z.y + z.h]];
        const ci = corners.findIndex(([x, y]) => Math.hypot(S({ x, y }).x - sx, S({ x, y }).y - sy) < 9);
        if (ci >= 0) { dragRef.current = { type: 'corner', id: z.id, corner: ci, orig: { ...z }, start: wp, key: 'drag-' + uid() }; return; }
      }
    }
    const h = hits().find((h) => Math.hypot(S(h).x - sx, S(h).y - sy) < h.r);
    if (h) {
      const orig = h.type === 'builder' ? project.builders.find((b) => b.id === h.id).start : project.tools.find((t) => t.id === h.id).start;
      start(h.type, h.id, { ...orig });
      return;
    }
    // Staging pieces
    for (const m of model.members) {
      const s = spots.get(m.id);
      if (!s) continue;
      const half = m.len / 2;
      const r = pointSegment({ x: sx, y: sy }, S({ x: s.x - half, y: s.y }), S({ x: s.x + half, y: s.y }));
      if (r.d < Math.max(4, (m.depth * k) / 2)) { start('piece', m.id, { x: s.x, y: s.y }); return; }
    }
    // Bridge footprint
    for (const m of model.members) {
      if (pointInPoly([wp.x, wp.y], sitePoly(m).map((p) => [p.x, p.y]), 4 / k)) { start('bridge', 'bridge', { ...site.bridge }); return; }
    }
    // Zones (smallest first so nested zones can be grabbed)
    const zs = site.zones.filter((z) => wp.x >= z.x && wp.x <= z.x + z.w && wp.y >= z.y && wp.y <= z.y + z.h).sort((a, b) => a.w * a.h - b.w * b.h);
    if (zs.length) { start('zone', zs[0].id, { ...zs[0] }); return; }
    setSel(null);
    cam.beginPan(e);
  };

  const onPointerMove = (e) => {
    if (cam.movePan(e)) return;
    const d = dragRef.current;
    if (!d) return;
    const { sx, sy } = eventPos(e);
    const w = toWorld(sx, sy);
    const dx = Math.round(w.u - d.start.x), dy = Math.round(w.v - d.start.y);
    updateProject((p) => {
      const s = p.site;
      if (d.type === 'zone') { const z = s.zones.find((x) => x.id === d.id); z.x = d.orig.x + dx; z.y = d.orig.y + dy; }
      else if (d.type === 'corner') {
        const z = s.zones.find((x) => x.id === d.id), o = d.orig;
        const left = d.corner === 0 || d.corner === 2, top = d.corner === 0 || d.corner === 1;
        if (left) { z.x = Math.min(o.x + o.w - 6, o.x + dx); z.w = o.x + o.w - z.x; } else z.w = Math.max(6, o.w + dx);
        if (top) { z.y = Math.min(o.y + o.h - 6, o.y + dy); z.h = o.y + o.h - z.y; } else z.h = Math.max(6, o.h + dy);
      } else if (d.type === 'bridge') { s.bridge.x = d.orig.x + dx; s.bridge.y = d.orig.y + dy; }
      else if (d.type === 'builder') { const b = p.builders.find((x) => x.id === d.id); b.start = { x: d.orig.x + dx, y: d.orig.y + dy }; }
      else if (d.type === 'tool') { const t = p.tools.find((x) => x.id === d.id); t.start = { x: d.orig.x + dx, y: d.orig.y + dy }; }
      else if (d.type === 'piece') s.staging[d.id] = { x: d.orig.x + dx, y: d.orig.y + dy };
    }, { key: d.key });
  };

  const onPointerUp = () => { cam.endPan(); dragRef.current = null; };

  // --- drawing ---
  const els = [];
  const o = S({ x: 0, y: 0 }), far = S({ x: site.width, y: site.depth });
  els.push(html`<rect key="site" x=${o.x} y=${o.y} width=${far.x - o.x} height=${far.y - o.y} fill="#fff" stroke="#334155" stroke-width="1.5" />`);
  for (const l of gridLines(cam, { minor: 12, major: 60 })) {
    els.push(html`<line ...${l} stroke=${l.major ? '#e2e8f0' : '#f1f5f9'} />`);
  }
  // Big zones first so the smaller areas inside them (footings, members area…) draw on top.
  const zonesSorted = [...site.zones].sort((a, b) => b.w * b.h - a.w * a.h);
  for (const z of zonesSorted) {
    const a = S({ x: z.x, y: z.y }), b = S({ x: z.x + z.w, y: z.y + z.h });
    const type = ZONE_TYPES[z.type] || ZONE_TYPES.walkway;
    const color = type.color;
    const selZ = isSel('zone', z.id);
    const w = b.x - a.x, h = b.y - a.y;
    const fs = type.sub ? 10 : 12;
    const fits = w > z.name.length * fs * 0.55 + 8 && h > fs + 6;
    els.push(html`<g key=${'z' + z.id}>
      <rect x=${a.x} y=${a.y} width=${w} height=${h} fill=${color} fill-opacity=${z.type === 'nogo' ? 0.18 : type.sub ? 0.12 : 0.06}
        stroke=${color} stroke-width=${selZ ? 3 : type.sub ? 1 : 1.5} stroke-dasharray=${z.type === 'nogo' ? '6 4' : type.sub ? '3 2' : null} />
      ${fits && html`<text x=${a.x + 4} y=${a.y + fs + 2} font-size=${fs} fill=${color} font-weight="600">${z.name}</text>`}
      <title>${z.name} · ${type.label} · ${Math.round(z.w)}×${Math.round(z.h)} in</title>
      ${selZ && editable && [[a.x, a.y], [b.x, a.y], [a.x, b.y], [b.x, b.y]].map(([x, y], i) => html`<rect key=${i} x=${x - 5} y=${y - 5} width="10" height="10" fill="#fff" stroke=${color} stroke-width="2" />`)}
    </g>`);
  }

  // Bridge
  for (const m of model.members) {
    const ms = state && state.members.get(m.id);
    const onBridge = !state || (ms && ms.loc === 'bridge');
    const color = state ? (onBridge ? STATUS_COLORS[ms.status] || '#475569' : '#cbd5e1') : '#64748b';
    const poly = sitePoly(m).map((p) => { const s = S(p); return s.x + ',' + s.y; }).join(' ');
    els.push(html`<polygon points=${poly} fill=${color} fill-opacity=${onBridge ? 0.55 : 0.15} stroke=${color}
      stroke-dasharray=${onBridge ? null : '3 3'} stroke-width="1"><title>${m.name}</title></polygon>`);
  }
  for (const m of model.members) {
    if (!m.bearing) continue;
    const s = S(bridgeToSite(site, m.bearingPoint[0], m.bearingPoint[1]));
    els.push(html`<rect x=${s.x - 4} y=${s.y - 4} width="8" height="8" fill="#f59e0b" stroke="#92400e"><title>${m.name} stands on a footing</title></rect>`);
  }
  if (state) {
    for (const sp of state.supports) {
      const m = model.memberById.get(String(sp.nodeId).replace(/^sup:/, ''));
      if (!m) continue;
      const s = S(bridgeToSite(site, m.bearingPoint[0], m.bearingPoint[1]));
      els.push(html`<circle cx=${s.x} cy=${s.y} r="7" fill="#14b8a6" fill-opacity="0.6" stroke="#0f766e" stroke-width="2"><title>${sp.name}</title></circle>`);
    }
  }

  // Pieces off the bridge
  for (const m of model.members) {
    let p, dir = 0;
    if (state) {
      const ms = state.members.get(m.id);
      if (!ms || ms.loc === 'bridge') continue;
      p = ms;
      dir = ms.loc === 'carried' ? ms.dir : 0;
    } else p = spots.get(m.id);
    if (!p) continue;
    const half = m.len / 2;
    const c = Math.cos(dir), s = Math.sin(dir);
    const A = S({ x: p.x - half * c, y: p.y - half * s }), B = S({ x: p.x + half * c, y: p.y + half * s });
    const selP = isSel('piece', m.id);
    els.push(html`<g><line x1=${A.x} y1=${A.y} x2=${B.x} y2=${B.y} stroke=${selP ? '#facc15' : m.color || '#334155'} stroke-width=${Math.max(2, m.depth * k)} />
      ${k > 3 && !(state && p.loc === 'carried') && html`<text x=${(A.x + B.x) / 2} y=${A.y - 3} font-size="9" text-anchor="middle" fill="#475569">${m.name}</text>`}
      <title>${m.name}</title></g>`);
  }

  if (!state) {
    for (const t of project.tools) {
      const s = S(t.start);
      els.push(html`<g><rect x=${s.x - 8} y=${s.y - 8} width="16" height="16" rx="3" fill=${isSel('tool', t.id) ? '#facc15' : '#e2e8f0'} stroke="#334155" />
        <text x=${s.x} y=${s.y + 4} font-size="10" text-anchor="middle" font-weight="700">${(t.name || 'T')[0]}</text>
        ${k > 2.2 && html`<text x=${s.x} y=${s.y + 19} font-size="9" text-anchor="middle" fill="#334155" class="halo">${t.name} ×${t.count}</text>`}
        <title>${t.name} ×${t.count}</title></g>`);
    }
  }

  // Builders
  const builders = state ? state.builders : project.builders.map((b) => ({ ...b, x: b.start.x, y: b.start.y }));
  builders.forEach((b, i) => {
    const s = S(b);
    const r = Math.max(7, 9 * k);
    els.push(html`<g key=${'b' + b.id}>
      ${state && b.kind === 'hold' && html`<circle cx=${s.x} cy=${s.y} r=${r + 5} fill="none" stroke="#f97316" stroke-width="3" />`}
      <circle cx=${s.x} cy=${s.y} r=${r} fill=${b.color} stroke=${isSel('builder', b.id) ? '#facc15' : '#fff'} stroke-width="2.5" />
      <text x=${s.x} y=${s.y + 4} font-size="11" text-anchor="middle" fill="#fff" font-weight="700">${i + 1}</text>
      ${state && b.kind !== 'idle' && html`<text x=${s.x + r + 3} y=${s.y - r} font-size="10" fill="#111827" class="halo">${b.label}</text>`}
      <title>${b.name}</title>
    </g>`);
  });

  return html`<div class="plan">
    <svg ref=${cam.svgRef} class="canvas" onPointerDown=${onPointerDown} onPointerMove=${onPointerMove} onPointerUp=${onPointerUp} onContextMenu=${(e) => e.preventDefault()}>
      <rect x="0" y="0" width=${cam.size.w} height=${cam.size.h} fill="#f1f5f9" />
      ${els}
      ${scaleBar(cam)}
    </svg>
    <button class="fit-btn" onClick=${() => cam.fit(bounds)}>Fit</button>
  </div>`;
}

function scaleBar(cam) {
  const ft = [1, 2, 5, 10, 20].find((f) => f * 12 * cam.cam.k > 60) || 20;
  const w = ft * 12 * cam.cam.k;
  const y = cam.size.h - 14;
  return html`<g><line x1="12" y1=${y} x2=${12 + w} y2=${y} stroke="#334155" stroke-width="3" /><text x=${12 + w + 5} y=${y + 4} font-size="11" fill="#334155">${ft} ft</text></g>`;
}
