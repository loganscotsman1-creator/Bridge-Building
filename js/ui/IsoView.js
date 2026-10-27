// Simple 3D view of the bridge model (orthographic), each member drawn as its box. Drag to rotate.
import { html, useEffect, useLayoutEffect, useRef, useState } from '../lib/preact.js';
import { PLANE_COLORS } from './Annotator.js';

// The 8 corners of a member's box: its outline offset ± half its thickness out of the view.
function prism(m) {
  const h = m.thick / 2;
  const off = m.plane === 'L' ? [0, 0, h] : [0, h, 0];
  const lo = m.corners3.map((c) => [c[0] - off[0], c[1] - off[1], c[2] - off[2]]);
  const hi = m.corners3.map((c) => [c[0] + off[0], c[1] + off[1], c[2] + off[2]]);
  return { lo, hi };
}

const FACES = [
  ['lo', [0, 1, 2, 3]], ['hi', [0, 1, 2, 3]],
  ['side', [0, 1]], ['side', [1, 2]], ['side', [2, 3]], ['side', [3, 0]],
];

function shade(hex, f) {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.min(255, Math.round(((n >> 16) & 255) * f)), g = Math.min(255, Math.round(((n >> 8) & 255) * f)), b = Math.min(255, Math.round((n & 255) * f));
  return `rgb(${r},${g},${b})`;
}

/**
 * styleOf(member) -> {color, opacity, dash, hidden, outline, label} (all optional; `label`
 *   replaces the member's name on the 3D label, `outline` draws it with a heavy edge)
 * supports: [{key, memberId}] support tools to draw under members
 * labels: show each member's name on the view (with a button to hide them)
 */
export function IsoView({ model, styleOf, onPick, supports = [], className = '', label, labels = true }) {
  const [view, setView] = useState({ az: -32, el: 24 });
  const [showLabels, setShowLabels] = useState(labels);
  const [zoom, setZoom] = useState({ s: 1, ox: 0, oy: 0 }); // scale, and pan offset in drawing units
  const [px, setPx] = useState({ w: 400, h: 300 });
  const dragRef = useRef(null);
  const svgRef = useRef(null);
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  useLayoutEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => { const r = el.getBoundingClientRect(); if (r.width > 0 && r.height > 0) setPx({ w: r.width, h: r.height }); });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const az = (view.az * Math.PI) / 180, el = (view.el * Math.PI) / 180;
  const ca = Math.cos(az), sa = Math.sin(az), ce = Math.cos(el), se = Math.sin(el);
  const proj = ([x, y, z]) => {
    const x1 = x * ca - y * sa, y1 = x * sa + y * ca;
    return { X: x1, Y: -(z * ce + y1 * se), depth: y1 * ce - z * se };
  };
  // Light from the viewer, slightly above.
  const light = (nrm) => {
    const v = [sa * ce, -ca * ce, se]; // toward viewer, roughly
    const l = Math.hypot(...nrm) || 1;
    return 0.75 + 0.35 * Math.abs((nrm[0] * v[0] + nrm[1] * v[1] + nrm[2] * v[2]) / l);
  };

  const faces = [];
  const all = [];
  const tags = [];
  for (const m of model.members) {
    const st = (styleOf && styleOf(m)) || {};
    if (st.hidden) continue;
    tags.push({ m, st, p: proj(m.centroid) });
    const { lo, hi } = prism(m);
    const color = st.color || m.color || PLANE_COLORS[m.plane];
    for (const [kind, idx] of FACES) {
      let pts3;
      if (kind === 'lo') pts3 = idx.map((i) => lo[i]);
      else if (kind === 'hi') pts3 = idx.map((i) => hi[i]);
      else pts3 = [lo[idx[0]], lo[idx[1]], hi[idx[1]], hi[idx[0]]];
      const a = pts3[0], b = pts3[1], c = pts3[2];
      const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      const nrm = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
      const P = pts3.map(proj);
      all.push(...P);
      faces.push({ m, st, P, depth: P.reduce((s, p) => s + p.depth, 0) / P.length, fill: shade(color, light(nrm)) });
    }
  }
  faces.sort((p, q) => q.depth - p.depth);
  const minX = all.length ? Math.min(...all.map((p) => p.X)) : 0, maxX = all.length ? Math.max(...all.map((p) => p.X)) : 100;
  const minY = all.length ? Math.min(...all.map((p) => p.Y)) : 0, maxY = all.length ? Math.max(...all.map((p) => p.Y)) : 50;
  const pad = Math.max(8, (maxX - minX) * 0.06);
  const baseW = maxX - minX + 2 * pad, baseH = maxY - minY + 2 * pad;
  const vbW = baseW / zoom.s, vbH = baseH / zoom.s;
  const cx = (minX + maxX) / 2 + zoom.ox, cy = (minY + maxY) / 2 + zoom.oy;
  const vb = `${cx - vbW / 2} ${cy - vbH / 2} ${vbW} ${vbH}`;
  // Drawing units per screen pixel (the SVG keeps its aspect ratio, so the tighter axis wins).
  const upp = Math.max(vbW / Math.max(1, px.w), vbH / Math.max(1, px.h));

  // Scroll to zoom toward the cursor (non-passive so the page doesn't scroll).
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const onWheel = (e) => {
      e.preventDefault();
      const z = zoomRef.current;
      const r = el.getBoundingClientRect();
      const s = Math.min(14, Math.max(1, z.s * Math.exp(-e.deltaY * 0.0015)));
      if (s === z.s) return;
      // Keep the point under the cursor in place.
      const fx = (e.clientX - r.left) / r.width - 0.5, fy = (e.clientY - r.top) / r.height - 0.5;
      const w0 = baseW / z.s, h0 = baseH / z.s, w1 = baseW / s, h1 = baseH / s;
      const ox = s === 1 ? 0 : z.ox + fx * (w0 - w1), oy = s === 1 ? 0 : z.oy + fy * (h0 - h1);
      setZoom({ s, ox, oy });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [baseW, baseH]);

  // Drag to rotate; a click that didn't move picks the member under the pointer.
  const onDown = (e) => {
    dragRef.current = { x: e.clientX, y: e.clientY, ...view, moved: false, mid: e.target.getAttribute && e.target.getAttribute('data-mid') };
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* synthetic or finished pointer */ }
  };
  const onMove = (e) => {
    const d = dragRef.current;
    if (!d) return;
    if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4) d.moved = true;
    if (d.moved) setView({ az: d.az - (e.clientX - d.x) * 0.4, el: Math.max(-5, Math.min(89, d.el + (e.clientY - d.y) * 0.3)) });
  };
  const onUp = () => {
    const d = dragRef.current;
    dragRef.current = null;
    if (d && !d.moved && d.mid && onPick) { const m = model.memberById.get(d.mid); if (m) onPick(m); }
  };
  const sw = Math.max(0.15, (maxX - minX) / 900) / Math.sqrt(zoom.s);
  // Labels stay ~11 px on screen; ones that would overlap a label in front of them are skipped
  // (zoom in to see them).
  const fs = 11 * upp;
  const shown = [];
  if (showLabels) {
    const placed = [];
    for (const t of [...tags].sort((a, b) => a.p.depth - b.p.depth)) {
      const text = t.st.label || t.m.name;
      const w = text.length * fs * 0.6, h = fs * 1.1;
      const box = [t.p.X - w / 2, t.p.Y - h / 2, t.p.X + w / 2, t.p.Y + h / 2];
      if (placed.some((q) => !(box[2] < q[0] || q[2] < box[0] || box[3] < q[1] || q[3] < box[1]))) continue;
      placed.push(box);
      shown.push({ ...t, text });
    }
  }
  const hidden = showLabels ? tags.length - shown.length : 0;

  return html`<div class=${'iso ' + className}>
    ${label && html`<div class="iso-label">${label}</div>`}
    <svg ref=${svgRef} viewBox=${vb} preserveAspectRatio="xMidYMid meet" onPointerDown=${onDown} onPointerMove=${onMove} onPointerUp=${onUp}>
      ${faces.map(({ m, st, P, fill }, i) => html`<polygon key=${i} points=${P.map((p) => p.X + ',' + p.Y).join(' ')} data-mid=${m.id}
        fill=${fill} stroke=${st.outline || '#1e293b'} stroke-width=${st.outline ? sw * 5 : sw} stroke-opacity=${st.outline ? 1 : 0.5} stroke-dasharray=${st.dash || null}
        opacity=${st.opacity ?? 0.95} style=${onPick ? 'cursor:pointer' : ''}><title>${m.name}</title></polygon>`)}
      ${shown.map(({ m, st, p, text }) => html`<text key=${'lb' + m.id} x=${p.X} y=${p.Y} font-size=${fs} text-anchor="middle" dominant-baseline="middle"
        class="iso-tag" fill=${st.labelColor || '#0f172a'} opacity=${(st.opacity ?? 1) < 0.6 ? 0.55 : 1} stroke-width=${fs * 0.35} pointer-events="none">${text}</text>`)}
      ${model.members.filter((m) => m.bearing).map((m) => { const p = proj(m.bearingPoint); return html`<path key=${'brg' + m.id} d=${`M${p.X} ${p.Y} l-3 5 h6 z`} fill="#f59e0b" />`; })}
      ${supports.map((s) => { const m = model.memberById.get(s.memberId || String(s.nodeId || '').replace(/^sup:/, '')); if (!m) return null; const p = proj(m.bearingPoint); return html`<rect key=${'sup' + s.key} x=${p.X - 2.5} y=${p.Y} width="5" height="9" fill="#14b8a6" opacity="0.85" />`; })}
    </svg>
    ${hidden > 0 && html`<div class="iso-hint">${hidden} name${hidden === 1 ? '' : 's'} hidden where crowded · scroll to zoom in</div>`}
    <div class="iso-controls">
      <button class=${showLabels ? 'on' : ''} title="Show or hide piece names" onClick=${() => setShowLabels(!showLabels)}>Names</button>
      ${zoom.s > 1 && html`<button title="Zoom back out" onClick=${() => setZoom({ s: 1, ox: 0, oy: 0 })}>Fit</button>`}
      <button title="Side view" onClick=${() => setView({ az: 0, el: 0 })}>Side</button>
      <button title="Top view" onClick=${() => setView({ az: 0, el: 89 })}>Top</button>
      <button title="Isometric" onClick=${() => setView({ az: -32, el: 24 })}>Iso</button>
    </div>
  </div>`;
}
