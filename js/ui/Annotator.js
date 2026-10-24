// Mark up a screenshot of the bridge with box members: every member is a box outline no bigger
// than the rule's size box, and everything inside a box is one rigid, welded piece. Boxes snap
// edge-to-edge; bolts go anywhere two boxes touch. Used for the side view(s) and the top view.
import { html, useEffect, useMemo, useRef, useState } from '../lib/preact.js';
import { updateProject } from '../model/store.js';
import { uid } from '../model/ids.js';
import { boxLimits } from '../model/schema.js';
import { clampBox, duplicateMember, newBox, removeBolt, removeMember } from '../model/edit.js';
import { boxAxes, boxCorners, calibFromPoints, defaultCalib, distToSegment2, imageToView, pointInPoly, viewToImage } from '../model/geometry.js';
import { imageFileToData, pickFile } from '../model/storage.js';
import { snapAngle, snapBox, snapSize } from './snap.js';
import { useCamera, gridLines } from './camera.js';
import { isTyping, NumField } from './common.js';

export const PLANE_COLORS = { A: '#2563eb', B: '#16a34a', L: '#9333ea' };
const MEMBER_COLORS = ['#2563eb', '#dc2626', '#16a34a', '#d97706', '#7c3aed', '#0891b2', '#db2777', '#4d7c0f', '#b45309', '#0f766e'];

export const MODES = [
  ['select', 'Select / move', 'V'],
  ['calibrate', 'Set scale', 'S'],
  ['box', 'Place member boxes', 'M'],
  ['bolt', 'Place bolts', 'B'],
  ['bearing', 'Mark footing supports', 'F'],
];

// Distance from a box's fixed edge (opposite the one being dragged) to point w, along the drag axis.
function resizeProj(o, kind, sign, w) {
  const { d: dir, n } = boxAxes(o);
  const ax = kind === 'len' ? dir : n;
  const half = (kind === 'len' ? o.len : o.depth) / 2;
  const fixed = [o.u - ax[0] * half * sign, o.v - ax[1] * half * sign];
  return ((w.u - fixed[0]) * ax[0] + (w.v - fixed[1]) * ax[1]) * sign;
}

export async function loadViewImage(project, model, viewKey, file) {
  const data = await imageFileToData(file);
  const id = uid('img');
  updateProject((p) => {
    const old = p.design.views[viewKey].imageId;
    p.images = { ...p.images, [id]: data };
    if (old && old !== id) delete p.images[old];
    p.design.views[viewKey] = { ...p.design.views[viewKey], imageId: id, calib: defaultCalib(data, viewKey !== 'top', 276 * 1.1), scaled: false };
  });
}

export function Annotator({ project, model, viewKey, sel, setSel, mode, setMode }) {
  const d = project.design;
  const view = d.views[viewKey];
  const isTop = viewKey === 'top';
  const flip = !isTop;
  const plane = { sideA: 'A', sideB: 'B', top: 'L' }[viewKey];
  const img = view.imageId ? project.images[view.imageId] : null;
  const lim = boxLimits(project);

  const [cursor, setCursor] = useState(null);
  const [snapOn, setSnapOn] = useState(true);
  const [calibPts, setCalibPts] = useState([]);
  const [noImage, setNoImage] = useState(false);
  const [dropping, setDropping] = useState(false);
  const [guides, setGuides] = useState([]);
  const [hoverContact, setHoverContact] = useState(null);
  const [draft, setDraft] = useState(null); // box being drawn in box mode
  const [lastShape, setLastShape] = useState({ angle: 0, depth: lim.depth, thick: lim.thick });
  const [level, setLevel] = useState(null);
  const dragRef = useRef(null);

  const stored = (id) => d.members.find((x) => x.id === id);
  const editable = (m) => m.plane === plane && !!stored(m.id);
  const viewMembers = isTop ? model.members : model.members.filter((m) => m.plane === plane);
  const ghosts = viewKey === 'sideB' ? model.members.filter((m) => m.plane === 'A') : [];
  const outline = (m) => (isTop && m.plane !== 'L' ? m.footprint : m.poly);
  const contacts = model.contacts.filter((c) => c.plane === plane);
  const levels = useMemo(() => {
    const zs = new Set();
    for (const m of model.members) if (m.plane !== 'L') zs.add(Math.round(m.v * 4) / 4);
    return [...zs].sort((a, b) => a - b);
  }, [model]);
  const lateralZ = level ?? (levels[0] ?? 0);

  const bounds = useMemo(() => {
    const pts = viewMembers.flatMap((m) => outline(m).map(([u, v]) => ({ u, v })));
    if (img && view.calib) for (const [px, py] of [[0, 0], [img.w, 0], [0, img.h], [img.w, img.h]]) pts.push(imageToView(view.calib, flip, px, py));
    if (!pts.length) return { minU: -12, maxU: 288, minV: -12, maxV: 48 };
    return { minU: Math.min(...pts.map((p) => p.u)), maxU: Math.max(...pts.map((p) => p.u)), minV: Math.min(...pts.map((p) => p.v)), maxV: Math.max(...pts.map((p) => p.v)) };
  }, [viewKey, model, img, view.calib]);
  const cam = useCamera({ flipY: flip, bounds });
  const { toScreen, toWorld, eventPos } = cam;
  const k = cam.cam.k;
  const tolW = 10 / k; // 10 screen pixels in inches

  useEffect(() => { if (cam.ready) cam.fit(bounds); setCalibPts([]); setDraft(null); }, [viewKey]);
  useEffect(() => { if (cam.ready) cam.fit(bounds); }, [view.imageId, view.calib]);
  useEffect(() => { if (mode !== 'calibrate') setCalibPts([]); if (mode !== 'box') setDraft(null); setHoverContact(null); }, [mode]);

  const snapTargets = (exceptId) => [
    ...viewMembers.filter((m) => m.id !== exceptId && !(m.mirrorOf && m.mirrorOf === exceptId)).map(outline),
    ...ghosts.map((m) => m.poly),
  ];
  const memberAngles = (exceptId) => viewMembers.filter((m) => m.id !== exceptId).map((m) => ({ angle: m.angle }));

  // ---- hit testing (screen pixels) ----
  const S = (p) => toScreen(p[0], p[1]);
  const hitMember = (sx, sy, filter = () => true) => {
    const w = toWorld(sx, sy);
    const p = [w.u, w.v];
    // Prefer the smallest box under the cursor (so a short box on top of a long one can be grabbed).
    let best = null;
    for (const m of viewMembers) {
      if (!filter(m)) continue;
      const poly = outline(m);
      if (!pointInPoly(p, poly, 3 / k)) continue;
      const area = m.plane === 'L' || !isTop ? m.len * m.depth : 1e9;
      if (!best || area < best.area) best = { m, area };
    }
    return best && best.m;
  };
  const hitBolt = (sx, sy) => {
    let best = null;
    for (const b of model.bolts) {
      if (b.plane !== plane) continue;
      const s = toScreen(b.u, b.v);
      const dd = Math.hypot(s.x - sx, s.y - sy);
      if (dd < 7 && (!best || dd < best.d)) best = { b, d: dd };
    }
    return best && best.b;
  };
  const hitContact = (w) => {
    let best = null;
    for (const c of contacts) {
      let dd, at;
      if (c.kind === 'edge') {
        const r = distToSegment2([w.u, w.v], c.seg[0], c.seg[1]);
        dd = r.d; at = r.q;
      } else {
        dd = pointInPoly([w.u, w.v], c.poly) ? 0 : Infinity;
        at = [w.u, w.v];
      }
      if (dd <= 12 / k && (!best || dd < best.d)) best = { c, d: dd, at };
    }
    return best;
  };
  const handleAt = (m, sx, sy) => {
    if (!m || !editable(m)) return null;
    for (const h of handles(m)) {
      const s = S(h.p);
      if (Math.hypot(s.x - sx, s.y - sy) < 9) return h;
    }
    return null;
  };
  // Handles sit just outside the box's edges so grabbing the middle of even a small box moves it.
  function handles(m) {
    const { d: dir, n } = boxAxes(m);
    const at = (s, t) => [m.u + dir[0] * s + n[0] * t, m.v + dir[1] * s + n[1] * t];
    const out = 8 / k;
    return [
      { kind: 'len', sign: 1, p: at(m.len / 2 + out, 0) },
      { kind: 'len', sign: -1, p: at(-m.len / 2 - out, 0) },
      { kind: 'depth', sign: 1, p: at(0, m.depth / 2 + out) },
      { kind: 'depth', sign: -1, p: at(0, -m.depth / 2 - out) },
      { kind: 'rotate', p: at(m.len / 2 + 26 / k, 0) },
    ];
  }

  // ---- editing ----
  const selMember = sel && sel.type === 'member' ? model.memberById.get(sel.id) : null;

  const setBox = (id, patch, key) => updateProject((p) => {
    const m = p.design.members.find((x) => x.id === id);
    if (!m) return;
    Object.assign(m, patch);
    clampBox(p, m);
    for (const f of ['u', 'v', 'angle', 'len', 'depth']) m[f] = Math.round(m[f] * 1000) / 1000;
  }, { key });

  const deleteSelection = () => {
    if (!sel) return;
    updateProject((p) => {
      if (sel.type === 'member' && p.design.members.some((m) => m.id === sel.id)) removeMember(p, sel.id);
      if (sel.type === 'bolt') removeBolt(p, sel.id);
    });
    setSel(null);
  };

  const duplicate = () => {
    if (!selMember || !editable(selMember)) return;
    const { n } = boxAxes(selMember);
    let id = null;
    updateProject((p) => { id = duplicateMember(p, selMember.id, n[0] * selMember.depth, n[1] * selMember.depth); });
    if (id) setSel({ type: 'member', id });
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
      const key = e.key.toLowerCase();
      if (e.key === 'Escape') { setCalibPts([]); setDraft(null); setMode('select'); return; }
      if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteSelection(); return; }
      if ((e.ctrlKey || e.metaKey) && key === 'd') { e.preventDefault(); duplicate(); return; }
      if (selMember && editable(selMember) && e.key.startsWith('Arrow')) {
        e.preventDefault();
        const step = e.shiftKey ? 1 : 0.25;
        const du = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
        const dv = (e.key === 'ArrowUp' ? step : e.key === 'ArrowDown' ? -step : 0) * (flip ? 1 : -1);
        setBox(selMember.id, { u: selMember.u + du, v: selMember.v + dv }, 'nudge' + selMember.id);
        return;
      }
      if (selMember && editable(selMember) && key === 'r' && !e.ctrlKey) { setBox(selMember.id, { angle: (selMember.angle + 90) % 360 }); return; }
      if (!e.ctrlKey && !e.metaKey && !e.altKey) {
        const m = MODES.find((x) => x[2].toLowerCase() === key);
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
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* synthetic or finished pointer */ }
    const { sx, sy } = eventPos(e);
    const w = toWorld(sx, sy);
    if (e.button === 1 || e.button === 2 || e.altKey) { cam.beginPan(e); return; }
    if (mode === 'select') {
      const h = handleAt(selMember, sx, sy);
      if (h) {
        const orig = { ...stored(selMember.id) };
        // Remember how far outside the edge the handle was grabbed so the edge doesn't jump.
        const grab = h.kind === 'rotate' ? 0 : resizeProj(orig, h.kind, h.sign, w) - (h.kind === 'len' ? orig.len : orig.depth);
        dragRef.current = { kind: h.kind, sign: h.sign, id: selMember.id, orig, grab, key: 'drag-' + uid() };
        return;
      }
      const b = hitBolt(sx, sy);
      if (b) { setSel({ type: 'bolt', id: b.id }); return; }
      const m = hitMember(sx, sy);
      if (m) {
        setSel({ type: 'member', id: m.id });
        if (editable(m)) dragRef.current = { kind: 'move', id: m.id, orig: { ...stored(m.id) }, start: w, key: 'drag-' + uid() };
        return;
      }
      setSel(null);
      cam.beginPan(e);
    } else if (mode === 'box') {
      setDraft({ start: w, end: w });
    } else if (mode === 'bolt') {
      const b = hitBolt(sx, sy);
      if (b) { updateProject((p) => removeBolt(p, b.id)); return; }
      const hit = hitContact(w);
      if (!hit) return;
      const c = hit.c;
      if (!stored(c.a) && !stored(c.b)) { alert('This connection is on the mirror-copy truss. Place the bolt on the matching connection in truss A.'); return; }
      let [u, v] = hit.at;
      if (snapOn && c.kind === 'edge') {
        // Snap along the edge to ¼ in steps from its start.
        const [p, q] = c.seg;
        const L = Math.hypot(q[0] - p[0], q[1] - p[1]);
        const t = L ? Math.round((Math.hypot(u - p[0], v - p[1]) * 4)) / 4 / L : 0;
        u = p[0] + (q[0] - p[0]) * Math.min(1, t); v = p[1] + (q[1] - p[1]) * Math.min(1, t);
      }
      const bolt = { id: uid('b'), plane, a: c.a, b: c.b, u: Math.round(u * 100) / 100, v: Math.round(v * 100) / 100 };
      updateProject((p) => { p.design.bolts.push(bolt); });
      setSel({ type: 'bolt', id: bolt.id });
    } else if (mode === 'bearing') {
      const m = hitMember(sx, sy, editable);
      if (m && !isTop) updateProject((p) => { const x = p.design.members.find((q) => q.id === m.id); x.bearing = !x.bearing; });
    } else if (mode === 'calibrate') {
      if (!img || !view.calib) return;
      const ip = viewToImage(view.calib, flip, w.u, w.v);
      const pt = { px: ip.px, py: ip.py, u: Math.round(w.u), v: Math.round(w.v) };
      setCalibPts(calibPts.length >= 2 ? [pt] : [...calibPts, pt]);
    }
  };

  // The box a drag in box mode would create.
  const draftBox = (dr) => {
    const du = dr.end.u - dr.start.u, dv = dr.end.v - dr.start.v;
    const dist = Math.hypot(du, dv);
    const base = { plane, depth: lastShape.depth, thick: lastShape.thick, z: isTop ? lateralZ : 0 };
    if (dist * k < 6) {
      // A click: stamp a full-length box centered here at the last angle used.
      return { ...base, u: dr.start.u, v: dr.start.v, angle: lastShape.angle, len: lim.len };
    }
    const len = Math.min(lim.len, dist);
    const ang = (Math.atan2(dv, du) * 180) / Math.PI;
    const a = (ang * Math.PI) / 180;
    return { ...base, u: dr.start.u + Math.cos(a) * len / 2, v: dr.start.v + Math.sin(a) * len / 2, angle: ang, len, tooLong: dist > lim.len + 1e-6 };
  };

  const onPointerMove = (e) => {
    const { sx, sy } = eventPos(e);
    const w = toWorld(sx, sy);
    setCursor(w);
    if (cam.movePan(e)) return;
    if (mode === 'bolt') { const h = hitContact(w); setHoverContact(h ? h.c.id : null); }
    if (mode === 'box' && draft) { setDraft({ ...draft, end: w }); return; }
    const drag = dragRef.current;
    if (!drag) return;
    const o = drag.orig;
    if (drag.kind === 'move') {
      let box = { ...o, u: o.u + (w.u - drag.start.u), v: o.v + (w.v - drag.start.v) };
      let lines = [];
      if (snapOn && !e.shiftKey) ({ box, lines } = snapBox(box, snapTargets(o.id), tolW));
      setGuides(lines);
      setBox(o.id, { u: box.u, v: box.v, angle: box.angle }, drag.key);
    } else if (drag.kind === 'rotate') {
      let ang = (Math.atan2(w.v - o.v, w.u - o.u) * 180) / Math.PI;
      if (snapOn && !e.shiftKey) ang = snapAngle(ang, memberAngles(o.id));
      setBox(o.id, { angle: ang }, drag.key);
    } else {
      // Resize: the opposite edge stays where it is; the box can only be as big as the rules allow.
      const { d: dir, n } = boxAxes(o);
      const ax = drag.kind === 'len' ? dir : n;
      const half = (drag.kind === 'len' ? o.len : o.depth) / 2;
      const fixed = [o.u - ax[0] * half * drag.sign, o.v - ax[1] * half * drag.sign];
      let size = resizeProj(o, drag.kind, drag.sign, w) - (drag.grab || 0);
      const max = drag.kind === 'len' ? lim.len : lim.depth;
      size = Math.max(drag.kind === 'len' ? 0.5 : 0.25, Math.min(max, size));
      if (snapOn && !e.shiftKey) size = Math.min(max, snapSize(o, drag.kind, drag.sign, size, snapTargets(o.id), tolW));
      const c = [fixed[0] + ax[0] * size / 2 * drag.sign, fixed[1] + ax[1] * size / 2 * drag.sign];
      setBox(o.id, { u: c[0], v: c[1], [drag.kind]: size }, drag.key);
    }
  };

  const onPointerUp = () => {
    cam.endPan();
    if (dragRef.current) { dragRef.current = null; setGuides([]); }
    if (mode === 'box' && draft) {
      let box = draftBox(draft);
      if (snapOn) box = snapBox(box, snapTargets(null), tolW).box;
      let id = null;
      updateProject((p) => {
        const m = newBox(p, plane, box.u, box.v, box.angle, { len: box.len, depth: box.depth, thick: box.thick, z: box.z });
        clampBox(p, m);
        p.design.members.push(m);
        id = m.id;
      });
      setLastShape({ angle: box.angle, depth: box.depth, thick: box.thick });
      setSel({ type: 'member', id });
      setDraft(null);
    }
  };

  const applyCalib = () => {
    const c = calibFromPoints(flip, calibPts[0], calibPts[1]);
    if (!c) { alert('Pick two different points.'); return; }
    updateProject((p) => { p.design.views[viewKey] = { ...p.design.views[viewKey], calib: c, scaled: true }; });
    setCalibPts([]);
    setMode('box');
  };

  // ---- drawing ----
  const imgTransform = useMemo(() => {
    if (!img || !view.calib) return null;
    const f = (px, py) => { const q = imageToView(view.calib, flip, px, py); return toScreen(q.u, q.v); };
    const o = f(0, 0), x = f(1, 0), y = f(0, 1);
    return `matrix(${x.x - o.x} ${x.y - o.y} ${y.x - o.x} ${y.y - o.y} ${o.x} ${o.y})`;
  }, [img, view.calib, cam.cam, cam.size]);

  const pts = (poly) => poly.map((p) => { const s = S(p); return s.x + ',' + s.y; }).join(' ');
  const isSel = (type, id) => sel && sel.type === type && sel.id === id;

  const memberEls = [];
  for (const m of ghosts) memberEls.push(html`<polygon key=${'g' + m.id} points=${pts(m.poly)} fill="none" stroke="#94a3b8" stroke-dasharray="4 3" />`);
  viewMembers.forEach((m, i) => {
    const truss = isTop && m.plane !== 'L';
    const color = !m.box.fits ? '#dc2626' : m.color || (mode === 'box' || mode === 'select' ? MEMBER_COLORS[i % MEMBER_COLORS.length] : PLANE_COLORS[m.plane]);
    const on = isSel('member', m.id);
    memberEls.push(html`<polygon key=${m.id} points=${pts(outline(m))} fill=${color} fill-opacity=${truss ? 0.12 : on ? 0.35 : 0.2}
      stroke=${on ? '#f59e0b' : color} stroke-width=${on ? 3 : truss ? 1 : 1.6} stroke-dasharray=${m.mirrorOf ? '5 3' : null} />`);
    if (!truss && k * m.len > 60) {
      const c = S([m.u, m.v]);
      memberEls.push(html`<text key=${'t' + m.id} x=${c.x} y=${c.y + 4} font-size="11" text-anchor="middle" fill=${color} font-weight="700" class="halo" pointer-events="none">${m.name}</text>`);
    }
    if (m.bearing && !isTop) {
      const s = toScreen(m.bearingPoint[0], m.bearingPoint[2]);
      memberEls.push(html`<path key=${'brg' + m.id} d=${`M${s.x} ${s.y} l-9 13 h18 z`} fill="#fde68a" stroke="#92400e" />`);
    }
  });

  const contactEls = contacts.map((c) => {
    const show = mode === 'bolt' || c.bolts === 0;
    if (!show && mode !== 'select') return null;
    const hot = hoverContact === c.id;
    const color = c.bolts ? '#16a34a' : '#ea580c';
    if (c.kind === 'edge') {
      const a = S(c.seg[0]), b = S(c.seg[1]);
      return html`<line key=${c.id} x1=${a.x} y1=${a.y} x2=${b.x} y2=${b.y} stroke=${color} stroke-width=${hot ? 7 : mode === 'bolt' ? 4 : 2.5} stroke-linecap="round" opacity=${mode === 'bolt' || hot ? 0.9 : 0.6} stroke-dasharray=${c.bolts ? null : '3 3'} />`;
    }
    return html`<polygon key=${c.id} points=${pts(c.poly)} fill=${color} fill-opacity=${hot ? 0.45 : mode === 'bolt' ? 0.3 : 0.15} stroke=${color} stroke-width=${hot ? 2 : 1} />`;
  });

  const boltEls = model.bolts.filter((b) => b.plane === plane).map((b) => {
    const s = toScreen(b.u, b.v);
    const on = isSel('bolt', b.id);
    return html`<circle key=${b.id} cx=${s.x} cy=${s.y} r=${on ? 5.5 : 4} fill=${!b.jointId ? '#dc2626' : on ? '#facc15' : '#111827'} stroke="#fff" stroke-width="1.2"><title>${b.jointId ? 'Bolt' : 'Bolt not on a connection'}</title></circle>`;
  });

  let handleEls = null;
  if (mode === 'select' && selMember && editable(selMember)) {
    const hs = handles(selMember);
    const c = S([selMember.u, selMember.v]), r = S(hs[4].p), f = S(hs[0].p);
    handleEls = html`<g>
      <line x1=${f.x} y1=${f.y} x2=${r.x} y2=${r.y} stroke="#f59e0b" stroke-width="1.5" />
      ${hs.slice(0, 4).map((h, i) => { const s = S(h.p); return html`<rect key=${i} x=${s.x - 5} y=${s.y - 5} width="10" height="10" fill="#fff" stroke="#f59e0b" stroke-width="2" style=${'cursor:' + (h.kind === 'len' ? 'ew-resize' : 'ns-resize')} />`; })}
      <circle cx=${r.x} cy=${r.y} r="6" fill="#f59e0b" stroke="#fff" stroke-width="2" style="cursor:grab" />
      <text x=${c.x} y=${c.y - 10} font-size="11" text-anchor="middle" fill="#92400e" class="halo" pointer-events="none">${selMember.len.toFixed(2)} × ${selMember.depth.toFixed(2)} in</text>
    </g>`;
  }

  let draftEl = null;
  if (mode === 'box') {
    const box = draft ? draftBox(draft) : cursor ? { u: cursor.u, v: cursor.v, angle: lastShape.angle, len: lim.len, depth: lastShape.depth } : null;
    if (box) {
      const poly = boxCorners(box);
      draftEl = html`<g pointer-events="none">
        <polygon points=${pts(poly)} fill="#f59e0b" fill-opacity="0.15" stroke=${box.tooLong ? '#dc2626' : '#f59e0b'} stroke-width="2" stroke-dasharray="6 4" />
        ${draft && html`<text x=${S([box.u, box.v]).x} y=${S([box.u, box.v]).y - 10} font-size="11" text-anchor="middle" fill="#92400e" class="halo">${box.len.toFixed(1)} in${box.tooLong ? ' (max)' : ''}</text>`}
      </g>`;
    }
  }

  const guideEls = guides.map(([a, b], i) => { const p = S(a), q = S(b); return html`<line key=${'gd' + i} x1=${p.x} y1=${p.y} x2=${q.x} y2=${q.y} stroke="#ec4899" stroke-width="2" pointer-events="none" />`; });

  const calibEls = calibPts.map((pt, i) => {
    const q = imageToView(view.calib, flip, pt.px, pt.py);
    const s = toScreen(q.u, q.v);
    return html`<g key=${'c' + i}><circle cx=${s.x} cy=${s.y} r="9" fill="none" stroke="#db2777" stroke-width="2" />
      <line x1=${s.x - 14} y1=${s.y} x2=${s.x + 14} y2=${s.y} stroke="#db2777" /><line x1=${s.x} y1=${s.y - 14} x2=${s.x} y2=${s.y + 14} stroke="#db2777" />
      <text x=${s.x + 12} y=${s.y - 10} fill="#db2777" font-size="13" font-weight="700">${i + 1}</text></g>`;
  });

  const origin = toScreen(0, 0);
  const axisV = isTop ? 'y' : 'z';
  const hints = {
    select: 'Drag a box to move it (it snaps to neighbouring edges; hold Shift to place freely). Drag the square handles to shorten or narrow it, the round one to rotate. Arrow keys nudge, R turns 90°, Ctrl+D copies, Delete removes.',
    calibrate: 'Click two points on the screenshot whose positions you know (the outer edges of the footings work well), type their real coordinates in inches, then Apply.',
    box: `Drag along a member in the screenshot to place a box over it, or click to stamp a full ${lim.len} × ${lim.depth} in box. Everything inside one box is one welded member. Boxes snap edge-to-edge.`,
    bolt: 'Green lines and areas are where two boxes touch. Click on one to put a bolt there; click a bolt to remove it. Orange = touching with no bolt yet.',
    bearing: 'Click the members that stand on a footing (their lowest point rests on it).',
  };
  const editableHere = viewMembers.filter(editable);
  const showDrop = !img && !noImage && !editableHere.length;

  return html`<div class="annotator">
    <div class="toolbar" data-tour="modes">
      ${MODES.map(([m, label, key], i) => (isTop && m === 'bearing') ? null : html`<button class=${'step-btn ' + (mode === m ? 'on' : '')} title=${label + ' (' + key + ')'} disabled=${m === 'calibrate' && !img}
        onClick=${() => setMode(m)}>${i > 0 && html`<span class="n">${i}</span>`}${label}</button>`)}
    </div>
    <div class="toolbar sub">
      ${mode === 'box' && html`<span class="muted">New boxes: ${lim.len} in max long ·</span>
        <label class="check">depth <input type="number" class="tiny" min="0.25" max=${lim.depth} step="0.25" value=${lastShape.depth}
          onInput=${(e) => { const v = parseFloat(e.target.value); if (v > 0) setLastShape({ ...lastShape, depth: Math.min(lim.depth, v) }); }} /> in</label>
        <label class="check" title="Size out of the view (thickness)">thick <input type="number" class="tiny" min="0.125" max=${lim.thick} step="0.125" value=${lastShape.thick}
          onInput=${(e) => { const v = parseFloat(e.target.value); if (v > 0) setLastShape({ ...lastShape, thick: Math.min(lim.thick, v) }); }} /> in</label>`}
      ${mode === 'select' && selMember && editable(selMember) && html`<button onClick=${duplicate}>Copy box</button>
        <button onClick=${() => setBox(selMember.id, { angle: (selMember.angle + 90) % 360 })}>Turn 90°</button>
        <button class="danger" onClick=${deleteSelection}>Delete</button>`}
      ${isTop && (mode === 'box' || mode === 'select') && html`<label class="check" title="Height of new laterals' centerline">Lateral height
        <select value=${String(lateralZ)} onChange=${(e) => setLevel(parseFloat(e.target.value))}>
          ${levels.map((z) => html`<option value=${String(z)}>z = ${z} in</option>`)}
        </select></label>`}
      <label class="check" title="Snap boxes to neighbouring edges and bolts to ¼ in steps"><input type="checkbox" checked=${snapOn} onChange=${(e) => setSnapOn(e.target.checked)} /> Snap</label>
      <span class="spacer"></span>
      ${img && html`<label class="check">Screenshot <input type="range" min="0" max="1" step="0.05" value=${view.opacity}
        onInput=${(e) => updateProject((p) => { p.design.views[viewKey].opacity = parseFloat(e.target.value); }, { key: 'op' + viewKey })} /></label>`}
      <button onClick=${async () => loadFile(await pickFile('image/*'))}>${img ? 'Replace screenshot' : 'Add screenshot'}</button>
      <button onClick=${() => cam.fit(bounds)}>Fit</button>
    </div>
    <div class=${'canvas-wrap' + (dropping ? ' dropping' : '')} data-tour="canvas"
      onDragOver=${(e) => { e.preventDefault(); setDropping(true); }} onDragLeave=${() => setDropping(false)}
      onDrop=${(e) => { e.preventDefault(); setDropping(false); loadFile(e.dataTransfer.files[0]); }}>
      <svg ref=${cam.svgRef} class=${'canvas mode-' + mode} onPointerDown=${onPointerDown} onPointerMove=${onPointerMove} onPointerUp=${onPointerUp}
        onPointerLeave=${() => { setCursor(null); setHoverContact(null); }} onContextMenu=${(e) => e.preventDefault()}>
        <rect x="0" y="0" width=${cam.size.w} height=${cam.size.h} fill="#f8fafc" />
        ${gridLines(cam).map((l, i) => html`<line key=${'g' + i} ...${l} stroke=${l.zero ? '#94a3b8' : l.major ? '#cbd5e1' : '#e2e8f0'} stroke-width=${l.zero ? 1.5 : 1} />`)}
        ${img && imgTransform && html`<image href=${img.url} width=${img.w} height=${img.h} transform=${imgTransform} opacity=${view.opacity} preserveAspectRatio="none" />`}
        <text x=${origin.x + 4} y=${origin.y + (flip ? 14 : -4)} font-size="11" fill="#64748b">0,0</text>
        ${memberEls}${contactEls}${boltEls}${guideEls}${handleEls}${draftEl}${calibEls}
      </svg>
      <div class="hint-bar">${hints[mode]}${cursor && html`<span class="coords">x ${cursor.u.toFixed(1)} · ${axisV} ${cursor.v.toFixed(1)} in</span>`}</div>
      ${img && !view.scaled && mode !== 'calibrate' && html`<div class="banner warn">The screenshot's scale isn't set yet, so box sizes won't match it.
        <button class="small" onClick=${() => setMode('calibrate')}>Set scale</button></div>`}
      ${showDrop && html`<div class="dropzone">
        <div class="dropcard">
          <h3>${isTop ? 'Add a top-view screenshot' : 'Add a side-view screenshot'}</h3>
          <p>${isTop ? 'A plan view from your CAD program, showing the laterals between the two trusses.' : 'A side (elevation) view of one truss from your CAD program.'}</p>
          <p><b>Drag the image here</b>, paste it with <b>Ctrl+V</b>, or</p>
          <button class="primary" onClick=${async () => loadFile(await pickFile('image/*'))}>Choose an image…</button>
          <p class="muted"><a href="#" onClick=${(e) => { e.preventDefault(); setNoImage(true); }}>Place boxes without a screenshot</a></p>
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
        <p class="muted">x runs along the span from the west footing's outer edge; ${isTop ? 'y runs across, from truss A (y = 0) to truss B.' : 'z is height above the footings.'}</p>
        <div class="row"><button class="primary" disabled=${calibPts.length < 2} onClick=${applyCalib}>Apply</button><button onClick=${() => setMode('select')}>Cancel</button></div>
      </div>`}
    </div>
  </div>`;
}
