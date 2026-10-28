// Mark up a screenshot of the bridge with box members: every member is a box outline no bigger
// than the rule's size box, and everything inside a box is one rigid, welded piece. One tool
// does it all: drag on empty space to draw a box, grab a box to move it, drag its edge handles to
// push/pull its length and width, drag its corner nodes to reshape it (it must still fit the size
// box), and the round handle to rotate it. Boxes snap edge-to-edge; bolts go anywhere two boxes
// touch. Used for the side view(s) and the top view.
import { html, useEffect, useMemo, useRef, useState } from '../lib/preact.js';
import { updateProject } from '../model/store.js';
import { uid } from '../model/ids.js';
import { boxLimits } from '../model/schema.js';
import { clampBox, duplicateMember, newBox, removeBolt, removeMember } from '../model/edit.js';
import {
  boxAxes, boxCorners, calibFromPoints, defaultCalib, distToSegment2, footingPoints, imageToView, isSimple, memberPoly,
  pointInPoly, pointOnContact, polyArea, polyCentroid, polyEdges, polyFits, siteToBridge, viewToImage,
} from '../model/geometry.js';
import { imageFileToData, pickFile } from '../model/storage.js';
import { applySnap, rotatePoly, snapAngle, snapBox, snapPoint, snapPoly, snapSize } from './snap.js';
import { useCamera, gridLines } from './camera.js';
import { isTyping, NumField } from './common.js';

export const PLANE_COLORS = { A: '#2563eb', B: '#16a34a', L: '#9333ea' };
const MEMBER_COLORS = ['#2563eb', '#dc2626', '#16a34a', '#d97706', '#7c3aed', '#0891b2', '#db2777', '#4d7c0f', '#b45309', '#0f766e'];

export const MODES = [
  ['calibrate', 'Set scale', 'S'],
  ['box', 'Member boxes', 'M'],
  ['bolt', 'Bolts', 'B'],
  ['bearing', 'Footing supports', 'F'],
];

// Rectangle edges → what pushing/pulling them changes: 0 bottom side, 1 front end, 2 top side, 3 back end.
const RECT_EDGE = [{ kind: 'depth', sign: -1 }, { kind: 'len', sign: 1 }, { kind: 'depth', sign: 1 }, { kind: 'len', sign: -1 }];

export function ftIn(inches) {
  if (inches == null || !Number.isFinite(inches)) return '–';
  const ft = Math.floor(inches / 12 + 1e-9);
  const rest = Math.round((inches - ft * 12) * 100) / 100;
  return `${ft}'-${rest}"`;
}

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

// Asked once, before any screenshot or box: how far apart the bridge's footing supports are.
function FootingSetup({ project }) {
  const guess = footingPoints(project, null).span;
  const [ft, setFt] = useState(Math.floor(guess / 12));
  const [inch, setInch] = useState(Math.round((guess - Math.floor(guess / 12) * 12) * 100) / 100);
  const total = (Number(ft) || 0) * 12 + (Number(inch) || 0);
  const site = project.site;
  const feet = site.zones.filter((z) => z.type === 'footing');
  return html`<div class="dropzone"><div class="dropcard setup">
    <h3>First: how far apart are your footing supports?</h3>
    <p>The distance between the points where your bridge stands on the two footings (for example, between pier centers). When you load a screenshot you'll click those two points, and the screenshot will be scaled to match.</p>
    <div class="row center">
      <label class="check"><input type="number" min="0" step="1" value=${ft} onInput=${(e) => setFt(e.target.value)} class="tiny" /> ft</label>
      <label class="check"><input type="number" min="0" max="11.99" step="0.25" value=${inch} onInput=${(e) => setInch(e.target.value)} class="tiny" /> in</label>
      <span class="muted">= ${Math.round(total * 100) / 100} in</span>
    </div>
    ${feet.length >= 2 && html`<p class="muted">On this year's site the footings are ${ftIn(feet[0].w)} long; their outer edges are ${ftIn(feet[feet.length - 1].x + feet[feet.length - 1].w - feet[0].x)} apart, so supports can be about ${ftIn(feet[feet.length - 1].x - (feet[0].x + feet[0].w))} to ${ftIn(feet[feet.length - 1].x + feet[feet.length - 1].w - feet[0].x)} apart. Your supports are centered on the footings.</p>`}
    <button class="primary" disabled=${!(total > 12)} onClick=${() => updateProject((p) => { p.design.footingSpan = total; })}>Continue</button>
  </div></div>`;
}

export function Annotator({ project, model, viewKey, sel, setSel, mode, setMode }) {
  const d = project.design;
  const view = d.views[viewKey];
  const isTop = viewKey === 'top';
  const flip = !isTop;
  const plane = { sideA: 'A', sideB: 'B', top: 'L' }[viewKey];
  const img = view.imageId ? project.images[view.imageId] : null;
  const lim = boxLimits(project);
  const fp = footingPoints(project);

  const [cursor, setCursor] = useState(null);
  const [snapOn, setSnapOn] = useState(true);
  const [calibPts, setCalibPts] = useState([]);
  const [calibMethod, setCalibMethod] = useState('footings');
  const [noImage, setNoImage] = useState(false);
  const [dropping, setDropping] = useState(false);
  const [guides, setGuides] = useState([]);
  const [hoverContact, setHoverContact] = useState(null);
  const [draft, setDraft] = useState(null); // box being drawn
  const [badShape, setBadShape] = useState(null); // corners the user tried that don't fit
  const [lastShape, setLastShape] = useState({ angle: 0, depth: lim.depth, thick: lim.thick });
  const [level, setLevel] = useState(null);
  const dragRef = useRef(null);
  const spaceRef = useRef(false);

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

  // Footings drawn in this view (in its own coordinates), from the site layout.
  const footings = useMemo(() => {
    const out = [];
    for (const z of project.site.zones.filter((q) => q.type === 'footing')) {
      const pts = [[z.x, z.y], [z.x + z.w, z.y], [z.x + z.w, z.y + z.h], [z.x, z.y + z.h]].map(([x, y]) => siteToBridge(project.site, x, y));
      const x0 = Math.min(...pts.map((p) => p.x)), x1 = Math.max(...pts.map((p) => p.x));
      const y0 = Math.min(...pts.map((p) => p.y)), y1 = Math.max(...pts.map((p) => p.y));
      out.push(isTop ? [[x0, y0], [x1, y0], [x1, y1], [x0, y1]] : [[x0, -3], [x1, -3], [x1, 0], [x0, 0]]);
    }
    return out;
  }, [project.site, isTop]);

  const bounds = useMemo(() => {
    const pts = viewMembers.flatMap((m) => outline(m).map(([u, v]) => ({ u, v })));
    for (const f of footings) for (const [u, v] of f) pts.push({ u, v });
    if (img && view.calib) for (const [px, py] of [[0, 0], [img.w, 0], [0, img.h], [img.w, img.h]]) pts.push(imageToView(view.calib, flip, px, py));
    if (!pts.length) return { minU: -12, maxU: 288, minV: -12, maxV: 48 };
    return { minU: Math.min(...pts.map((p) => p.u)), maxU: Math.max(...pts.map((p) => p.u)), minV: Math.min(...pts.map((p) => p.v)), maxV: Math.max(...pts.map((p) => p.v)) };
  }, [viewKey, model, img, view.calib, footings]);
  const cam = useCamera({ flipY: flip, bounds });
  const { toScreen, toWorld, eventPos } = cam;
  const k = cam.cam.k;
  const tolW = 12 / k; // 12 screen pixels, in inches

  useEffect(() => { if (cam.ready) cam.fit(bounds); setCalibPts([]); setDraft(null); }, [viewKey]);
  // Re-fit only when the screenshot or its scale really changes. (Every edit copies the project,
  // so compare the calibration's numbers, not the object, or each edit would zoom back out.)
  const calibKey = view.calib ? [...view.calib.a, ...view.calib.b].join(',') : '';
  useEffect(() => { if (cam.ready) cam.fit(bounds); }, [view.imageId, calibKey]);
  useEffect(() => { if (mode !== 'calibrate') setCalibPts([]); setDraft(null); setHoverContact(null); }, [mode]);

  const snapTargets = (exceptId) => [
    ...viewMembers.filter((m) => m.id !== exceptId && !(m.mirrorOf && m.mirrorOf === exceptId)).map(outline),
    ...ghosts.map((m) => m.poly),
    ...(isTop ? [] : footings),
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
      if (!pointInPoly(p, outline(m), 3 / k)) continue;
      const area = m.plane === 'L' || !isTop ? Math.abs(polyArea(m.poly)) : 1e9;
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
        dd = pointOnContact(c, [w.u, w.v]) ? 0 : Infinity;
        at = [w.u, w.v];
      }
      if (dd <= 12 / k && (!best || dd < best.d)) best = { c, d: dd, at };
    }
    return best;
  };

  // Handles of the selected box: corner nodes, a "+" node in the middle of each edge (drag it to
  // add a corner there), edge push/pull handles just outside each edge's middle (so grabbing the
  // middle of a small box still moves it), and a rotate handle.
  function handles(m) {
    const poly = m.poly;
    const sign = polyArea(poly) >= 0 ? 1 : -1;
    const out = 9 / k;
    const hs = poly.map((p, i) => ({ kind: 'corner', i, p }));
    polyEdges(poly).forEach(([a, b], i) => {
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      const n = [((b[1] - a[1]) / L) * sign, (-(b[0] - a[0]) / L) * sign];
      hs.push({ kind: 'edge', i, n, p: [(a[0] + b[0]) / 2 + n[0] * out, (a[1] + b[1]) / 2 + n[1] * out] });
      if (L * k > 28) hs.push({ kind: 'insert', i, p: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] });
    });
    const front = hs.find((h) => h.kind === 'edge' && h.i === 1);
    hs.push({ kind: 'rotate', p: [front.p[0] + front.n[0] * (18 / k), front.p[1] + front.n[1] * (18 / k)] });
    return hs;
  }
  const handleAt = (m, sx, sy) => {
    if (!m || !editable(m)) return null;
    let best = null;
    for (const h of handles(m)) {
      const s = S(h.p);
      const dd = Math.hypot(s.x - sx, s.y - sy);
      if (dd < 9 && (!best || dd < best.d)) best = { h, d: dd };
    }
    return best && best.h;
  };

  // ---- editing ----
  const selMember = sel && sel.type === 'member' ? model.memberById.get(sel.id) : null;

  const setBox = (id, patch, key) => updateProject((p) => {
    const m = p.design.members.find((x) => x.id === id);
    if (!m) return;
    Object.assign(m, patch);
    if (!m.corners) {
      clampBox(p, m);
      for (const f of ['u', 'v', 'angle', 'len', 'depth']) m[f] = Math.round(m[f] * 1000) / 1000;
    } else {
      m.corners = m.corners.map(([u, v]) => [Math.round(u * 1000) / 1000, Math.round(v * 1000) / 1000]);
    }
  }, { key });

  // The selected lateral's height (top view): it's set apart from its outline, so it can be
  // raised or lowered any time after placing it.
  const selLateral = isTop && selMember && selMember.plane === 'L' && editable(selMember) ? selMember : null;
  const setLateralZ = (z) => {
    if (!selLateral) return;
    const id = selLateral.id;
    updateProject((p) => { const m = p.design.members.find((x) => x.id === id); if (m) m.z = Math.round(z * 1000) / 1000; }, { key: 'lz' + id });
  };

  // A reshaped box is accepted only if it's still a proper (convex) shape inside the size box.
  const shapeOk = (poly) => isSimple(poly) && polyFits(poly, lim) && Math.abs(polyArea(poly)) > 0.05;

  // Double-click a corner node to remove it (a shape keeps at least 3).
  const removeNode = (m, i) => {
    const raw = stored(m.id);
    const poly = memberPoly(raw);
    if (poly.length <= 3) return;
    const next = poly.filter((_, j) => j !== i);
    if (shapeOk(next)) setBox(raw.id, { corners: next });
  };
  const onDoubleClick = (e) => {
    if (mode !== 'box' || !selMember) return;
    const { sx, sy } = eventPos(e);
    const h = handleAt(selMember, sx, sy);
    if (h && h.kind === 'corner') removeNode(selMember, h.i);
  };

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

  const turn90 = (m) => {
    const raw = stored(m.id);
    if (raw.corners) setBox(m.id, { corners: rotatePoly(raw.corners, 90, polyCentroid(raw.corners)) });
    else setBox(m.id, { angle: (raw.angle + 90) % 360 });
  };

  const loadFile = async (file) => {
    if (!file || !file.type.startsWith('image/')) return;
    try {
      await loadViewImage(project, model, viewKey, file);
      setCalibMethod('footings');
      setMode('calibrate');
      setNoImage(false);
    } catch (err) {
      alert(err.message);
    }
  };

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === ' ' && !isTyping(e)) { spaceRef.current = e.type === 'keydown'; if (e.type === 'keydown') e.preventDefault(); return; }
      if (e.type !== 'keydown' || isTyping(e)) return;
      const key = e.key.toLowerCase();
      if (e.key === 'Escape') {
        setCalibPts([]);
        if (draft) setDraft(null);
        else if (mode !== 'box') setMode('box');
        else setSel(null);
        return;
      }
      if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteSelection(); return; }
      if ((e.ctrlKey || e.metaKey) && key === 'd') { e.preventDefault(); duplicate(); return; }
      if (selMember && editable(selMember) && e.key.startsWith('Arrow')) {
        e.preventDefault();
        const step = e.shiftKey ? 1 : 0.25;
        const du = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
        const dv = (e.key === 'ArrowUp' ? step : e.key === 'ArrowDown' ? -step : 0) * (flip ? 1 : -1);
        const raw = stored(selMember.id);
        if (raw.corners) setBox(raw.id, { corners: raw.corners.map(([u, v]) => [u + du, v + dv]) }, 'nudge' + raw.id);
        else setBox(raw.id, { u: raw.u + du, v: raw.v + dv }, 'nudge' + raw.id);
        return;
      }
      if (selLateral && (e.key === 'PageUp' || e.key === 'PageDown')) {
        e.preventDefault();
        setLateralZ(stored(selLateral.id).z + (e.key === 'PageUp' ? 1 : -1) * (e.shiftKey ? 1 : 0.25));
        return;
      }
      if (selMember && editable(selMember) && key === 'r' && !e.ctrlKey) { turn90(selMember); return; }
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
    window.addEventListener('keyup', onKey);
    window.addEventListener('paste', onPaste);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('keyup', onKey); window.removeEventListener('paste', onPaste); };
  });

  // The box a drag would create, already snapped (length to a perpendicular edge, then edges).
  const draftBox = (dr, snap = snapOn) => {
    const du = dr.end.u - dr.start.u, dv = dr.end.v - dr.start.v;
    const dist = Math.hypot(du, dv);
    const base = { plane, depth: lastShape.depth, thick: lastShape.thick, z: isTop ? lateralZ : 0 };
    let box, lines = [];
    if (dist * k < 6) {
      // A click: stamp a full-length box centered here at the last angle used.
      box = { ...base, u: dr.start.u, v: dr.start.v, angle: lastShape.angle, len: lim.len };
    } else {
      let ang = (Math.atan2(dv, du) * 180) / Math.PI;
      // Square up to neighbours' angles or 15° steps (exactly vertical, horizontal, 45°…).
      if (snap) ang = snapAngle(ang, memberAngles(null), 4);
      const a = (ang * Math.PI) / 180;
      let len = Math.min(lim.len, dist);
      const tmp = { ...base, u: dr.start.u + Math.cos(a) * len / 2, v: dr.start.v + Math.sin(a) * len / 2, angle: ang, len };
      if (snap) len = Math.min(lim.len, snapSize(tmp, 'len', 1, len, snapTargets(null), tolW));
      box = { ...base, u: dr.start.u + Math.cos(a) * len / 2, v: dr.start.v + Math.sin(a) * len / 2, angle: ang, len, tooLong: dist > lim.len + 1e-6 };
    }
    if (snap) {
      const s = snapBox(box, snapTargets(null), tolW);
      box = { ...s.box, tooLong: box.tooLong };
      lines = s.lines;
    }
    return { box, lines };
  };

  // Dragging a piece near the canvas edge scrolls the view that way, so it can be carried past
  // what's on screen. The timer replays the last pointer move against the moved view.
  const moveRef = useRef(null);
  const lastMoveRef = useRef(null);
  const midPanRef = useRef(false);
  const draftRef = useRef(null);
  const edgeRef = useRef(null);
  const stopEdgePan = () => { if (edgeRef.current) { clearInterval(edgeRef.current.timer); edgeRef.current = null; } };
  const edgePan = (sx, sy) => {
    const { w, h } = cam.size, band = 28, speed = 12;
    const vx = sx < band ? -1 : sx > w - band ? 1 : 0, vy = sy < band ? -1 : sy > h - band ? 1 : 0;
    if (!vx && !vy) { stopEdgePan(); return; }
    if (edgeRef.current) { edgeRef.current.vx = vx; edgeRef.current.vy = vy; return; }
    const st = { vx, vy };
    st.timer = setInterval(() => {
      if (!lastMoveRef.current || !(dragRef.current || draftRef.current)) { stopEdgePan(); return; }
      cam.panBy(st.vx * speed, st.vy * speed);
      setTimeout(() => moveRef.current && lastMoveRef.current && moveRef.current(lastMoveRef.current), 0);
    }, 30);
    edgeRef.current = st;
  };
  useEffect(() => stopEdgePan, []);

  const onPointerDown = (e) => {
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* synthetic or finished pointer */ }
    const { sx, sy } = eventPos(e);
    const w = toWorld(sx, sy);
    if (e.button === 1 || e.button === 2 || e.altKey || spaceRef.current) { cam.beginPan(e); return; }
    if (mode === 'box') {
      const h = handleAt(selMember, sx, sy);
      if (h) {
        const raw = stored(selMember.id);
        const orig = { ...raw, poly: memberPoly(raw) };
        if (h.kind === 'insert') {
          // A new corner in the middle of this edge, dragged like any other corner.
          orig.poly.splice(h.i + 1, 0, h.p);
          orig.corners = orig.poly;
          dragRef.current = { kind: 'corner', i: h.i + 1, id: raw.id, orig, start: w, key: 'drag-' + uid() };
          return;
        }
        const grab = h.kind === 'edge' && !raw.corners ? resizeProj(orig, RECT_EDGE[h.i].kind, RECT_EDGE[h.i].sign, w) - (RECT_EDGE[h.i].kind === 'len' ? orig.len : orig.depth) : 0;
        dragRef.current = { ...h, id: raw.id, orig, start: w, grab, key: 'drag-' + uid() };
        return;
      }
      const b = hitBolt(sx, sy);
      if (b) { setSel({ type: 'bolt', id: b.id }); return; }
      const m = hitMember(sx, sy);
      if (m) {
        setSel({ type: 'member', id: m.id });
        if (editable(m)) {
          const raw = stored(m.id);
          dragRef.current = { kind: 'move', id: m.id, orig: { ...raw, poly: memberPoly(raw) }, start: w, key: 'drag-' + uid() };
        }
        return;
      }
      // Empty space: start drawing a new box (its start snaps onto a nearby edge or corner).
      const sp = snapOn ? snapPoint([w.u, w.v], snapTargets(null), 8 / k) : { p: [w.u, w.v] };
      setDraft({ start: { u: sp.p[0], v: sp.p[1] }, end: w, hadSel: !!sel });
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
      // Every other connection at the same spot joins in, so one bolt goes through the whole stack
      // of overlapping members there.
      const ids = [c.a, c.b];
      for (const o of contacts) {
        if (o === c) continue;
        const on = pointOnContact(o, [u, v], 0.3);
        if (on) for (const id of [o.a, o.b]) if (!ids.includes(id)) ids.push(id);
      }
      const [a, bb, ...more] = ids;
      const bolt = { id: uid('b'), plane, a, b: bb, ...(more.length ? { more } : {}), u: Math.round(u * 100) / 100, v: Math.round(v * 100) / 100 };
      updateProject((p) => { p.design.bolts.push(bolt); });
      setSel({ type: 'bolt', id: bolt.id });
    } else if (mode === 'bearing') {
      const m = hitMember(sx, sy, editable);
      if (m && !isTop) updateProject((p) => { const x = p.design.members.find((q) => q.id === m.id); x.bearing = !m.bearing; });
    } else if (mode === 'calibrate') {
      if (!img || !view.calib) return;
      const ip = viewToImage(view.calib, flip, w.u, w.v);
      if (calibMethod === 'footings') {
        // Click the west support, then the east one; they land `footingSpan` apart at ground level.
        const pts = [...calibPts, { px: ip.px, py: ip.py }];
        if (pts.length < 2) { setCalibPts(pts); return; }
        const c = calibFromPoints(flip, { ...pts[0], u: fp.west, v: 0 }, { ...pts[1], u: fp.east, v: 0 });
        if (!c) { alert('Pick two different points.'); setCalibPts([]); return; }
        updateProject((p) => { p.design.views[viewKey] = { ...p.design.views[viewKey], calib: c, scaled: true }; });
        setCalibPts([]);
        setMode('box');
        return;
      }
      const pt = { px: ip.px, py: ip.py, u: Math.round(w.u), v: Math.round(w.v) };
      setCalibPts(calibPts.length >= 2 ? [pt] : [...calibPts, pt]);
    }
  };

  const onPointerMove = (e) => {
    const { sx, sy } = eventPos(e);
    const w = toWorld(sx, sy);
    setCursor(w);
    const busy = draft || dragRef.current;
    if (busy) {
      lastMoveRef.current = { clientX: e.clientX, clientY: e.clientY, shiftKey: e.shiftKey, buttons: e.buttons };
      // Mid-drag, holding Space or pressing the right/middle button too pans the view; the piece
      // stays where it is and picks up again when you let go.
      if (spaceRef.current || (e.buttons & 6)) {
        if (!midPanRef.current) { cam.beginPan(e); midPanRef.current = true; }
        cam.movePan(e);
        return;
      }
      if (midPanRef.current) { cam.endPan(); midPanRef.current = false; }
      edgePan(sx, sy);
    }
    if (cam.movePan(e)) return;
    if (mode === 'bolt') { const h = hitContact(w); setHoverContact(h ? h.c.id : null); }
    if (mode === 'box' && draft) {
      setDraft({ ...draft, end: w });
      setGuides(draftBox({ ...draft, end: w }).lines);
      return;
    }
    const drag = dragRef.current;
    if (!drag) return;
    const o = drag.orig;
    const snap = snapOn && !e.shiftKey;
    const targets = snapTargets(o.id);
    if (drag.kind === 'move') {
      const du = w.u - drag.start.u, dv = w.v - drag.start.v;
      let poly = o.poly.map(([u, v]) => [u + du, v + dv]);
      let lines = [];
      let rot = 0;
      if (snap) {
        // Reshaped boxes keep their angle; rectangles may turn a few degrees to sit flush.
        const s = snapPoly(poly, targets, tolW, { rotate: !o.corners });
        poly = applySnap(poly, s);
        lines = s.lines;
        rot = s.rot;
      }
      setGuides(lines);
      if (o.corners) setBox(o.id, { corners: poly }, drag.key);
      else { const c = polyCentroid(poly); setBox(o.id, { u: c[0], v: c[1], angle: o.angle + rot }, drag.key); }
    } else if (drag.kind === 'rotate') {
      const c = polyCentroid(o.poly);
      const a0 = (Math.atan2(drag.start.v - c[1], drag.start.u - c[0]) * 180) / Math.PI;
      let ang = (Math.atan2(w.v - c[1], w.u - c[0]) * 180) / Math.PI;
      if (o.corners) setBox(o.id, { corners: rotatePoly(o.poly, ang - a0, c) }, drag.key);
      else {
        let next = o.angle + (ang - a0);
        if (snap) next = snapAngle(next, memberAngles(o.id));
        setBox(o.id, { angle: next }, drag.key);
      }
    } else if (drag.kind === 'corner') {
      // Reshape: move one corner (snapping to a neighbour's corner or edge).
      const sp = snap ? snapPoint([w.u, w.v], targets, 8 / k) : { p: [w.u, w.v], line: null };
      const poly = o.poly.map((p, i) => (i === drag.i ? sp.p : p));
      setGuides(sp.line ? [sp.line] : []);
      if (shapeOk(poly)) { setBadShape(null); setBox(o.id, { corners: poly }, drag.key); }
      else setBadShape(poly);
    } else if (drag.kind === 'edge' && !o.corners) {
      // Push/pull a rectangle's edge: the opposite edge stays put; never bigger than the size box.
      const { kind, sign } = RECT_EDGE[drag.i];
      const { d: dir, n } = boxAxes(o);
      const ax = kind === 'len' ? dir : n;
      const half = (kind === 'len' ? o.len : o.depth) / 2;
      const fixed = [o.u - ax[0] * half * sign, o.v - ax[1] * half * sign];
      let size = resizeProj(o, kind, sign, w) - (drag.grab || 0);
      const max = kind === 'len' ? lim.len : lim.depth;
      size = Math.max(kind === 'len' ? 0.5 : 0.25, Math.min(max, size));
      if (snap) size = Math.min(max, snapSize(o, kind, sign, size, targets, tolW));
      const c = [fixed[0] + ax[0] * size / 2 * sign, fixed[1] + ax[1] * size / 2 * sign];
      setBox(o.id, { u: c[0], v: c[1], [kind]: size }, drag.key);
    } else if (drag.kind === 'edge') {
      // Push/pull one edge of a reshaped box straight out or in.
      const n = drag.n;
      let t = (w.u - drag.start.u) * n[0] + (w.v - drag.start.v) * n[1];
      const j = (drag.i + 1) % o.poly.length;
      let poly = o.poly.map((p, i) => (i === drag.i || i === j ? [p[0] + n[0] * t, p[1] + n[1] * t] : p));
      if (snap) {
        // Let the moved edge land on a parallel neighbouring edge.
        const edge = [poly[drag.i], poly[j]];
        const s = snapPoly(edge, targets, tolW, { rotate: false });
        const along = s.dx * n[0] + s.dy * n[1];
        if (s.lines.length && Math.abs(along) > 1e-9) { t += along; poly = o.poly.map((p, i) => (i === drag.i || i === j ? [p[0] + n[0] * t, p[1] + n[1] * t] : p)); setGuides(s.lines); }
      }
      if (shapeOk(poly)) { setBadShape(null); setBox(o.id, { corners: poly }, drag.key); }
      else setBadShape(poly);
    }
  };

  moveRef.current = onPointerMove;
  draftRef.current = draft;

  const onPointerUp = () => {
    cam.endPan();
    midPanRef.current = false;
    stopEdgePan();
    if (dragRef.current) { dragRef.current = null; setGuides([]); setBadShape(null); }
    if (mode === 'box' && draft) {
      const dist = Math.hypot(draft.end.u - draft.start.u, draft.end.v - draft.start.v);
      setGuides([]);
      // A plain click on empty space just clears the selection if there was one.
      if (dist * k < 6 && draft.hadSel) { setSel(null); setDraft(null); return; }
      const { box } = draftBox(draft);
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

  // Footings and the two support points, so boxes can be lined up on them.
  const footingEls = [];
  footings.forEach((f, i) => footingEls.push(html`<polygon key=${'ft' + i} points=${pts(f)} fill="#d6b98c" fill-opacity=${isTop ? 0.35 : 0.8} stroke="#92400e" stroke-dasharray=${isTop ? '4 3' : null} />`));
  for (const [x, name] of [[fp.west, 'west'], [fp.east, 'east']]) {
    const s = toScreen(x, 0);
    footingEls.push(html`<line key=${'sp' + name} x1=${s.x} y1=${s.y - 10} x2=${s.x} y2=${s.y + 10} stroke="#92400e" stroke-width="1.5" stroke-dasharray="2 2" pointer-events="none" />`);
  }
  {
    const a = toScreen(fp.west, isTop ? -6 : -5), b = toScreen(fp.east, isTop ? -6 : -5);
    footingEls.push(html`<g key="span" pointer-events="none">
      <line x1=${a.x} y1=${a.y} x2=${b.x} y2=${b.y} stroke="#92400e" stroke-width="1" />
      <text x=${(a.x + b.x) / 2} y=${a.y + (flip ? 13 : -4)} font-size="11" text-anchor="middle" fill="#92400e" class="halo">supports ${ftIn(fp.span)} apart</text></g>`);
  }

  const memberEls = [];
  for (const m of ghosts) memberEls.push(html`<polygon key=${'g' + m.id} points=${pts(m.poly)} fill="none" stroke="#94a3b8" stroke-dasharray="4 3" />`);
  viewMembers.forEach((m, i) => {
    const truss = isTop && m.plane !== 'L';
    const color = !m.box.fits ? '#dc2626' : m.color || (mode === 'box' ? MEMBER_COLORS[i % MEMBER_COLORS.length] : PLANE_COLORS[m.plane]);
    const on = isSel('member', m.id);
    memberEls.push(html`<polygon key=${m.id} points=${pts(outline(m))} fill=${color} fill-opacity=${truss ? 0.12 : on ? 0.35 : 0.2}
      stroke=${on ? '#f59e0b' : color} stroke-width=${on ? 3 : truss ? 1 : 1.6} stroke-dasharray=${m.mirrorOf ? '5 3' : null} />`);
    if (!truss && k * m.len > 60) {
      const c = S(polyCentroid(m.poly));
      memberEls.push(html`<text key=${'t' + m.id} x=${c.x} y=${c.y + 4} font-size="11" text-anchor="middle" fill=${color} font-weight="700" class="halo" pointer-events="none">${m.name}</text>`);
    }
    if (m.bearing && !isTop) {
      const s = toScreen(m.bearingPoint[0], m.bearingPoint[2]);
      memberEls.push(html`<path key=${'brg' + m.id} d=${`M${s.x} ${s.y} l-8 12 h16 z`} fill="#fde68a" stroke="#92400e" opacity=${m.autoBearing ? 0.75 : 1}><title>${m.autoBearing ? 'Stands on a footing (found automatically)' : 'Stands on a footing'}</title></path>`);
    }
  });

  const contactEls = contacts.map((c) => {
    const show = mode === 'bolt' || c.bolts === 0;
    if (!show && mode !== 'box') return null;
    const hot = hoverContact === c.id;
    const color = c.bolts ? '#16a34a' : '#ea580c';
    if (c.kind === 'edge') {
      const a = S(c.seg[0]), b = S(c.seg[1]);
      return html`<line key=${c.id} x1=${a.x} y1=${a.y} x2=${b.x} y2=${b.y} stroke=${color} stroke-width=${hot ? 7 : mode === 'bolt' ? 4 : 2.5} stroke-linecap="round" opacity=${mode === 'bolt' || hot ? 0.9 : 0.6} stroke-dasharray=${c.bolts ? null : '3 3'} pointer-events="none" />`;
    }
    const pieces = c.pieces || [c.poly];
    return html`<g key=${c.id} pointer-events="none">${pieces.map((q, i) => html`<polygon key=${i} points=${pts(q)} fill=${color} fill-opacity=${hot ? 0.45 : mode === 'bolt' ? 0.3 : 0.15} stroke=${pieces.length > 1 ? 'none' : color} stroke-width=${hot ? 2 : 1} />`)}</g>`;
  });

  const boltEls = model.bolts.filter((b) => b.plane === plane).map((b) => {
    const s = toScreen(b.u, b.v);
    const on = isSel('bolt', b.id);
    return html`<circle key=${b.id} cx=${s.x} cy=${s.y} r=${on ? 5.5 : 4} fill=${!b.jointId ? '#dc2626' : on ? '#facc15' : '#111827'} stroke="#fff" stroke-width="1.2"><title>${b.jointId ? 'Bolt through ' + b.memberIds.map((id) => model.memberById.get(id)?.name || '?').join(', ') : 'Bolt not on a connection'}</title></circle>${b.memberIds.length > 2 && html`<text x=${s.x + 6} y=${s.y - 5} font-size="10" font-weight="700" fill="#111827" class="halo" pointer-events="none">×${b.memberIds.length}</text>`}`;
  });

  let handleEls = null;
  if (mode === 'box' && selMember && editable(selMember)) {
    const hs = handles(selMember);
    const rot = hs.find((h) => h.kind === 'rotate'), front = hs.find((h) => h.kind === 'edge' && h.i === 1);
    const c = S(polyCentroid(selMember.poly)), r = S(rot.p), f = S(front.p);
    handleEls = html`<g>
      <line x1=${f.x} y1=${f.y} x2=${r.x} y2=${r.y} stroke="#f59e0b" stroke-width="1.5" />
      ${hs.filter((h) => h.kind === 'edge').map((h) => { const s = S(h.p); return html`<rect key=${'e' + h.i} x=${s.x - 5} y=${s.y - 5} width="10" height="10" fill="#fff" stroke="#f59e0b" stroke-width="2"><title>Push / pull this edge</title></rect>`; })}
      ${hs.filter((h) => h.kind === 'insert').map((h) => { const s = S(h.p); return html`<g key=${'i' + h.i}><circle cx=${s.x} cy=${s.y} r="4.5" fill="#fff" stroke="#f59e0b" stroke-width="1.5" stroke-dasharray="2 1.5"><title>Drag to add a corner here</title></circle>
        <path d=${`M${s.x - 2.5} ${s.y}h5M${s.x} ${s.y - 2.5}v5`} stroke="#b45309" stroke-width="1.4" pointer-events="none" /></g>`; })}
      ${hs.filter((h) => h.kind === 'corner').map((h) => { const s = S(h.p); return html`<circle key=${'c' + h.i} cx=${s.x} cy=${s.y} r="5.5" fill="#f59e0b" stroke="#fff" stroke-width="2"><title>Drag to reshape (must still fit the size box). Double-click to remove this corner.</title></circle>`; })}
      <circle cx=${r.x} cy=${r.y} r="6" fill="#fff" stroke="#f59e0b" stroke-width="2.5"><title>Rotate</title></circle>
      <text x=${c.x} y=${c.y - 10} font-size="11" text-anchor="middle" fill="#92400e" class="halo" pointer-events="none">${selMember.len.toFixed(2)} × ${selMember.depth.toFixed(2)} in${stored(selMember.id).corners ? ' (reshaped)' : ''}</text>
    </g>`;
  }
  const badEl = badShape && html`<polygon points=${pts(badShape)} fill="#dc2626" fill-opacity="0.12" stroke="#dc2626" stroke-width="2" stroke-dasharray="5 3" pointer-events="none" />`;

  let draftEl = null;
  if (mode === 'box' && (draft || (cursor && !selMember))) {
    const box = draft ? draftBox(draft).box : { u: cursor.u, v: cursor.v, angle: lastShape.angle, len: lim.len, depth: lastShape.depth };
    const poly = boxCorners(box);
    draftEl = html`<g pointer-events="none" opacity=${draft ? 1 : 0.45}>
      <polygon points=${pts(poly)} fill="#f59e0b" fill-opacity="0.12" stroke=${box.tooLong ? '#dc2626' : '#f59e0b'} stroke-width="2" stroke-dasharray="6 4" />
      ${draft && html`<text x=${S([box.u, box.v]).x} y=${S([box.u, box.v]).y - 10} font-size="11" text-anchor="middle" fill="#92400e" class="halo">${box.len.toFixed(1)} in${box.tooLong ? ' (max)' : ''}</text>`}
    </g>`;
  }

  const guideEls = guides.map(([a, b], i) => { const p = S(a), q = S(b); return html`<line key=${'gd' + i} x1=${p.x} y1=${p.y} x2=${q.x} y2=${q.y} stroke="#ec4899" stroke-width="3" pointer-events="none" />`; });

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
    box: selMember && editable(selMember)
      ? 'Drag the box to move it (it snaps to neighbouring edges; hold Shift to place freely). Square handles push/pull an edge, round corner nodes reshape it, a "+" node on an edge adds a corner there (double-click a corner to remove it), the outlined circle rotates it. Click empty space to deselect. Arrow keys nudge, R turns 90°, Ctrl+D copies, Delete removes.' + (selLateral ? ' PageUp / PageDown raise or lower this lateral.' : '') + ' While dragging, hold Space or the right mouse button to pan, or drag to the canvas edge.'
      : `Drag along a member in the screenshot to draw a box over it, or click to stamp a full ${lim.len} × ${lim.depth} in box. Click a box to select and edit it. Everything inside one box is one welded member. Pan with the right mouse button or Space+drag (also mid-drag); scroll to zoom.`,
    calibrate: calibMethod === 'footings'
      ? (isTop ? `Click truss A at the west footing support, then at the east one. They'll be placed ${ftIn(fp.span)} apart.` : `Click the west footing support on the screenshot, then the east one (where the bridge stands on each footing). They'll be placed ${ftIn(fp.span)} apart at ground level.`)
      : 'Click two points on the screenshot whose positions you know, type their real coordinates in inches, then Apply.',
    bolt: 'Green lines and areas are where two boxes touch. Click on one to put a bolt there; click a bolt to remove it. Orange = touching with no bolt yet. Esc goes back to the boxes.',
    bearing: 'Members whose bottom sits on a footing are found automatically (pale triangle). Click a member to mark or unmark it by hand. Esc goes back to the boxes.',
  };
  const editableHere = viewMembers.filter(editable);
  const needsSpan = d.footingSpan == null && !img && !editableHere.length && !isTop;
  const showDrop = !needsSpan && !img && !noImage && !editableHere.length;

  return html`<div class="annotator">
    <div class="toolbar" data-tour="modes">
      ${MODES.map(([m, label, key], i) => (isTop && m === 'bearing') ? null : html`<button class=${'step-btn ' + (mode === m ? 'on' : '')} title=${label + ' (' + key + ')'} disabled=${m === 'calibrate' && !img}
        onClick=${() => setMode(m)}><span class="n">${i + 1}</span>${label}</button>`)}
    </div>
    <div class="toolbar sub">
      ${mode === 'box' && html`<span class="muted">New boxes:</span>
        <label class="check">depth <input type="number" class="tiny" min="0.25" max=${lim.depth} step="0.25" value=${lastShape.depth}
          onInput=${(e) => { const v = parseFloat(e.target.value); if (v > 0) setLastShape({ ...lastShape, depth: Math.min(lim.depth, v) }); }} /> in</label>
        <label class="check" title="Size out of the view (thickness)">thick <input type="number" class="tiny" min="0.125" max=${lim.thick} step="0.125" value=${lastShape.thick}
          onInput=${(e) => { const v = parseFloat(e.target.value); if (v > 0) setLastShape({ ...lastShape, thick: Math.min(lim.thick, v) }); }} /> in</label>`}
      ${mode === 'box' && selMember && editable(selMember) && html`<span class="sep"></span><button onClick=${duplicate}>Copy</button>
        <button onClick=${() => turn90(selMember)}>Turn 90°</button>
        <button class="danger" onClick=${deleteSelection}>Delete</button>`}
      ${isTop && mode === 'box' && (selLateral
        ? html`<span class="sep"></span><label class="check" title="Height of this lateral's centerline (PageUp / PageDown step it ¼ in, with Shift 1 in)">${selLateral.name} height
          <button class="small" title="Lower ¼ in" onClick=${() => setLateralZ(stored(selLateral.id).z - 0.25)}>▼</button>
          <input type="number" class="tiny" step="0.25" value=${stored(selLateral.id).z} onInput=${(e) => { const v = parseFloat(e.target.value); if (Number.isFinite(v)) setLateralZ(v); }} />
          <button class="small" title="Raise ¼ in" onClick=${() => setLateralZ(stored(selLateral.id).z + 0.25)}>▲</button> in
          <select title="Move it to the height of a truss member" value="" onChange=${(e) => { if (e.target.value !== '') setLateralZ(parseFloat(e.target.value)); }}>
            <option value="">to a level…</option>
            ${levels.map((z) => html`<option value=${String(z)}>z = ${z} in</option>`)}
          </select></label>`
        : html`<label class="check" title="Height of new laterals' centerline">New lateral height
          <select value=${String(lateralZ)} onChange=${(e) => setLevel(parseFloat(e.target.value))}>
            ${levels.map((z) => html`<option value=${String(z)}>z = ${z} in</option>`)}
          </select></label>`)}
      <label class="check" title="Snap boxes to neighbouring edges and corners, bolts to ¼ in steps"><input type="checkbox" checked=${snapOn} onChange=${(e) => setSnapOn(e.target.checked)} /> Snap</label>
      <span class="spacer"></span>
      ${img && html`<label class="check">Screenshot <input type="range" min="0" max="1" step="0.05" value=${view.opacity}
        onInput=${(e) => updateProject((p) => { p.design.views[viewKey].opacity = parseFloat(e.target.value); }, { key: 'op' + viewKey })} /></label>`}
      <button onClick=${async () => loadFile(await pickFile('image/*'))}>${img ? 'Replace screenshot' : 'Add screenshot'}</button>
      <button onClick=${() => cam.fit(bounds)}>Fit</button>
    </div>
    <div class=${'canvas-wrap' + (dropping ? ' dropping' : '')} data-tour="canvas"
      onDragOver=${(e) => { e.preventDefault(); setDropping(true); }} onDragLeave=${() => setDropping(false)}
      onDrop=${(e) => { e.preventDefault(); setDropping(false); loadFile(e.dataTransfer.files[0]); }}>
      <svg ref=${cam.svgRef} class=${'canvas mode-' + mode + (selMember ? ' has-sel' : '')} onPointerDown=${onPointerDown} onPointerMove=${onPointerMove} onPointerUp=${onPointerUp} onDblClick=${onDoubleClick}
        onPointerLeave=${() => { setCursor(null); setHoverContact(null); }} onContextMenu=${(e) => e.preventDefault()}>
        <rect x="0" y="0" width=${cam.size.w} height=${cam.size.h} fill="#f8fafc" />
        ${gridLines(cam).map((l, i) => html`<line key=${'g' + i} ...${l} stroke=${l.zero ? '#94a3b8' : l.major ? '#cbd5e1' : '#e2e8f0'} stroke-width=${l.zero ? 1.5 : 1} />`)}
        ${img && imgTransform && html`<image href=${img.url} width=${img.w} height=${img.h} transform=${imgTransform} opacity=${view.opacity} preserveAspectRatio="none" />`}
        <text x=${origin.x + 4} y=${origin.y + (flip ? 14 : -4)} font-size="11" fill="#64748b">0,0</text>
        ${footingEls}${memberEls}${contactEls}${boltEls}${guideEls}${badEl}${handleEls}${draftEl}${calibEls}
      </svg>
      <div class="hint-bar">${hints[mode]}${cursor && html`<span class="coords">x ${cursor.u.toFixed(1)} · ${axisV} ${cursor.v.toFixed(1)} in</span>`}</div>
      ${img && !view.scaled && mode !== 'calibrate' && html`<div class="banner warn">The screenshot's scale isn't set yet, so box sizes won't match it.
        <button class="small" onClick=${() => { setCalibMethod('footings'); setMode('calibrate'); }}>Set scale</button></div>`}
      ${needsSpan && html`<${FootingSetup} project=${project} />`}
      ${showDrop && html`<div class="dropzone">
        <div class="dropcard">
          <h3>${isTop ? 'Add a top-view screenshot' : 'Add a side-view screenshot'}</h3>
          <p>${isTop ? 'A plan view from your CAD program, showing the laterals between the two trusses.' : 'A side (elevation) view of one truss from your CAD program.'}</p>
          <p><b>Drag the image here</b>, paste it with <b>Ctrl+V</b>, or</p>
          <button class="primary" onClick=${async () => loadFile(await pickFile('image/*'))}>Choose an image…</button>
          <p class="muted">Footing supports: ${ftIn(fp.span)} apart (change in Bridge settings). <a href="#" onClick=${(e) => { e.preventDefault(); setNoImage(true); }}>Place boxes without a screenshot</a></p>
        </div>
      </div>`}
      ${mode === 'calibrate' && img && html`<div class="float-panel">
        <h4>Set the screenshot's scale</h4>
        ${calibMethod === 'footings' ? html`
          <p><b>${calibPts.length === 0 ? (isTop ? 'Click truss A at the west footing support.' : 'Click the west footing support.') : (isTop ? 'Now click truss A at the east footing support.' : 'Now click the east footing support.')}</b></p>
          <p class="muted">They'll be placed ${ftIn(fp.span)} apart${isTop ? '' : ' at ground level'}, over the site's footings.</p>
          <div class="row"><button onClick=${() => { setCalibPts([]); setCalibMethod('points'); }}>Use two other points instead</button><button onClick=${() => setMode('box')}>Cancel</button></div>`
        : html`
          ${calibPts.length < 2 && html`<p>Click point ${calibPts.length + 1} of 2 on the screenshot.</p>`}
          ${calibPts.map((pt, i) => html`<div class="row">
            <b>Point ${i + 1}</b>
            <${NumField} label="x" unit="in" value=${pt.u} onChange=${(v) => setCalibPts(calibPts.map((q, j) => (j === i ? { ...q, u: v } : q)))} />
            <${NumField} label=${axisV} unit="in" value=${pt.v} onChange=${(v) => setCalibPts(calibPts.map((q, j) => (j === i ? { ...q, v } : q)))} />
          </div>`)}
          <p class="muted">x runs along the span from the west footing's outer edge; ${isTop ? 'y runs across, from truss A (y = 0) to truss B.' : 'z is height above the footings.'}</p>
          <div class="row"><button class="primary" disabled=${calibPts.length < 2} onClick=${applyCalib}>Apply</button><button onClick=${() => { setCalibPts([]); setCalibMethod('footings'); }}>Use the footings</button><button onClick=${() => setMode('box')}>Cancel</button></div>`}
      </div>`}
    </div>
  </div>`;
}
