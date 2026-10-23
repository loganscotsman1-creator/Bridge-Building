// Top-down site plan: zones, the bridge footprint, staging piles, tools, builders.
// In edit mode things can be dragged; in playback mode it draws the simulation state at time t.
import { html, useMemo, useRef } from '../lib/preact.js';
import { updateProject } from '../model/store.js';
import { uid } from '../model/ids.js';
import { ZONE_TYPES } from '../model/schema.js';
import { bridgeToSite, pointSegment } from '../model/geometry.js';
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
    if (!state) {
      for (const t of project.tools) list.push({ type: 'tool', id: t.id, x: t.start.x, y: t.start.y, r: 10 });
      list.push({ type: 'hardware', id: 'hw', x: site.hardware.x, y: site.hardware.y, r: 10 });
    }
    return list;
  };

  const onPointerDown = (e) => {
    e.currentTarget.setPointerCapture(e.pointerId);
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
      const orig = h.type === 'builder' ? project.builders.find((b) => b.id === h.id).start : h.type === 'tool' ? project.tools.find((t) => t.id === h.id).start : site.hardware;
      start(h.type, h.id, { ...orig });
      return;
    }
    // Staging pieces
    for (const m of model.members) {
      const s = spots.get(m.id);
      if (!s) continue;
      const half = Math.min(m.length, 42) / 2;
      const r = pointSegment({ x: sx, y: sy }, S({ x: s.x - half, y: s.y }), S({ x: s.x + half, y: s.y }));
      if (r.d < 5) { start('piece', m.id, { x: s.x, y: s.y }); return; }
    }
    // Bridge footprint
    for (const m of model.members) {
      for (const [a, b] of m.segments) {
        const na = model.nodes.get(a), nb = model.nodes.get(b);
        const r = pointSegment({ x: sx, y: sy }, S(bridgeToSite(site, na.x, na.y)), S(bridgeToSite(site, nb.x, nb.y)));
        if (r.d < 6) { start('bridge', 'bridge', { ...site.bridge }); return; }
      }
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
      else if (d.type === 'hardware') s.hardware = { x: d.orig.x + dx, y: d.orig.y + dy };
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
  for (const z of site.zones) {
    const a = S({ x: z.x, y: z.y }), b = S({ x: z.x + z.w, y: z.y + z.h });
    const color = (ZONE_TYPES[z.type] || ZONE_TYPES.walkway).color;
    const selZ = isSel('zone', z.id);
    els.push(html`<g key=${'z' + z.id}>
      <rect x=${a.x} y=${a.y} width=${b.x - a.x} height=${b.y - a.y} fill=${color} fill-opacity=${z.type === 'nogo' ? 0.16 : 0.08}
        stroke=${color} stroke-width=${selZ ? 3 : 1.5} stroke-dasharray=${z.type === 'nogo' ? '6 4' : null} />
      <text x=${a.x + 5} y=${a.y + 14} font-size="12" fill=${color} font-weight="600">${z.name}</text>
      ${selZ && editable && [[a.x, a.y], [b.x, a.y], [a.x, b.y], [b.x, b.y]].map(([x, y], i) => html`<rect key=${i} x=${x - 5} y=${y - 5} width="10" height="10" fill="#fff" stroke=${color} stroke-width="2" />`)}
    </g>`);
  }

  // Bridge
  for (const m of model.members) {
    const ms = state && state.members.get(m.id);
    const onBridge = !state || (ms && ms.loc === 'bridge');
    const color = state ? (onBridge ? STATUS_COLORS[ms.status] || '#475569' : '#cbd5e1') : '#64748b';
    for (const [a, b] of m.segments) {
      const na = model.nodes.get(a), nb = model.nodes.get(b);
      const A = S(bridgeToSite(site, na.x, na.y)), B = S(bridgeToSite(site, nb.x, nb.y));
      els.push(html`<line x1=${A.x} y1=${A.y} x2=${B.x} y2=${B.y} stroke=${color} stroke-width=${Math.max(1.5, m.tube.w * k)}
        stroke-dasharray=${onBridge ? null : '3 3'} opacity=${onBridge ? 0.95 : 0.6} stroke-linecap="round" />`);
    }
  }
  for (const n of model.nodes.values()) {
    if (!n.bearing) continue;
    const s = S(bridgeToSite(site, n.x, n.y));
    els.push(html`<rect x=${s.x - 4} y=${s.y - 4} width="8" height="8" fill="#f59e0b" stroke="#92400e" />`);
  }
  if (state) {
    for (const sp of state.supports) {
      const n = model.nodes.get(sp.nodeId);
      if (!n) continue;
      const s = S(bridgeToSite(site, n.x, n.y));
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
    const half = Math.min(m.length, 48) / 2;
    const c = Math.cos(dir), s = Math.sin(dir);
    const A = S({ x: p.x - half * c, y: p.y - half * s }), B = S({ x: p.x + half * c, y: p.y + half * s });
    const selP = isSel('piece', m.id);
    els.push(html`<g><line x1=${A.x} y1=${A.y} x2=${B.x} y2=${B.y} stroke=${selP ? '#facc15' : m.color || '#334155'} stroke-width=${Math.max(2, m.tube.d * k)} stroke-linecap="round" />
      ${k > 1.6 && !(state && p.loc === 'carried') && html`<text x=${(A.x + B.x) / 2} y=${A.y - 3} font-size="9" text-anchor="middle" fill="#475569">${m.name}</text>`}
      <title>${m.name}</title></g>`);
  }

  if (!state) {
    for (const t of project.tools) {
      const s = S(t.start);
      els.push(html`<g><rect x=${s.x - 8} y=${s.y - 8} width="16" height="16" rx="3" fill=${isSel('tool', t.id) ? '#facc15' : '#e2e8f0'} stroke="#334155" />
        <text x=${s.x} y=${s.y + 4} font-size="10" text-anchor="middle" font-weight="700">${(t.name || 'T')[0]}</text>
        ${k > 1.4 && html`<text x=${s.x} y=${s.y + 19} font-size="9" text-anchor="middle" fill="#334155" class="halo">${t.name} ×${t.count}</text>`}
        <title>${t.name} ×${t.count}</title></g>`);
    }
    const h = S(site.hardware);
    els.push(html`<g><polygon points=${hex(h.x, h.y, 9)} fill=${isSel('hardware', 'hw') ? '#facc15' : '#fef3c7'} stroke="#92400e" />
      <text x=${h.x} y=${h.y + 3} font-size="8" text-anchor="middle" font-weight="700">NB</text>
      ${k > 1.4 && html`<text x=${h.x} y=${h.y + 19} font-size="9" text-anchor="middle" fill="#92400e" class="halo">Nuts & bolts</text>`}
      <title>Nuts & bolts</title></g>`);
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

function hex(x, y, r) {
  return Array.from({ length: 6 }, (_, i) => {
    const a = (Math.PI / 3) * i;
    return `${x + r * Math.cos(a)},${y + r * Math.sin(a)}`;
  }).join(' ');
}

function scaleBar(cam) {
  const ft = [1, 2, 5, 10, 20].find((f) => f * 12 * cam.cam.k > 60) || 20;
  const w = ft * 12 * cam.cam.k;
  const y = cam.size.h - 14;
  return html`<g><line x1="12" y1=${y} x2=${12 + w} y2=${y} stroke="#334155" stroke-width="3" /><text x=${12 + w + 5} y=${y + 4} font-size="11" fill="#334155">${ft} ft</text></g>`;
}
