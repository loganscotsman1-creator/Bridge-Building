// Draw the bridge over a screenshot: nodes (joints), members (chains of segments between nodes)
// and bolts. Used for the truss A / truss B side views and the top view (laterals).
import { html, useEffect, useMemo, useRef, useState } from '../lib/preact.js';
import { updateProject } from '../model/store.js';
import { uid } from '../model/ids.js';
import { nextMemberName, newNode, removeBolt, removeMember, removeNode } from '../model/edit.js';
import { calibFromPoints, defaultCalib, imageToView, pointSegment, viewToImage } from '../model/geometry.js';
import { imageFileToData, pickFile } from '../model/storage.js';
import { useCamera, gridLines } from './camera.js';
import { isTyping, NumField } from './common.js';

export const PLANE_COLORS = { A: '#2563eb', B: '#16a34a', L: '#9333ea' };

const MODES = [
  ['select', 'Select / move', 'V'],
  ['node', 'Add node', 'N'],
  ['member', 'Draw member', 'M'],
  ['bolt', 'Add bolt', 'B'],
  ['calibrate', 'Calibrate image', 'C'],
];

export function Annotator({ project, model, viewKey, sel, setSel }) {
  const d = project.design;
  const view = d.views[viewKey];
  const isTop = viewKey === 'top';
  const flip = !isTop;
  const plane = { sideA: 'A', sideB: 'B', top: 'L' }[viewKey];
  const img = view.imageId ? project.images[view.imageId] : null;

  const [mode, setMode] = useState('select');
  const [chain, setChain] = useState([]);
  const [cursor, setCursor] = useState(null);
  const [snap, setSnap] = useState(true);
  const [calibPts, setCalibPts] = useState([]);
  const [level, setLevel] = useState(null);
  const dragRef = useRef(null);

  const uv = (n) => (isTop ? { u: n.x, v: n.y } : { u: n.x, v: n.z });
  const stored = useMemo(() => new Set(d.nodes.map((n) => n.id)), [d.nodes]);
  const allNodes = [...model.nodes.values()];
  const viewNodes = isTop ? allNodes : allNodes.filter((n) => n.plane === plane);
  const editableNode = (n) => stored.has(n.id) && n.plane === plane;
  const levels = useMemo(() => [...new Set(allNodes.filter((n) => n.plane !== 'L').map((n) => Math.round(n.z * 10) / 10))].sort((a, b) => a - b), [model]);
  const lvl = level ?? (levels.length ? levels[0] : 0);
  const atLevel = (n) => !isTop || level === 'all' || Math.abs(n.z - lvl) < 0.6;
  const viewMembers = isTop ? model.members : model.members.filter((m) => m.plane === plane);
  const ghostMembers = viewKey === 'sideB' ? model.members.filter((m) => m.plane === 'A') : [];
  const editableMember = (m) => m.plane === plane && d.members.some((x) => x.id === m.id);

  const bounds = useMemo(() => {
    const pts = viewNodes.map(uv);
    if (img && view.calib) {
      for (const [px, py] of [[0, 0], [img.w, 0], [0, img.h], [img.w, img.h]]) pts.push(imageToView(view.calib, flip, px, py));
    }
    if (!pts.length) return { minU: -12, maxU: 240, minV: isTop ? -12 : -12, maxV: isTop ? 48 : 48 };
    return {
      minU: Math.min(...pts.map((p) => p.u)), maxU: Math.max(...pts.map((p) => p.u)),
      minV: Math.min(...pts.map((p) => p.v)), maxV: Math.max(...pts.map((p) => p.v)),
    };
  }, [viewKey, model, img, view.calib]);
  const cam = useCamera({ flipY: flip, bounds });
  const { toScreen, toWorld, eventPos } = cam;

  // Re-fit when switching views.
  useEffect(() => { if (cam.ready) cam.fit(bounds); setChain([]); setCalibPts([]); }, [viewKey]);

  const snapV = (x) => (snap ? Math.round(x * 2) / 2 : Math.round(x * 100) / 100);

  const hitNode = (sx, sy, filter = () => true) => {
    let best = null;
    for (const n of viewNodes) {
      if (!filter(n)) continue;
      const p = uv(n), s = toScreen(p.u, p.v);
      const dd = Math.hypot(s.x - sx, s.y - sy);
      if (dd < 9 && (!best || dd < best.d)) best = { n, d: dd };
    }
    return best && best.n;
  };
  const hitBolt = (sx, sy) => {
    let best = null;
    for (const b of model.bolts) {
      const m = model.memberById.get(b.memberId);
      if (!m || !viewMembers.includes(m)) continue;
      const p = isTop ? { u: b.pos[0], v: b.pos[1] } : { u: b.pos[0], v: b.pos[2] };
      const s = toScreen(p.u, p.v);
      const dd = Math.hypot(s.x - sx, s.y - sy);
      if (dd < 6 && (!best || dd < best.d)) best = { b, d: dd };
    }
    return best && best.b;
  };
  const hitMember = (sx, sy, filter = () => true) => {
    let best = null;
    for (const m of viewMembers) {
      if (!filter(m)) continue;
      m.segments.forEach(([a, b], idx) => {
        const pa = uv(model.nodes.get(a)), pb = uv(model.nodes.get(b));
        const A = toScreen(pa.u, pa.v), B = toScreen(pb.u, pb.v);
        const r = pointSegment({ x: sx, y: sy }, A, B);
        if (r.d < 8 && (!best || r.d < best.d)) best = { m, d: r.d, idx, t: r.t, seg: [a, b] };
      });
    }
    return best;
  };

  const addNodeAt = (w) => {
    const n = isTop ? newNode('L', snapV(w.u), snapV(w.v), lvl === 'all' ? 0 : lvl) : newNode(plane, snapV(w.u), plane === 'A' ? 0 : d.trussSpacing, snapV(w.v));
    updateProject((p) => { p.design.nodes.push(n); });
    return n.id;
  };

  const finishChain = (ids = chain) => {
    if (ids.length >= 2) {
      const id = uid('m');
      updateProject((p) => {
        const segments = [];
        for (let i = 1; i < ids.length; i++) segments.push([ids[i - 1], ids[i]]);
        p.design.members.push({ id, name: nextMemberName(p, plane), plane, segments });
      });
      setSel({ type: 'member', id });
    }
    setChain([]);
  };

  const deleteSelection = () => {
    if (!sel) return;
    updateProject((p) => {
      if (sel.type === 'node' && p.design.nodes.some((n) => n.id === sel.id)) removeNode(p, sel.id);
      if (sel.type === 'member' && p.design.members.some((m) => m.id === sel.id)) removeMember(p, sel.id);
      if (sel.type === 'bolt') removeBolt(p, sel.id);
    });
    setSel(null);
  };

  useEffect(() => {
    const onKey = (e) => {
      if (isTyping(e)) return;
      const k = e.key.toLowerCase();
      if (e.key === 'Escape') { setChain([]); setCalibPts([]); setMode('select'); }
      else if (e.key === 'Enter') finishChain();
      else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteSelection(); }
      else if (!e.ctrlKey && !e.metaKey) {
        const m = MODES.find((x) => x[2].toLowerCase() === k);
        if (m) { setMode(m[0]); setChain([]); }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const onPointerDown = (e) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    const { sx, sy } = eventPos(e);
    const w = toWorld(sx, sy);
    if (e.button === 1 || e.button === 2 || e.altKey) { cam.beginPan(e); return; }
    if (mode === 'select') {
      const n = hitNode(sx, sy, atLevel);
      if (n) {
        setSel({ type: 'node', id: n.id });
        if (editableNode(n)) dragRef.current = { id: n.id, key: 'drag-' + uid() };
        return;
      }
      const b = hitBolt(sx, sy);
      if (b) { setSel({ type: 'bolt', id: b.id }); return; }
      const m = hitMember(sx, sy);
      if (m) { setSel({ type: 'member', id: m.m.id }); return; }
      setSel(null);
      cam.beginPan(e);
    } else if (mode === 'node') {
      const n = hitNode(sx, sy, atLevel);
      if (n) setSel({ type: 'node', id: n.id });
      else setSel({ type: 'node', id: addNodeAt(w) });
    } else if (mode === 'member') {
      let n = hitNode(sx, sy, isTop ? atLevel : () => true);
      const id = n ? n.id : addNodeAt(w);
      if (chain.length && chain[chain.length - 1] === id) { finishChain(); return; }
      setChain([...chain, id]);
    } else if (mode === 'bolt') {
      const hit = hitMember(sx, sy, editableMember);
      if (!hit) return;
      const raw = d.members.find((x) => x.id === hit.m.id);
      const idx = raw.segments.findIndex(([a, b]) => a === hit.seg[0] && b === hit.seg[1]);
      const bolt = { id: uid('b'), memberId: hit.m.id, seg: idx, s: Math.round(hit.t * 1000) / 1000 };
      updateProject((p) => { p.design.bolts.push(bolt); });
      setSel({ type: 'bolt', id: bolt.id });
    } else if (mode === 'calibrate') {
      if (!img || !view.calib) return;
      const ip = viewToImage(view.calib, flip, w.u, w.v);
      const pt = { px: ip.px, py: ip.py, u: Math.round(w.u), v: Math.round(w.v) };
      setCalibPts(calibPts.length >= 2 ? [pt] : [...calibPts, pt]);
    }
  };

  const onPointerMove = (e) => {
    const { sx, sy } = eventPos(e);
    const w = toWorld(sx, sy);
    setCursor(w);
    if (cam.movePan(e)) return;
    const drag = dragRef.current;
    if (drag) {
      updateProject((p) => {
        const n = p.design.nodes.find((x) => x.id === drag.id);
        if (!n) return;
        n.x = snapV(w.u);
        if (isTop) n.y = snapV(w.v); else n.z = snapV(w.v);
      }, { key: drag.key });
    }
  };

  const onPointerUp = () => { cam.endPan(); dragRef.current = null; };

  const loadImage = async () => {
    const file = await pickFile('image/*');
    if (!file) return;
    try {
      const data = await imageFileToData(file);
      const id = uid('img');
      const span = model.nodes.size ? Math.max(...allNodes.map((n) => n.x)) - Math.min(...allNodes.map((n) => n.x)) : 240;
      updateProject((p) => {
        const old = p.design.views[viewKey].imageId;
        p.images = { ...p.images, [id]: data };
        if (old && old !== id) delete p.images[old];
        p.design.views[viewKey] = { ...p.design.views[viewKey], imageId: id, calib: defaultCalib(data, flip, (span || 240) * 1.1) };
      });
      cam.fit({ minU: 0, maxU: (span || 240) * 1.1, minV: flip ? 0 : 0, maxV: ((span || 240) * 1.1 * data.h) / data.w });
    } catch (err) {
      alert(err.message);
    }
  };

  const applyCalib = () => {
    const c = calibFromPoints(flip, calibPts[0], calibPts[1]);
    if (!c) { alert('Pick two different points.'); return; }
    updateProject((p) => { p.design.views[viewKey].calib = c; });
    setCalibPts([]);
    setMode('select');
  };

  // ---- drawing ----
  const imgTransform = useMemo(() => {
    if (!img || !view.calib) return null;
    const f = (px, py) => { const w = imageToView(view.calib, flip, px, py); return toScreen(w.u, w.v); };
    const o = f(0, 0), x = f(1, 0), y = f(0, 1);
    return `matrix(${x.x - o.x} ${x.y - o.y} ${y.x - o.x} ${y.y - o.y} ${o.x} ${o.y})`;
  }, [img, view.calib, cam.cam, cam.size]);

  const k = cam.cam.k;
  const segLine = (m, [a, b], i, extra = {}) => {
    const pa = uv(model.nodes.get(a)), pb = uv(model.nodes.get(b));
    const A = toScreen(pa.u, pa.v), B = toScreen(pb.u, pb.v);
    return html`<line key=${m.id + i} x1=${A.x} y1=${A.y} x2=${B.x} y2=${B.y} ...${extra} />`;
  };
  const selected = (type, id) => sel && sel.type === type && sel.id === id;

  const memberEls = [];
  for (const m of ghostMembers) m.segments.forEach((s, i) => memberEls.push(segLine(m, s, i, { stroke: '#94a3b8', 'stroke-width': 2, 'stroke-dasharray': '4 3', opacity: 0.6 })));
  for (const m of viewMembers) {
    const isTrussInTop = isTop && m.plane !== 'L';
    const width = Math.max(isTrussInTop ? 1.5 : 2.5, (isTrussInTop ? m.tube.w : m.tube.d) * k);
    const color = !m.box.fits ? '#dc2626' : m.color || PLANE_COLORS[m.plane];
    const sl = selected('member', m.id);
    m.segments.forEach((s, i) => {
      if (sl) memberEls.push(segLine(m, s, 'h' + i, { stroke: '#facc15', 'stroke-width': width + 6, 'stroke-linecap': 'round' }));
      memberEls.push(segLine(m, s, i, { stroke: color, 'stroke-width': width, 'stroke-linecap': 'round', opacity: isTrussInTop ? 0.45 : 0.9 }));
    });
  }

  const boltEls = model.bolts.filter((b) => viewMembers.includes(model.memberById.get(b.memberId))).map((b) => {
    const p = isTop ? { u: b.pos[0], v: b.pos[1] } : { u: b.pos[0], v: b.pos[2] };
    const s = toScreen(p.u, p.v);
    return html`<circle key=${b.id} cx=${s.x} cy=${s.y} r=${selected('bolt', b.id) ? 5 : 3.2} fill=${selected('bolt', b.id) ? '#facc15' : '#111827'} stroke="#fff" stroke-width="1" />`;
  });

  const nodeEls = viewNodes.map((n) => {
    const p = uv(n), s = toScreen(p.u, p.v);
    const dim = isTop && !atLevel(n);
    const fill = selected('node', n.id) ? '#facc15' : editableNode(n) ? '#fff' : '#e2e8f0';
    const stroke = PLANE_COLORS[n.plane];
    if (n.bearing && !isTop) {
      return html`<g key=${n.id} opacity=${dim ? 0.25 : 1}>
        <path d=${`M${s.x} ${s.y} l-8 12 h16 z`} fill="#fde68a" stroke="#92400e" />
        <circle cx=${s.x} cy=${s.y} r="5" fill=${fill} stroke=${stroke} stroke-width="2" />
      </g>`;
    }
    return html`<circle key=${n.id} cx=${s.x} cy=${s.y} r=${dim ? 3 : 5} fill=${fill} stroke=${stroke} stroke-width="2" opacity=${dim ? 0.3 : 1} />`;
  });

  let chainEl = null;
  if (chain.length && cursor) {
    const pts = chain.map((id) => model.nodes.get(id)).filter(Boolean).map((n) => { const p = uv(n); return toScreen(p.u, p.v); });
    const c = toScreen(cursor.u, cursor.v);
    pts.push(c);
    chainEl = html`<polyline points=${pts.map((p) => p.x + ',' + p.y).join(' ')} fill="none" stroke="#f59e0b" stroke-width="3" stroke-dasharray="6 4" />`;
  }

  const calibEls = calibPts.map((pt, i) => {
    const w = imageToView(view.calib, flip, pt.px, pt.py);
    const s = toScreen(w.u, w.v);
    return html`<g key=${'c' + i}><circle cx=${s.x} cy=${s.y} r="9" fill="none" stroke="#db2777" stroke-width="2" />
      <line x1=${s.x - 14} y1=${s.y} x2=${s.x + 14} y2=${s.y} stroke="#db2777" /><line x1=${s.x} y1=${s.y - 14} x2=${s.x} y2=${s.y + 14} stroke="#db2777" />
      <text x=${s.x + 12} y=${s.y - 10} fill="#db2777" font-size="13" font-weight="700">${i + 1}</text></g>`;
  });

  const origin = toScreen(0, 0);
  const axisV = isTop ? 'y' : 'z';
  const hints = {
    select: 'Click to select. Drag a node to move it. Drag empty space to pan; scroll to zoom. Delete removes the selection.',
    node: 'Click to place a joint. Bearings (where the bridge rests on a footing) are set in the node properties.',
    member: 'Click joints in order to draw one member (it can bend through several joints). Click empty space to add a joint there. Click the last joint again, press Enter or double-click to finish.',
    bolt: 'Click on a member near the joint where the bolt goes. Each bolt belongs to the nearest end joint of that segment.',
    calibrate: 'Click two points you know the coordinates of (e.g. the two bearings), then type their real coordinates in inches and press Apply.',
  };

  return html`<div class="annotator">
    <div class="toolbar">
      ${MODES.map(([m, label, key]) => html`<button class=${mode === m ? 'on' : ''} title=${label + ' (' + key + ')'} disabled=${m === 'calibrate' && !img}
        onClick=${() => { setMode(m); setChain([]); }}>${label}</button>`)}
      <span class="sep"></span>
      <label class="check"><input type="checkbox" checked=${snap} onChange=${(e) => setSnap(e.target.checked)} /> Snap ½″</label>
      ${isTop && html`<label class="check" title="Which chord level you are connecting laterals at">Level
        <select value=${String(level ?? lvl)} onChange=${(e) => setLevel(e.target.value === 'all' ? 'all' : parseFloat(e.target.value))}>
          ${levels.map((z) => html`<option value=${String(z)}>z = ${z} in</option>`)}
          <option value="all">All levels</option>
        </select></label>`}
      <span class="sep"></span>
      <button onClick=${loadImage}>${img ? 'Replace image' : 'Load image'}</button>
      ${img && html`<label class="check">Image <input type="range" min="0" max="1" step="0.05" value=${view.opacity}
        onInput=${(e) => updateProject((p) => { p.design.views[viewKey].opacity = parseFloat(e.target.value); }, { key: 'op' + viewKey })} /></label>`}
      <button onClick=${() => cam.fit(bounds)}>Fit</button>
    </div>
    <div class="canvas-wrap">
      <svg ref=${cam.svgRef} class=${'canvas mode-' + mode} onPointerDown=${onPointerDown} onPointerMove=${onPointerMove} onPointerUp=${onPointerUp}
        onDblClick=${() => mode === 'member' && finishChain()} onContextMenu=${(e) => e.preventDefault()}>
        <rect x="0" y="0" width=${cam.size.w} height=${cam.size.h} fill="#f8fafc" />
        ${gridLines(cam).map((l, i) => html`<line key=${'g' + i} ...${l} stroke=${l.zero ? '#94a3b8' : l.major ? '#cbd5e1' : '#e2e8f0'} stroke-width=${l.zero ? 1.5 : 1} />`)}
        ${img && imgTransform && html`<image href=${img.url} width=${img.w} height=${img.h} transform=${imgTransform} opacity=${view.opacity} preserveAspectRatio="none" />`}
        <text x=${origin.x + 4} y=${origin.y + (flip ? 14 : -4)} font-size="11" fill="#64748b">0,0</text>
        ${memberEls}${boltEls}${nodeEls}${chainEl}${calibEls}
      </svg>
      <div class="hint-bar">${hints[mode]}${cursor && html`<span class="coords">x ${cursor.u.toFixed(1)} · ${axisV} ${cursor.v.toFixed(1)} in</span>`}</div>
      ${mode === 'calibrate' && html`<div class="float-panel">
        <h4>Calibrate image</h4>
        ${calibPts.length < 2 && html`<p>Click point ${calibPts.length + 1} of 2 on the image.</p>`}
        ${calibPts.map((pt, i) => html`<div class="row">
          <b>Point ${i + 1}</b>
          <${NumField} label="x" unit="in" value=${pt.u} onChange=${(v) => setCalibPts(calibPts.map((q, j) => (j === i ? { ...q, u: v } : q)))} />
          <${NumField} label=${axisV} unit="in" value=${pt.v} onChange=${(v) => setCalibPts(calibPts.map((q, j) => (j === i ? { ...q, v } : q)))} />
        </div>`)}
        <div class="row"><button class="primary" disabled=${calibPts.length < 2} onClick=${applyCalib}>Apply</button><button onClick=${() => { setCalibPts([]); setMode('select'); }}>Cancel</button></div>
      </div>`}
    </div>
  </div>`;
}
