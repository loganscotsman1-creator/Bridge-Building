// Timeline: one lane per builder showing what they're doing over time. Click to jump there. With
// `onEdit`, a support or "other task" bar's right end can be dragged to change how long it lasts,
// and clicking a bar selects its step.
import { html, useLayoutEffect, useRef, useState } from '../lib/preact.js';
import { SEGMENT_KINDS, fmt } from '../sim/simulate.js';

const LANE = 26, LEFT = 110, TOP = 20;

export function Gantt({ result, t, setT, onEdit = null, onSelect = null, selected = null, compact = false }) {
  const ref = useRef(null);
  const [w, setW] = useState(900);
  const [drag, setDrag] = useState(null); // {seg, t1}: a bar being resized
  useLayoutEffect(() => {
    const ro = new ResizeObserver(() => ref.current && setW(ref.current.clientWidth));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  const end = Math.max(1, result.endTime);
  const sx = (time) => LEFT + (time / end) * (w - LEFT - 12);
  const toTime = (e) => {
    const r = ref.current.getBoundingClientRect();
    return ((e.clientX - r.left - LEFT) / (w - LEFT - 12)) * end;
  };
  const h = TOP + result.builders.length * LANE + 6;
  const step = [5, 10, 15, 30, 60, 120, 300, 600].find((s) => (end / s) * 60 < w) || 600;
  const ticks = [];
  for (let s = 0; s <= end; s += step) ticks.push(s);
  const lane = new Map(result.builders.map((b, i) => [b.id, i]));

  const seek = (e) => {
    const x = e.clientX - ref.current.getBoundingClientRect().left;
    if (x < LEFT) return;
    setT(Math.max(0, Math.min(end, toTime(e))));
  };
  const onDown = (e) => {
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* synthetic or finished pointer */ }
    const handle = e.target.getAttribute && e.target.getAttribute('data-handle');
    if (handle != null && onEdit) { setDrag({ seg: result.segments[+handle], t1: result.segments[+handle].t1 }); return; }
    const bar = e.target.getAttribute && e.target.getAttribute('data-seg');
    if (bar != null && onSelect && result.segments[+bar].taskId) onSelect(result.segments[+bar].taskId);
    seek(e);
  };
  const onMove = (e) => {
    if (drag) { setDrag({ ...drag, t1: Math.max(drag.seg.t0 + 0.5, toTime(e)) }); return; }
    if (e.buttons) seek(e);
  };
  const onUp = () => {
    if (!drag) return;
    const secs = Math.round((drag.t1 - drag.seg.t0) * 10) / 10;
    onEdit(drag.seg.taskId, drag.seg.kind === 'hold' ? { until: secs } : { duration: secs });
    setDrag(null);
  };

  return html`<div class=${'gantt' + (compact ? ' compact' : '')} ref=${ref}>
    <svg width=${w} height=${h} onPointerDown=${onDown} onPointerMove=${onMove} onPointerUp=${onUp}>
      ${ticks.map((s) => html`<g key=${'t' + s}><line x1=${sx(s)} y1=${TOP - 4} x2=${sx(s)} y2=${h} stroke="#e2e8f0" />
        <text x=${sx(s)} y=${12} font-size="10" text-anchor="middle" fill="#64748b">${fmt(s).replace(/\.\d$/, '')}</text></g>`)}
      ${result.builders.map((b, i) => html`<g key=${b.id}>
        <rect x="0" y=${TOP + i * LANE} width=${w} height=${LANE} fill=${i % 2 ? '#f8fafc' : '#fff'} />
        <circle cx="10" cy=${TOP + i * LANE + LANE / 2} r="5" fill=${b.color} />
        <text x="20" y=${TOP + i * LANE + LANE / 2 + 4} font-size="12" fill="#111827">${b.name}</text>
      </g>`)}
      ${result.segments.map((s, i) => {
        const laneY = TOP + lane.get(s.builderId) * LANE;
        // Something done at the same time as the main task sits in the lower half of the lane.
        const y = s.along ? laneY + LANE / 2 : laneY + 4;
        const barH = s.along ? LANE / 2 - 2 : LANE - 8;
        const resizing = drag && drag.seg === s;
        const x0 = sx(s.t0), x1 = Math.max(x0 + 1, sx(resizing ? drag.t1 : s.t1));
        const kind = SEGMENT_KINDS[s.kind] || SEGMENT_KINDS.wait;
        const isSel = selected && s.taskId === selected;
        const stroke = isSel ? '#1d4ed8' : s.holding ? '#f97316' : s.open ? '#dc2626' : 'none';
        return html`<g key=${i}><rect data-seg=${i} x=${x0} y=${y} width=${x1 - x0} height=${barH} fill=${kind.color}
          stroke=${stroke} stroke-width=${stroke === 'none' ? 0 : 2} style=${onSelect && s.taskId ? 'cursor:pointer' : ''}>
          <title>${(s.label || kind.label) + '  ' + fmt(s.t0) + ' – ' + fmt(resizing ? drag.t1 : s.t1) + ' (' + ((resizing ? drag.t1 : s.t1) - s.t0).toFixed(1) + ' s)'}${s.resizable && onEdit ? '\nDrag the right end to change how long this lasts' : ''}</title></rect>
          ${s.resizable && onEdit && s.taskId && html`<rect data-handle=${i} class="g-handle" x=${x1 - 3} y=${y} width="6" height=${barH} fill="#0f172a" fill-opacity="0.55"><title>Drag to change how long this lasts</title></rect>`}
          ${resizing && html`<text x=${x1 + 4} y=${y + barH - 4} font-size="11" font-weight="700" fill="#0f172a" class="halo">${(drag.t1 - s.t0).toFixed(1)} s</text>`}</g>`;
      })}
      <line x1=${sx(t)} y1="0" x2=${sx(t)} y2=${h} stroke="#dc2626" stroke-width="2" pointer-events="none" />
    </svg>
    ${!compact && html`<div class="legend">${Object.entries(SEGMENT_KINDS).map(([k, v]) => html`<span key=${k}><i style=${{ background: v.color }}></i>${v.label}</span>`)}</div>`}
  </div>`;
}
