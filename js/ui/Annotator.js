// Mark up a screenshot of the bridge: set its scale, trace the truss lines, group the lines into
// members, mark bolts and bearings. Used for the truss A / truss B side views and the top view.
import { html, useEffect, useMemo, useRef, useState } from '../lib/preact.js';
import { updateProject } from '../model/store.js';
import { uid } from '../model/ids.js';
import { detachSegment, moveSegment, newNode, nextMemberName, removeBolt, removeMember, removeNode, splitSegment } from '../model/edit.js';
import { calibFromPoints, defaultCalib, imageToView, pointSegment, viewToImage } from '../model/geometry.js';
import { imageFileToData, pickFile } from '../model/storage.js';
import { useCamera, gridLines } from './camera.js';
import { isTyping, NumField } from './common.js';

export const PLANE_COLORS = { A: '#2563eb', B: '#16a34a', L: '#9333ea' };
// Distinct colors so neighbouring members are easy to tell apart while grouping.
const GROUP_COLORS = ['#2563eb', '#dc2626', '#16a34a', '#d97706', '#7c3aed', '#0891b2', '#db2777', '#4d7c0f', '#b45309', '#0f766e'];

export const MODES = [
  ['select', 'Select / move', 'V'],
  ['calibrate', 'Set scale', 'S'],
  ['trace', 'Trace lines', 'T'],
  ['group', 'Group into members', 'G'],
  ['bolt', 'Mark bolts', 'B'],
  ['bearing', 'Mark bearings', 'R'],
];

export async function loadViewImage(project, model, viewKey, file) {
  const data = await imageFileToData(file);
  const id = uid('img');
  const xs = [...model.nodes.values()].map((n) => n.x);
  const span = xs.length ? Math.max(...xs) - Math.min(...xs) : 240;
  updateProject((p) => {
    const old = p.design.views[viewKey].imageId;
    p.images = { ...p.images, [id]: data };
    if (old && old !== id) delete p.images[old];
    p.design.views[viewKey] = { ...p.design.views[viewKey], imageId: id, calib: defaultCalib(data, viewKey !== 'top', (span || 240) * 1.1), scaled: false };
  });
}

export function Annotator({ project, model, viewKey, sel, setSel, mode, setMode, group, setGroup }) {
  const d = project.design;
  const view = d.views[viewKey];
  const isTop = viewKey === 'top';
  const flip = !isTop;
  const plane = { sideA: 'A', sideB: 'B', top: 'L' }[viewKey];
  const img = view.imageId ? project.images[view.imageId] : null;

  const [chain, setChain] = useState({ last: null, member: null });
  const [traceAs, setTraceAs] = useState('separate');
  const [cursor, setCursor] = useState(null);
  const [snap, setSnap] = useState(true);
  const [calibPts, setCalibPts] = useState([]);
  const [level, setLevel] = useState(null);
  const [noImage, setNoImage] = useState(false);
  const [dropping, setDropping] = useState(false);
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
  const storedMember = (id) => d.members.find((x) => x.id === id);
  const editableMember = (m) => m.plane === plane && !!storedMember(m.id);

  const bounds = useMemo(() => {
    const pts = viewNodes.map(uv);
    if (img && view.calib) {
      for (const [px, py] of [[0, 0], [img.w, 0], [0, img.h], [img.w, img.h]]) pts.push(imageToView(view.calib, flip, px, py));
    }
    if (!pts.length) return { minU: -12, maxU: 240, minV: -12, maxV: 48 };
    return {
      minU: Math.min(...pts.map((p) => p.u)), maxU: Math.max(...pts.map((p) => p.u)),
      minV: Math.min(...pts.map((p) => p.v)), maxV: Math.max(...pts.map((p) => p.v)),
    };
  }, [viewKey, model, img, view.calib]);
  const cam = useCamera({ flipY: flip, bounds });
  const { toScreen, toWorld, eventPos } = cam;

  useEffect(() => { if (cam.ready) cam.fit(bounds); setChain({ last: null, member: null }); setCalibPts([]); }, [viewKey]);
  // A new screenshot, or a new scale for it, moves everything: zoom to fit again.
  useEffect(() => { if (cam.ready) cam.fit(bounds); }, [view.imageId, view.calib]);
  useEffect(() => { if (mode !== 'trace') setChain({ last: null, member: null }); if (mode !== 'calibrate') setCalibPts([]); }, [mode]);

  const snapV = (x) => (snap ? Math.round(x * 2) / 2 : Math.round(x * 100) / 100);

  // ---- hit testing (screen pixels) ----
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
  const boltUV = (b) => (isTop ? { u: b.pos[0], v: b.pos[1] } : { u: b.pos[0], v: b.pos[2] });
  const hitBolt = (sx, sy) => {
    let best = null;
    for (const b of model.bolts) {
      const m = model.memberById.get(b.memberId);
      if (!m || !viewMembers.includes(m)) continue;
      const p = boltUV(b), s = toScreen(p.u, p.v);
      const dd = Math.hypot(s.x - sx, s.y - sy);
      if (dd < 6 && (!best || dd < best.d)) best = { b, d: dd };
    }
    return best && best.b;
  };
  const hitSegment = (sx, sy, filter = () => true) => {
    let best = null;
    for (const m of viewMembers) {
      if (!filter(m)) continue;
      const raw = storedMember(m.id);
      m.segments.forEach(([a, b]) => {
        const pa = uv(model.nodes.get(a)), pb = uv(model.nodes.get(b));
        const A = toScreen(pa.u, pa.v), B = toScreen(pb.u, pb.v);
        const r = pointSegment({ x: sx, y: sy }, A, B);
        if (r.d < 8 && (!best || r.d < best.d)) {
          const idx = raw ? raw.segments.findIndex(([x, y]) => x === a && y === b) : -1;
          best = { m, d: r.d, idx, t: r.t, seg: [a, b] };
        }
      });
    }
    return best;
  };

  // ---- editing ----
  const makeNode = (p, w) => {
    const n = isTop ? newNode('L', snapV(w.u), snapV(w.v), lvl === 'all' ? 0 : lvl) : newNode(plane, snapV(w.u), plane === 'A' ? 0 : d.trussSpacing, snapV(w.v));
    p.design.nodes.push(n);
    return n.id;
  };

  // Trace: each click is a joint; consecutive joints are joined by a line.
  const traceClick = (sx, sy, w) => {
    const hitN = hitNode(sx, sy, isTop ? atLevel : () => true);
    if (hitN && chain.last === hitN.id) { setChain({ last: null, member: null }); return; }
    let nodeId = hitN && hitN.id;
    let memberId = chain.member;
    updateProject((p) => {
      if (!nodeId) {
        const hitS = hitSegment(sx, sy, editableMember);
        if (hitS && hitS.idx >= 0 && hitS.t > 0.02 && hitS.t < 0.98) {
          // Clicked partway along a traced line: put a joint there.
          const a = model.nodes.get(hitS.seg[0]), b = model.nodes.get(hitS.seg[1]);
          const n = newNode(plane, a.x + (b.x - a.x) * hitS.t, a.y + (b.y - a.y) * hitS.t, a.z + (b.z - a.z) * hitS.t);
          for (const k of ['x', 'y', 'z']) n[k] = Math.round(n[k] * 100) / 100;
          p.design.nodes.push(n);
          splitSegment(p, hitS.m.id, hitS.idx, n.id, hitS.t);
          nodeId = n.id;
        } else nodeId = makeNode(p, w);
      }
      if (chain.last && chain.last !== nodeId) {
        const exists = p.design.members.some((m) => m.segments.some(([a, b]) => (a === chain.last && b === nodeId) || (a === nodeId && b === chain.last)));
        if (!exists) {
          const m = traceAs === 'bent' && memberId ? p.design.members.find((x) => x.id === memberId) : null;
          if (m) m.segments.push([chain.last, nodeId]);
          else {
            memberId = uid('m');
            p.design.members.push({ id: memberId, name: nextMemberName(p, plane), plane, segments: [[chain.last, nodeId]] });
          }
        }
      }
    });
    setChain({ last: nodeId, member: memberId });
    setSel({ type: 'node', id: nodeId });
  };

  const groupClick = (sx, sy) => {
    const hit = hitSegment(sx, sy, editableMember);
    if (!hit || hit.idx < 0) return;
    if (!group || !storedMember(group)) {
      let id = hit.m.id;
      updateProject((p) => { id = detachSegment(p, hit.m.id, hit.idx); });
      setGroup(id);
      setSel({ type: 'member', id });
      return;
    }
    if (hit.m.id === group) {
      // Clicking a line of the current member takes it back out.
      updateProject((p) => { detachSegment(p, group, hit.idx); });
      return;
    }
    updateProject((p) => moveSegment(p, hit.m.id, hit.idx, group));
    setSel({ type: 'member', id: group });
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

  const loadFile = async (file) => {
    if (!file || !file.type.startsWith('image/')) return;
    try {
      await loadViewImage(project, model, viewKey, file);
      setMode('calibrate');
      setNoImage(false);
    } catch (err) {
      alert(err.message);
    }
  };

  useEffect(() => {
    const onKey = (e) => {
      if (isTyping(e)) return;
      const k = e.key.toLowerCase();
      if (e.key === 'Escape') { setChain({ last: null, member: null }); setCalibPts([]); if (mode === 'group') setGroup(null); else setMode('select'); }
      else if (e.key === 'Enter') setChain({ last: null, member: null });
      else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteSelection(); }
      else if (!e.ctrlKey && !e.metaKey && !e.altKey) {
        const m = MODES.find((x) => x[2].toLowerCase() === k);
        if (m) setMode(m[0]);
      }
    };
    const onPaste = (e) => {
      const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'));
      if (item) { e.preventDefault(); loadFile(item.getAsFile()); }
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('paste', onPaste);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('paste', onPaste); };
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
      const m = hitSegment(sx, sy);
      if (m) { setSel({ type: 'member', id: m.m.id }); return; }
      setSel(null);
      cam.beginPan(e);
    } else if (mode === 'trace') {
      traceClick(sx, sy, w);
    } else if (mode === 'group') {
      groupClick(sx, sy);
    } else if (mode === 'bolt') {
      const b = hitBolt(sx, sy);
      if (b) { updateProject((p) => removeBolt(p, b.id)); return; }
      const hit = hitSegment(sx, sy, editableMember);
      if (!hit || hit.idx < 0) return;
      const bolt = { id: uid('b'), memberId: hit.m.id, seg: hit.idx, s: Math.round(hit.t * 1000) / 1000 };
      updateProject((p) => { p.design.bolts.push(bolt); });
      setSel({ type: 'bolt', id: bolt.id });
    } else if (mode === 'bearing') {
      const n = hitNode(sx, sy);
      if (n && editableNode(n)) updateProject((p) => { const x = p.design.nodes.find((q) => q.id === n.id); x.bearing = !x.bearing; });
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

  const applyCalib = () => {
    const c = calibFromPoints(flip, calibPts[0], calibPts[1]);
    if (!c) { alert('Pick two different points.'); return; }
    updateProject((p) => { p.design.views[viewKey] = { ...p.design.views[viewKey], calib: c, scaled: true }; });
    setCalibPts([]);
    setMode('trace');
  };

  // ---- drawing ----
  const imgTransform = useMemo(() => {
    if (!img || !view.calib) return null;
    const f = (px, py) => { const w = imageToView(view.calib, flip, px, py); return toScreen(w.u, w.v); };
    const o = f(0, 0), x = f(1, 0), y = f(0, 1);
    return `matrix(${x.x - o.x} ${x.y - o.y} ${y.x - o.x} ${y.y - o.y} ${o.x} ${o.y})`;
  }, [img, view.calib, cam.cam, cam.size]);

  const k = cam.cam.k;
  const segLine = (key, [a, b], attrs) => {
    const pa = uv(model.nodes.get(a)), pb = uv(model.nodes.get(b));
    const A = toScreen(pa.u, pa.v), B = toScreen(pb.u, pb.v);
    return html`<line key=${key} x1=${A.x} y1=${A.y} x2=${B.x} y2=${B.y} ...${attrs} />`;
  };
  const selected = (type, id) => sel && sel.type === type && sel.id === id;

  const memberEls = [];
  for (const m of ghostMembers) m.segments.forEach((s, i) => memberEls.push(segLine('g' + m.id + i, s, { stroke: '#94a3b8', 'stroke-width': 2, 'stroke-dasharray': '4 3', opacity: 0.6 })));
  viewMembers.forEach((m, mi) => {
    const isTrussInTop = isTop && m.plane !== 'L';
    const width = Math.max(isTrussInTop ? 1.5 : 3, (isTrussInTop ? m.tube.w : m.tube.d) * k);
    let color = m.color || PLANE_COLORS[m.plane];
    if (mode === 'group' && !isTrussInTop) color = GROUP_COLORS[mi % GROUP_COLORS.length];
    else if (!m.box.fits) color = '#dc2626';
    const hl = selected('member', m.id) || (mode === 'group' && group === m.id);
    m.segments.forEach((s, i) => {
      if (hl) memberEls.push(segLine('h' + m.id + i, s, { stroke: '#facc15', 'stroke-width': width + 7, 'stroke-linecap': 'round' }));
      memberEls.push(segLine(m.id + i, s, { stroke: color, 'stroke-width': width, 'stroke-linecap': 'round', opacity: isTrussInTop ? 0.45 : 0.9 }));
    });
    // Label each member in group mode so the split into members is obvious.
    if (mode === 'group' && !isTrussInTop) {
      const c = m.centroid;
      const s = toScreen(c[0], isTop ? c[1] : c[2]);
      memberEls.push(html`<text key=${'l' + m.id} x=${s.x} y=${s.y - 7} font-size="11" text-anchor="middle" fill=${color} font-weight="700" class="halo">${m.name}</text>`);
    }
  });

  const boltEls = model.bolts.filter((b) => viewMembers.includes(model.memberById.get(b.memberId))).map((b) => {
    const s = toScreen(boltUV(b).u, boltUV(b).v);
    const on = selected('bolt', b.id);
    return html`<circle key=${b.id} cx=${s.x} cy=${s.y} r=${on ? 5 : mode === 'bolt' ? 4 : 3.2} fill=${on ? '#facc15' : '#111827'} stroke="#fff" stroke-width="1" />`;
  });

  const nodeEls = viewNodes.map((n) => {
    const p = uv(n), s = toScreen(p.u, p.v);
    const dim = isTop && !atLevel(n);
    const fill = selected('node', n.id) || chain.last === n.id ? '#facc15' : editableNode(n) ? '#fff' : '#e2e8f0';
    const stroke = PLANE_COLORS[n.plane];
    const r = mode === 'bearing' && editableNode(n) ? 7 : dim ? 3 : 5;
    return html`<g key=${n.id} opacity=${dim ? 0.3 : 1}>
      ${n.bearing && !isTop && html`<path d=${`M${s.x} ${s.y} l-9 13 h18 z`} fill="#fde68a" stroke="#92400e" />`}
      <circle cx=${s.x} cy=${s.y} r=${r} fill=${fill} stroke=${stroke} stroke-width="2" />
    </g>`;
  });

  let chainEl = null;
  if (mode === 'trace' && chain.last && cursor && model.nodes.get(chain.last)) {
    const p = uv(model.nodes.get(chain.last)), a = toScreen(p.u, p.v), c = toScreen(cursor.u, cursor.v);
    chainEl = html`<line x1=${a.x} y1=${a.y} x2=${c.x} y2=${c.y} stroke="#f59e0b" stroke-width="3" stroke-dasharray="6 4" />`;
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
  const groupName = group && storedMember(group)?.name;
  const hints = {
    select: 'Click to select; drag a joint to adjust it. Drag empty space to pan, scroll to zoom. Delete removes the selection.',
    calibrate: 'Click two points on the screenshot whose positions you know (the two bearings work well), type their real coordinates in inches, then Apply.',
    trace: 'Click along the bridge lines, joint by joint. Clicking an existing joint connects to it; clicking partway along a line adds a joint there. Click the same joint twice, or press Enter, to lift the pen.',
    group: groupName
      ? `Building ${groupName}: click lines to add them to it, click one of its own lines to take it out. Esc or "New member" starts the next member.`
      : 'Click a line to start a member, then click the other lines that are welded into the same piece. Every member must fit the size box.',
    bolt: 'Click on a member where a bolt goes (near the joint it connects at). Click a bolt to remove it. "Auto-fill" in the checklist adds bolts at every member end.',
    bearing: 'Click the joints that rest on the footings.',
  };

  // Ask for a screenshot until there is one (or this view already has traced members).
  const showDrop = !img && !noImage && !viewMembers.some(editableMember);

  return html`<div class="annotator">
    <div class="toolbar">
      ${MODES.map(([m, label, key], i) => html`<button class=${'step-btn ' + (mode === m ? 'on' : '')} title=${label + ' (' + key + ')'} disabled=${m === 'calibrate' && !img}
        onClick=${() => setMode(m)}>${i > 0 && html`<span class="n">${i}</span>`}${label}</button>`)}
    </div>
    <div class="toolbar sub">
      ${mode === 'trace' && html`<label class="check" title="Separate: every line between two joints starts as its own member (group them later). One bent member: a whole pen stroke is one member.">
        <select value=${traceAs} onChange=${(e) => setTraceAs(e.target.value)}>
          <option value="separate">Each line a separate member</option>
          <option value="bent">Each stroke one member</option>
        </select></label>`}
      ${mode === 'group' && html`<button onClick=${() => setGroup(null)}>New member</button>`}
      ${mode !== 'trace' && mode !== 'group' && html`<span class="muted">${MODES.find((m) => m[0] === mode)?.[1]}</span>`}
      <span class="sep"></span>
      <label class="check"><input type="checkbox" checked=${snap} onChange=${(e) => setSnap(e.target.checked)} /> Snap ½″</label>
      ${isTop && html`<label class="check" title="Which chord level the laterals connect at">Level
        <select value=${String(level ?? lvl)} onChange=${(e) => setLevel(e.target.value === 'all' ? 'all' : parseFloat(e.target.value))}>
          ${levels.map((z) => html`<option value=${String(z)}>z = ${z} in</option>`)}
          <option value="all">All levels</option>
        </select></label>`}
      <span class="spacer"></span>
      ${img && html`<label class="check">Screenshot <input type="range" min="0" max="1" step="0.05" value=${view.opacity}
        onInput=${(e) => updateProject((p) => { p.design.views[viewKey].opacity = parseFloat(e.target.value); }, { key: 'op' + viewKey })} /></label>`}
      <button onClick=${async () => loadFile(await pickFile('image/*'))}>${img ? 'Replace screenshot' : 'Add screenshot'}</button>
      <button onClick=${() => cam.fit(bounds)}>Fit</button>
    </div>
    <div class=${'canvas-wrap' + (dropping ? ' dropping' : '')}
      onDragOver=${(e) => { e.preventDefault(); setDropping(true); }} onDragLeave=${() => setDropping(false)}
      onDrop=${(e) => { e.preventDefault(); setDropping(false); loadFile(e.dataTransfer.files[0]); }}>
      <svg ref=${cam.svgRef} class=${'canvas mode-' + mode} onPointerDown=${onPointerDown} onPointerMove=${onPointerMove} onPointerUp=${onPointerUp}
        onContextMenu=${(e) => e.preventDefault()}>
        <rect x="0" y="0" width=${cam.size.w} height=${cam.size.h} fill="#f8fafc" />
        ${gridLines(cam).map((l, i) => html`<line key=${'g' + i} ...${l} stroke=${l.zero ? '#94a3b8' : l.major ? '#cbd5e1' : '#e2e8f0'} stroke-width=${l.zero ? 1.5 : 1} />`)}
        ${img && imgTransform && html`<image href=${img.url} width=${img.w} height=${img.h} transform=${imgTransform} opacity=${view.opacity} preserveAspectRatio="none" />`}
        <text x=${origin.x + 4} y=${origin.y + (flip ? 14 : -4)} font-size="11" fill="#64748b">0,0</text>
        ${memberEls}${boltEls}${nodeEls}${chainEl}${calibEls}
      </svg>
      <div class="hint-bar">${hints[mode]}${cursor && html`<span class="coords">x ${cursor.u.toFixed(1)} · ${axisV} ${cursor.v.toFixed(1)} in</span>`}</div>
      ${img && !view.scaled && mode !== 'calibrate' && html`<div class="banner warn">The screenshot's scale isn't set yet, so lengths won't be right.
        <button class="small" onClick=${() => setMode('calibrate')}>Set scale</button></div>`}
      ${showDrop && html`<div class="dropzone">
        <div class="dropcard">
          <h3>${isTop ? 'Add a top-view screenshot' : 'Add a side-view screenshot'}</h3>
          <p>${isTop ? 'A plan view from your CAD program, showing the laterals between the two trusses.' : 'A side (elevation) view of one truss from your CAD program.'}</p>
          <p><b>Drag the image here</b>, paste it with <b>Ctrl+V</b>, or</p>
          <button class="primary" onClick=${async () => loadFile(await pickFile('image/*'))}>Choose an image…</button>
          <p class="muted"><a href="#" onClick=${(e) => { e.preventDefault(); setNoImage(true); }}>Trace without a screenshot</a> (type joint coordinates instead)</p>
        </div>
      </div>`}
      ${mode === 'calibrate' && img && html`<div class="float-panel">
        <h4>Set the screenshot's scale</h4>
        ${calibPts.length < 2 && html`<p>Click point ${calibPts.length + 1} of 2 on the screenshot.</p>`}
        ${calibPts.map((pt, i) => html`<div class="row">
          <b>Point ${i + 1}</b>
          <${NumField} label="x" unit="in" value=${pt.u} onChange=${(v) => setCalibPts(calibPts.map((q, j) => (j === i ? { ...q, u: v } : q)))} />
          <${NumField} label=${axisV} unit="in" value=${pt.v} onChange=${(v) => setCalibPts(calibPts.map((q, j) => (j === i ? { ...q, v } : q)))} />
        </div>`)}
        <p class="muted">x runs along the span from the left bearing; ${isTop ? 'y runs across, from truss A (y = 0) to truss B.' : 'z is height above the bearings.'}</p>
        <div class="row"><button class="primary" disabled=${calibPts.length < 2} onClick=${applyCalib}>Apply</button><button onClick=${() => setMode('select')}>Cancel</button></div>
      </div>`}
    </div>
  </div>`;
}
