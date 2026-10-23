// Simple 3D view of the bridge model (orthographic). Drag to rotate.
import { html, useRef, useState } from '../lib/preact.js';
import { PLANE_COLORS } from './Annotator.js';

/**
 * styleOf(member) -> {color, opacity, width, dash, hidden} (all optional)
 */
export function IsoView({ model, styleOf, onPick, supports = [], className = '', label }) {
  const [view, setView] = useState({ az: -32, el: 24 });
  const dragRef = useRef(null);
  const az = (view.az * Math.PI) / 180, el = (view.el * Math.PI) / 180;
  const ca = Math.cos(az), sa = Math.sin(az), ce = Math.cos(el), se = Math.sin(el);
  const proj = (n) => {
    const x1 = n.x * ca - n.y * sa, y1 = n.x * sa + n.y * ca;
    return { X: x1, Y: -(n.z * ce + y1 * se), depth: y1 * ce - n.z * se };
  };

  const P = new Map();
  for (const [id, n] of model.nodes) P.set(id, proj(n));
  const pts = [...P.values()];
  const minX = pts.length ? Math.min(...pts.map((p) => p.X)) : 0, maxX = pts.length ? Math.max(...pts.map((p) => p.X)) : 100;
  const minY = pts.length ? Math.min(...pts.map((p) => p.Y)) : 0, maxY = pts.length ? Math.max(...pts.map((p) => p.Y)) : 50;
  const pad = Math.max(8, (maxX - minX) * 0.06);
  const vb = `${minX - pad} ${minY - pad} ${maxX - minX + 2 * pad} ${maxY - minY + 2 * pad}`;

  const lines = [];
  for (const m of model.members) {
    const st = (styleOf && styleOf(m)) || {};
    if (st.hidden) continue;
    for (const [a, b] of m.segments) {
      const pa = P.get(a), pb = P.get(b);
      lines.push({ m, pa, pb, st, depth: (pa.depth + pb.depth) / 2 });
    }
  }
  lines.sort((p, q) => q.depth - p.depth);

  const onDown = (e) => { dragRef.current = { x: e.clientX, y: e.clientY, ...view }; e.currentTarget.setPointerCapture(e.pointerId); };
  const onMove = (e) => {
    const d = dragRef.current;
    if (!d) return;
    setView({ az: d.az - (e.clientX - d.x) * 0.4, el: Math.max(-5, Math.min(89, d.el + (e.clientY - d.y) * 0.3)) });
  };
  const onUp = () => { dragRef.current = null; };

  return html`<div class=${'iso ' + className}>
    ${label && html`<div class="iso-label">${label}</div>`}
    <svg viewBox=${vb} preserveAspectRatio="xMidYMid meet" onPointerDown=${onDown} onPointerMove=${onMove} onPointerUp=${onUp}>
      ${lines.map(({ m, pa, pb, st }, i) => html`<line key=${i} x1=${pa.X} y1=${pa.Y} x2=${pb.X} y2=${pb.Y}
        stroke=${st.color || m.color || PLANE_COLORS[m.plane]} stroke-width=${st.width ?? Math.max(0.8, m.tube.d)} stroke-linecap="round"
        stroke-dasharray=${st.dash || null} opacity=${st.opacity ?? 0.9} style=${onPick ? 'cursor:pointer' : ''}
        onClick=${onPick ? () => onPick(m) : null}><title>${m.name}</title></line>`)}
      ${[...model.nodes.values()].filter((n) => n.bearing).map((n) => { const p = P.get(n.id); return html`<path key=${'brg' + n.id} d=${`M${p.X} ${p.Y + 1} l-3 5 h6 z`} fill="#f59e0b" />`; })}
      ${supports.map((s) => { const p = P.get(s.nodeId); return p && html`<g key=${'sup' + s.key}><rect x=${p.X - 2.5} y=${p.Y + 0.5} width="5" height="9" fill="#14b8a6" opacity="0.85" /></g>`; })}
    </svg>
    <div class="iso-controls">
      <button title="Side view" onClick=${() => setView({ az: 0, el: 0 })}>Side</button>
      <button title="Top view" onClick=${() => setView({ az: 0, el: 89 })}>Top</button>
      <button title="Isometric" onClick=${() => setView({ az: -32, el: 24 })}>Iso</button>
    </div>
  </div>`;
}
