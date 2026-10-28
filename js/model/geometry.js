// Geometry: turns the box members marked on the screenshots into a 3D model, finds where boxes
// touch (connections), and maps bridge coordinates onto the site plan.
//
// Bridge coordinates: x along the span, y across (truss A at y = 0, truss B at y = trussSpacing),
// z up. Side views use (u, v) = (x, z); the top view uses (u, v) = (x, y).
import { MIRROR_SUFFIX } from './ids.js';
import { boxLimits } from './schema.js';

const EPS_EDGE = 0.15; // in: edges this close count as touching
const MIN_CONTACT = 0.1; // in: shortest touching length that counts
const BOLT_TOL = 0.35; // in: a bolt this close to a connection belongs to it

// Every member a bolt passes through: a and b, plus any more stacked where boxes overlap.
export const boltMembers = (b) => [b.a, b.b, ...(b.more || [])];

// ---------- 2D helpers (points are [u, v]) ----------
const rad = (deg) => (deg * Math.PI) / 180;
const dot2 = (a, b) => a[0] * b[0] + a[1] * b[1];
const cross2 = (a, b) => a[0] * b[1] - a[1] * b[0];
const sub2 = (a, b) => [a[0] - b[0], a[1] - b[1]];
const len2 = (a) => Math.hypot(a[0], a[1]);

export function boxAxes(m) {
  const a = rad(m.angle || 0);
  return { d: [Math.cos(a), Math.sin(a)], n: [-Math.sin(a), Math.cos(a)] };
}

// Corners counter-clockwise: back-bottom, front-bottom, front-top, back-top (in the box's own frame).
export function boxCorners(m) {
  const { d, n } = boxAxes(m);
  const hl = m.len / 2, hd = m.depth / 2;
  return [[-hl, -hd], [hl, -hd], [hl, hd], [-hl, hd]].map(([s, t]) => [m.u + d[0] * s + n[0] * t, m.v + d[1] * s + n[1] * t]);
}

// Edges: 0 bottom side, 1 front end, 2 top side, 3 back end.
export function polyEdges(poly) {
  return poly.map((p, i) => [p, poly[(i + 1) % poly.length]]);
}

export function polyArea(poly) {
  let a = 0;
  for (let i = 0; i < poly.length; i++) a += cross2(poly[i], poly[(i + 1) % poly.length]);
  return a / 2;
}

export function polyCentroid(poly) {
  let cx = 0, cy = 0, a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length], c = cross2(p, q);
    a += c; cx += (p[0] + q[0]) * c; cy += (p[1] + q[1]) * c;
  }
  if (Math.abs(a) < 1e-9) return [poly.reduce((s, p) => s + p[0], 0) / poly.length, poly.reduce((s, p) => s + p[1], 0) / poly.length];
  return [cx / (3 * a), cy / (3 * a)];
}

function ccw(poly) {
  return polyArea(poly) < 0 ? [...poly].reverse() : poly;
}

// Sutherland–Hodgman clip of convex polygons.
export function clipPoly(subject, clip) {
  let out = ccw(subject);
  const c = ccw(clip);
  for (let i = 0; i < c.length && out.length; i++) {
    const a = c[i], b = c[(i + 1) % c.length];
    const inside = (p) => cross2(sub2(b, a), sub2(p, a)) >= -1e-9;
    const input = out;
    out = [];
    for (let j = 0; j < input.length; j++) {
      const p = input[j], q = input[(j + 1) % input.length];
      const pin = inside(p), qin = inside(q);
      if (pin) out.push(p);
      if (pin !== qin) {
        const e = sub2(b, a), dpq = sub2(q, p);
        const t = cross2(e, sub2(a, p)) / cross2(e, dpq);
        out.push([p[0] + dpq[0] * t, p[1] + dpq[1] * t]);
      }
    }
  }
  return out;
}

export function pointInPoly(p, poly, tol = 0) {
  const c = ccw(poly);
  for (let i = 0; i < c.length; i++) {
    const a = c[i], b = c[(i + 1) % c.length];
    const e = sub2(b, a);
    if (cross2(e, sub2(p, a)) / (len2(e) || 1) < -tol) return false;
  }
  return true;
}

export function distToSegment2(p, a, b) {
  const ab = sub2(b, a), l2 = dot2(ab, ab);
  const t = l2 ? Math.max(0, Math.min(1, dot2(sub2(p, a), ab) / l2)) : 0;
  const q = [a[0] + ab[0] * t, a[1] + ab[1] * t];
  return { d: len2(sub2(p, q)), t, q };
}

// Where two convex outlines touch: {kind: 'overlap', poly} | {kind: 'edge', seg: [p, q]} | null.
export function contact2d(P, Q) {
  const inter = clipPoly(P, Q);
  if (inter.length >= 3 && Math.abs(polyArea(inter)) > 0.05) return { kind: 'overlap', poly: inter };
  let best = null;
  for (const [a, b] of polyEdges(P)) {
    const e = sub2(b, a), el = len2(e);
    if (el < 1e-6) continue;
    const u = [e[0] / el, e[1] / el];
    for (const [c, d] of polyEdges(Q)) {
      const f = sub2(d, c), fl = len2(f);
      if (fl < 1e-6) continue;
      if (Math.abs(cross2(u, f)) / fl > 0.01) continue; // not parallel
      if (Math.abs(cross2(u, sub2(c, a))) > EPS_EDGE) continue; // not on the same line
      const t0 = dot2(sub2(c, a), u), t1 = dot2(sub2(d, a), u);
      const lo = Math.max(0, Math.min(t0, t1)), hi = Math.min(el, Math.max(t0, t1));
      if (hi - lo < MIN_CONTACT) continue;
      if (!best || hi - lo > best.l) best = { l: hi - lo, seg: [[a[0] + u[0] * lo, a[1] + u[1] * lo], [a[0] + u[0] * hi, a[1] + u[1] * hi]] };
    }
  }
  return best && { kind: 'edge', seg: best.seg };
}

// ---------- shaped members ----------
export function memberPoly(m) {
  return m.corners ? m.corners.map((p) => [p[0], p[1]]) : boxCorners(m);
}

// Extents of a polygon measured along angle `deg` and across it.
function extentsAt(poly, deg) {
  const a = rad(deg), c = Math.cos(a), s = Math.sin(a);
  let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
  for (const [x, y] of poly) {
    const p = x * c + y * s, q = -x * s + y * c;
    if (p < a0) a0 = p; if (p > a1) a1 = p;
    if (q < b0) b0 = q; if (q > b1) b1 = q;
  }
  return { len: a1 - a0, depth: b1 - b0, a0, a1, b0, b1, c, s };
}

function candidateAngles(poly) {
  const out = [];
  for (const [p, q] of polyEdges(poly)) if (Math.hypot(q[0] - p[0], q[1] - p[1]) > 1e-6) out.push((Math.atan2(q[1] - p[1], q[0] - p[0]) * 180) / Math.PI);
  for (let a = 0; a < 180; a += 1) out.push(a);
  return out;
}

// Tightest rectangle around a shape: {u, v, angle, len, depth} with len ≥ depth.
export function rectOfPoly(poly) {
  let best = null;
  for (const ang of candidateAngles(poly)) {
    const e = extentsAt(poly, ang);
    const area = e.len * e.depth;
    if (!best || area < best.area - 1e-9) best = { area, ang, e };
  }
  let { ang, e } = best;
  if (e.depth > e.len) { ang += 90; e = extentsAt(poly, ang); }
  const mu = (e.a0 + e.a1) / 2, mv = (e.b0 + e.b1) / 2;
  return { u: mu * e.c - mv * e.s, v: mu * e.s + mv * e.c, angle: ((ang % 360) + 360) % 360, len: e.len, depth: e.depth };
}

// Does the shape fit inside a len × depth rectangle in some orientation?
export function polyFits(poly, lim) {
  for (const ang of candidateAngles(poly)) {
    const e = extentsAt(poly, ang);
    if ((e.len <= lim.len + 1e-6 && e.depth <= lim.depth + 1e-6) || (e.depth <= lim.len + 1e-6 && e.len <= lim.depth + 1e-6)) return true;
  }
  return false;
}

export function isConvex(poly) {
  let sign = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length], c = poly[(i + 2) % poly.length];
    const z = cross2(sub2(b, a), sub2(c, b));
    if (Math.abs(z) < 1e-9) continue;
    if (sign && Math.sign(z) !== sign) return false;
    sign = Math.sign(z);
  }
  return true;
}

// ---------- footings ----------
// Footings in bridge x, from the site layout ([x0, x1] pairs, west first).
export function footingRanges(project) {
  const site = project.site;
  const out = [];
  for (const z of site.zones || []) {
    if (z.type !== 'footing') continue;
    const xs = [[z.x, z.y], [z.x + z.w, z.y], [z.x, z.y + z.h], [z.x + z.w, z.y + z.h]].map(([x, y]) => siteToBridge(site, x, y).x);
    out.push([Math.min(...xs), Math.max(...xs)]);
  }
  return out.sort((a, b) => a[0] - b[0]);
}

// Where the bridge's two footing supports sit along x, `span` apart and centered on the footings.
export function footingPoints(project, span = project.design.footingSpan) {
  const f = footingRanges(project);
  const mid = f.length >= 2 ? ((f[0][0] + f[0][1]) / 2 + (f[f.length - 1][0] + f[f.length - 1][1]) / 2) / 2 : (span || 264) / 2;
  const s = span || (f.length >= 2 ? (f[f.length - 1][0] + f[f.length - 1][1]) / 2 - (f[0][0] + f[0][1]) / 2 : 264);
  return { west: mid - s / 2, east: mid + s / 2, span: s };
}

// ---------- model ----------
function mirrorName(name) {
  if (/^A[-_ ]/.test(name)) return 'B' + name.slice(1);
  return name + ' (B)';
}

export const pairKey = (a, b) => (a < b ? a + '|' + b : b + '|' + a);

// Build the 3D model: members (with truss-B mirror copies when mirrorB is on), connections
// where members touch, and bolts assigned to those connections.
export function buildModel(project) {
  const d = project.design;
  const S = d.trussSpacing;
  const lim = boxLimits(project);
  const raw = [];
  for (const m of d.members) {
    if (d.mirrorB && m.plane === 'B') continue;
    raw.push(m);
    if (d.mirrorB && m.plane === 'A') raw.push({ ...m, id: m.id + MIRROR_SUFFIX, name: mirrorName(m.name), plane: 'B', mirrorOf: m.id });
  }

  const footings = footingRanges(project);
  const members = raw.map((src) => {
    // A shaped member stores its own corners; otherwise it's the rectangle (u, v, angle, len, depth).
    // Either way, len/depth/angle below describe its tightest enclosing rectangle.
    const poly = memberPoly(src);
    const rect = src.corners ? rectOfPoly(poly) : null;
    const m = rect ? { ...src, ...rect } : src;
    const planeY = m.plane === 'A' ? 0 : m.plane === 'B' ? S : null;
    const to3 = m.plane === 'L' ? ([u, v]) => [u, v, m.z || 0] : ([u, v]) => [u, planeY, v];
    const corners3 = poly.map(to3);
    const xs = poly.map((p) => p[0]);
    let footprint, zRange;
    if (m.plane === 'L') {
      footprint = poly;
      zRange = [(m.z || 0) - m.thick / 2, (m.z || 0) + m.thick / 2];
    } else {
      footprint = [[Math.min(...xs), planeY - m.thick / 2], [Math.max(...xs), planeY - m.thick / 2], [Math.max(...xs), planeY + m.thick / 2], [Math.min(...xs), planeY + m.thick / 2]];
      const vs = poly.map((p) => p[1]);
      zRange = [Math.min(...vs), Math.max(...vs)];
    }
    const low = corners3.reduce((best, c) => (c[2] < best[2] - 1e-9 ? c : best), corners3[0]);
    const lowAll = corners3.filter((c) => Math.abs(c[2] - low[2]) < 0.05);
    const bearingPoint = [lowAll.reduce((s, c) => s + c[0], 0) / lowAll.length, lowAll.reduce((s, c) => s + c[1], 0) / lowAll.length, low[2]];
    const c2 = [m.u, m.v];
    const centroid = to3(c2);
    const { d: dir } = boxAxes(m);
    const ends = [to3([m.u - dir[0] * m.len / 2, m.v - dir[1] * m.len / 2]), to3([m.u + dir[0] * m.len / 2, m.v + dir[1] * m.len / 2])];
    const dims = [m.len, m.depth, m.thick];
    const fits = polyFits(poly, lim) && m.thick <= lim.thick + 1e-6;
    const lbPerFt = m.lbPerFt ?? d.lbPerFt;
    // Stands on a footing: set by hand, or (if never set) its lowest point is at ground level over one.
    const autoBearing = m.plane !== 'L' && Math.abs(low[2]) <= 0.5 && footings.some(([x0, x1]) => bearingPoint[0] >= x0 - 0.5 && bearingPoint[0] <= x1 + 0.5);
    const bearing = m.bearing == null ? autoBearing : !!m.bearing;
    return { ...m, bearing, autoBearing: m.bearing == null, poly, corners3, footprint, zRange, centroid, ends, bearingPoint, length: m.len, weight: (m.len / 12) * lbPerFt, box: { dims, fits } };
  });
  const memberById = new Map(members.map((m) => [m.id, m]));

  // Connections
  const contacts = [];
  const byPlane = { A: [], B: [], L: [] };
  for (const m of members) byPlane[m.plane].push(m);
  const add = (a, b, plane, c, pos3) => contacts.push({ id: 'j:' + pairKey(a.id, b.id) + ':' + plane, key: pairKey(a.id, b.id), a: a.id, b: b.id, plane, ...c, pos: pos3 });
  for (const plane of ['A', 'B']) {
    const list = byPlane[plane];
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const c = contact2d(list[i].poly, list[j].poly);
      if (!c) continue;
      const mid = c.kind === 'edge' ? [(c.seg[0][0] + c.seg[1][0]) / 2, (c.seg[0][1] + c.seg[1][1]) / 2] : polyCentroid(c.poly);
      add(list[i], list[j], plane, c, [mid[0], plane === 'A' ? 0 : S, mid[1]]);
    }
  }
  const lats = byPlane.L;
  for (let i = 0; i < lats.length; i++) {
    for (let j = i + 1; j < lats.length; j++) {
      const a = lats[i], b = lats[j];
      if (a.zRange[1] < b.zRange[0] - EPS_EDGE || b.zRange[1] < a.zRange[0] - EPS_EDGE) continue;
      const c = contact2d(a.poly, b.poly);
      if (!c) continue;
      const mid = c.kind === 'edge' ? [(c.seg[0][0] + c.seg[1][0]) / 2, (c.seg[0][1] + c.seg[1][1]) / 2] : polyCentroid(c.poly);
      add(a, b, 'L', c, [mid[0], mid[1], ((a.z || 0) + (b.z || 0)) / 2]);
    }
    // Lateral against a truss member: touch in the top view, and their heights overlap there.
    for (const t of [...byPlane.A, ...byPlane.B]) {
      const a = lats[i];
      let c = contact2d(a.poly, t.footprint);
      if (!c) continue;
      const pts = c.kind === 'edge' ? c.seg : c.poly;
      const x0 = Math.min(...pts.map((p) => p[0])) - EPS_EDGE, x1 = Math.max(...pts.map((p) => p[0])) + EPS_EDGE;
      const band = [[x0, a.zRange[0] - EPS_EDGE], [x1, a.zRange[0] - EPS_EDGE], [x1, a.zRange[1] + EPS_EDGE], [x0, a.zRange[1] + EPS_EDGE]];
      const xz = clipPoly(t.poly, band);
      if (xz.length < 3 || Math.abs(polyArea(xz)) < 0.01) continue;
      // Only the part of the top-view contact where the heights actually overlap.
      const hx0 = Math.min(...xz.map((p) => p[0])), hx1 = Math.max(...xz.map((p) => p[0]));
      if (c.kind === 'edge') {
        const [p, q] = c.seg;
        const clampX = (x) => Math.max(hx0, Math.min(hx1, x));
        const at = (x) => { const t2 = Math.abs(q[0] - p[0]) < 1e-9 ? 0 : (x - p[0]) / (q[0] - p[0]); return [x, p[1] + (q[1] - p[1]) * t2]; };
        if (Math.abs(q[0] - p[0]) > 1e-6) {
          const s0 = at(clampX(Math.min(p[0], q[0]))), s1 = at(clampX(Math.max(p[0], q[0])));
          if (Math.hypot(s1[0] - s0[0], s1[1] - s0[1]) < MIN_CONTACT && Math.abs(q[0] - p[0]) > MIN_CONTACT) continue;
          c = { kind: 'edge', seg: [s0, s1] };
        }
      } else {
        const clipped = clipPoly(c.poly, [[hx0, -1e4], [hx1, -1e4], [hx1, 1e4], [hx0, 1e4]]);
        if (clipped.length < 3) continue;
        c = { kind: 'overlap', poly: clipped };
      }
      const mid = c.kind === 'edge' ? [(c.seg[0][0] + c.seg[1][0]) / 2, (c.seg[0][1] + c.seg[1][1]) / 2] : polyCentroid(c.poly);
      add(a, t, 'L', c, [mid[0], mid[1], a.z || 0]);
    }
  }

  // Bolts: each belongs to every connection between two of its members that it sits on (one bolt
  // through three overlapping members holds all three together).
  const contactByKey = new Map();
  for (const c of contacts) {
    if (!contactByKey.has(c.key)) contactByKey.set(c.key, []);
    contactByKey.get(c.key).push(c);
  }
  const rawBolts = [];
  for (const b of d.bolts) {
    const ids = boltMembers(b);
    if (d.mirrorB && (b.plane === 'B' || ids.some((id) => d.members.find((m) => m.id === id)?.plane === 'B'))) continue;
    rawBolts.push(b);
    if (d.mirrorB && b.plane === 'A') {
      const mb = { ...b, id: b.id + MIRROR_SUFFIX, plane: 'B', a: b.a + MIRROR_SUFFIX, b: b.b + MIRROR_SUFFIX };
      if (b.more) mb.more = b.more.map((id) => id + MIRROR_SUFFIX);
      rawBolts.push(mb);
    }
  }
  const bolts = rawBolts.map((b) => {
    const ids = boltMembers(b);
    const p = [b.u, b.v];
    const joints = [];
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        for (const c of contactByKey.get(pairKey(ids[i], ids[j])) || []) {
          if (c.plane !== b.plane) continue;
          const ok = c.kind === 'edge' ? distToSegment2(p, c.seg[0], c.seg[1]).d <= BOLT_TOL : pointInPoly(p, c.poly, BOLT_TOL);
          if (ok) { joints.push(c); break; }
        }
      }
    }
    const joint = joints[0] || null;
    const pos = b.plane === 'L' ? [b.u, b.v, joint ? joint.pos[2] : 0] : [b.u, b.plane === 'A' ? 0 : S, b.v];
    return { ...b, memberIds: ids, jointId: joint ? joint.id : null, jointIds: joints.map((c) => c.id), pos };
  });
  for (const c of contacts) {
    const on = bolts.filter((b) => b.jointIds.includes(c.id));
    c.bolts = on.length;
    c.boltIds = on.map((b) => b.id);
  }

  return { members, memberById, contacts, joints: contacts, bolts, limits: lim };
}

// Point along a member's centerline, t = 0 at the back end, 1 at the front end (3D).
export function memberPoint(m, t) {
  return [m.ends[0][0] + (m.ends[1][0] - m.ends[0][0]) * t, m.ends[0][1] + (m.ends[1][1] - m.ends[0][1]) * t, m.ends[0][2] + (m.ends[1][2] - m.ends[0][2]) * t];
}

// ---------- site ----------
// Bridge (x, y) -> site plan (x, y).
export function bridgeToSite(site, x, y) {
  const r = ((site.bridge.rotation || 0) * Math.PI) / 180;
  const c = Math.cos(r), s = Math.sin(r);
  return { x: site.bridge.x + x * c - y * s, y: site.bridge.y + x * s + y * c };
}

export function siteToBridge(site, x, y) {
  const r = ((site.bridge.rotation || 0) * Math.PI) / 180;
  const c = Math.cos(r), s = Math.sin(r);
  const dx = x - site.bridge.x, dy = y - site.bridge.y;
  return { x: dx * c + dy * s, y: -dx * s + dy * c };
}

export function dist2d(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

// Distance from point p to segment ab ({x, y} points), and the parameter t along it.
export function pointSegment(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  const q = { x: a.x + dx * t, y: a.y + dy * t };
  return { d: dist2d(p, q), t, q };
}

// --- Image calibration -------------------------------------------------------------------
// A view's calibration is a similarity transform (scale + rotation + shift) from image pixels to
// view coordinates (u, v), stored as complex numbers a and b: w = a * z + b.
// Side views have v pointing up, so image pixels are flipped first (z = px - i*py).

const cmul = (p, q) => [p[0] * q[0] - p[1] * q[1], p[0] * q[1] + p[1] * q[0]];
const cdiv = (p, q) => { const d = q[0] * q[0] + q[1] * q[1] || 1; return [(p[0] * q[0] + p[1] * q[1]) / d, (p[1] * q[0] - p[0] * q[1]) / d]; };

export function imageToView(calib, flip, px, py) {
  const z = [px, flip ? -py : py];
  const w = cmul(calib.a, z);
  return { u: w[0] + calib.b[0], v: w[1] + calib.b[1] };
}

export function viewToImage(calib, flip, u, v) {
  const z = cdiv([u - calib.b[0], v - calib.b[1]], calib.a);
  return { px: z[0], py: flip ? -z[1] : z[1] };
}

export function calibFromPoints(flip, p1, p2) {
  const z1 = [p1.px, flip ? -p1.py : p1.py], z2 = [p2.px, flip ? -p2.py : p2.py];
  const dz = [z2[0] - z1[0], z2[1] - z1[1]];
  if (Math.hypot(dz[0], dz[1]) < 1e-6) return null;
  const a = cdiv([p2.u - p1.u, p2.v - p1.v], dz);
  const az1 = cmul(a, z1);
  return { a, b: [p1.u - az1[0], p1.v - az1[1]] };
}

// Starting calibration for a freshly loaded image: `widthIn` inches across, origin at the
// bottom-left corner (side views) or top-left corner (top view).
export function defaultCalib(img, flip, widthIn = 276) {
  const s = widthIn / (img.w || 1);
  return flip ? { a: [s, 0], b: [0, s * img.h] } : { a: [s, 0], b: [0, 0] };
}
