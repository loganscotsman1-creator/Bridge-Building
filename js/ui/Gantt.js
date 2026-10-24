// Timeline: one lane per builder showing what they're doing over time. Click to jump there.
import { html, useLayoutEffect, useRef, useState } from '../lib/preact.js';
import { SEGMENT_KINDS, fmt } from '../sim/simulate.js';

const LANE = 26, LEFT = 110, TOP = 20;

export function Gantt({ result, t, setT }) {
  const ref = useRef(null);
  const [w, setW] = useState(900);
  useLayoutEffect(() => {
    const ro = new ResizeObserver(() => ref.current && setW(ref.current.clientWidth));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  const end = Math.max(1, result.endTime);
  const sx = (time) => LEFT + (time / end) * (w - LEFT - 12);
  const h = TOP + result.builders.length * LANE + 6;
  const step = [5, 10, 15, 30, 60, 120, 300, 600].find((s) => (end / s) * 60 < w) || 600;
  const ticks = [];
  for (let s = 0; s <= end; s += step) ticks.push(s);
  const lane = new Map(result.builders.map((b, i) => [b.id, i]));

  const seek = (e) => {
    const r = ref.current.getBoundingClientRect();
    const x = e.clientX - r.left;
    if (x < LEFT) return;
    setT(Math.max(0, Math.min(end, ((x - LEFT) / (w - LEFT - 12)) * end)));
  };

  return html`<div class="gantt" ref=${ref}>
    <svg width=${w} height=${h} onPointerDown=${(e) => { try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* synthetic or finished pointer */ } seek(e); }} onPointerMove=${(e) => e.buttons && seek(e)}>
      ${ticks.map((s) => html`<g key=${'t' + s}><line x1=${sx(s)} y1=${TOP - 4} x2=${sx(s)} y2=${h} stroke="#e2e8f0" />
        <text x=${sx(s)} y=${12} font-size="10" text-anchor="middle" fill="#64748b">${fmt(s).replace(/\.\d$/, '')}</text></g>`)}
      ${result.builders.map((b, i) => html`<g key=${b.id}>
        <rect x="0" y=${TOP + i * LANE} width=${w} height=${LANE} fill=${i % 2 ? '#f8fafc' : '#fff'} />
        <circle cx="10" cy=${TOP + i * LANE + LANE / 2} r="5" fill=${b.color} />
        <text x="20" y=${TOP + i * LANE + LANE / 2 + 4} font-size="12" fill="#111827">${b.name}</text>
      </g>`)}
      ${result.segments.map((s, i) => {
        const y = TOP + lane.get(s.builderId) * LANE + 4;
        const x0 = sx(s.t0), x1 = Math.max(x0 + 1, sx(s.t1));
        const kind = SEGMENT_KINDS[s.kind] || SEGMENT_KINDS.wait;
        return html`<rect key=${i} x=${x0} y=${y} width=${x1 - x0} height=${LANE - 8} fill=${kind.color}
          stroke=${s.holding ? '#f97316' : s.open ? '#dc2626' : 'none'} stroke-width=${s.holding || s.open ? 2 : 0}>
          <title>${(s.label || kind.label) + '  ' + fmt(s.t0) + ' – ' + fmt(s.t1) + ' (' + (s.t1 - s.t0).toFixed(1) + ' s)'}</title></rect>`;
      })}
      <line x1=${sx(t)} y1="0" x2=${sx(t)} y2=${h} stroke="#dc2626" stroke-width="2" />
    </svg>
    <div class="legend">${Object.entries(SEGMENT_KINDS).map(([k, v]) => html`<span key=${k}><i style=${{ background: v.color }}></i>${v.label}</span>`)}</div>
  </div>`;
}
