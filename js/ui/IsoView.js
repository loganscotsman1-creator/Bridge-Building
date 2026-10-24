// Simple 3D view of the bridge model (orthographic), each member drawn as its box. Drag to rotate.
import { html, useRef, useState } from '../lib/preact.js';
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
 * styleOf(member) -> {color, opacity, dash, hidden} (all optional)
 * supports: [{key, memberId}] support tools to draw under members
 */
export function IsoView({ model, styleOf, onPick, supports = [], className = '', label }) {
  const [view, setView] = useState({ az: -32, el: 24 });
  const dragRef = useRef(null);
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
  for (const m of model.members) {
    const st = (styleOf && styleOf(m)) || {};
    if (st.hidden) continue;
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
  const vb = `${minX - pad} ${minY - pad} ${maxX - minX + 2 * pad} ${maxY - minY + 2 * pad}`;

  const onDown = (e) => { dragRef.current = { x: e.clientX, y: e.clientY, ...view }; try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* synthetic or finished pointer */ } };
  const onMove = (e) => {
    const d = dragRef.current;
    if (!d) return;
    setView({ az: d.az - (e.clientX - d.x) * 0.4, el: Math.max(-5, Math.min(89, d.el + (e.clientY - d.y) * 0.3)) });
  };
  const onUp = () => { dragRef.current = null; };
  const sw = Math.max(0.15, (maxX - minX) / 900);

  return html`<div class=${'iso ' + className}>
    ${label && html`<div class="iso-label">${label}</div>`}
    <svg viewBox=${vb} preserveAspectRatio="xMidYMid meet" onPointerDown=${onDown} onPointerMove=${onMove} onPointerUp=${onUp}>
      ${faces.map(({ m, st, P, fill }, i) => html`<polygon key=${i} points=${P.map((p) => p.X + ',' + p.Y).join(' ')}
        fill=${fill} stroke="#1e293b" stroke-width=${sw} stroke-opacity="0.5" stroke-dasharray=${st.dash || null}
        opacity=${st.opacity ?? 0.95} style=${onPick ? 'cursor:pointer' : ''} onClick=${onPick ? () => onPick(m) : null}><title>${m.name}</title></polygon>`)}
      ${model.members.filter((m) => m.bearing).map((m) => { const p = proj(m.bearingPoint); return html`<path key=${'brg' + m.id} d=${`M${p.X} ${p.Y} l-3 5 h6 z`} fill="#f59e0b" />`; })}
      ${supports.map((s) => { const m = model.memberById.get(s.memberId || String(s.nodeId || '').replace(/^sup:/, '')); if (!m) return null; const p = proj(m.bearingPoint); return html`<rect key=${'sup' + s.key} x=${p.X - 2.5} y=${p.Y} width="5" height="9" fill="#14b8a6" opacity="0.85" />`; })}
    </svg>
    <div class="iso-controls">
      <button title="Side view" onClick=${() => setView({ az: 0, el: 0 })}>Side</button>
      <button title="Top view" onClick=${() => setView({ az: 0, el: 89 })}>Top</button>
      <button title="Isometric" onClick=${() => setView({ az: -32, el: 24 })}>Iso</button>
    </div>
  </div>`;
}
