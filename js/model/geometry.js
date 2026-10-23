// Geometry: turns the stored design into a 3D model, checks members against the size box,
// and maps bridge coordinates onto the site plan.
//
// Bridge coordinates: x along the span, y across (truss A at y = 0, truss B at y = trussSpacing), z up.
import { MIRROR_SUFFIX } from './ids.js';

export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const len = (a) => Math.hypot(a[0], a[1], a[2]);
export const norm = (a) => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
export const nodeVec = (n) => [n.x, n.y, n.z];

function mirrorName(name) {
  if (/^A[-_ ]/.test(name)) return 'B' + name.slice(1);
  return name + ' (B)';
}

// Build the full 3D model, including generated truss-B copies when mirrorB is on.
export function buildModel(project) {
  const d = project.design;
  const nodes = new Map();
  for (const n of d.nodes) {
    if (d.mirrorB && n.plane === 'B') continue;
    const y = n.plane === 'A' ? 0 : n.plane === 'B' ? d.trussSpacing : n.y;
    nodes.set(n.id, { ...n, y });
  }
  if (d.mirrorB) {
    for (const n of d.nodes) {
      if (n.plane !== 'A') continue;
      const id = n.id + MIRROR_SUFFIX;
      nodes.set(id, { ...n, id, plane: 'B', y: d.trussSpacing, mirrorOf: n.id });
    }
  }

  const rawMembers = [];
  for (const m of d.members) {
    if (d.mirrorB && m.plane === 'B') continue;
    rawMembers.push(m);
    if (d.mirrorB && m.plane === 'A') {
      rawMembers.push({
        ...m,
        id: m.id + MIRROR_SUFFIX,
        name: mirrorName(m.name),
        plane: 'B',
        segments: m.segments.map(([a, b]) => [a + MIRROR_SUFFIX, b + MIRROR_SUFFIX]),
        mirrorOf: m.id,
      });
    }
  }

  const members = [];
  const memberById = new Map();
  for (const m of rawMembers) {
    const segments = m.segments.filter(([a, b]) => nodes.has(a) && nodes.has(b) && a !== b);
    if (!segments.length) continue;
    const nodeIds = [...new Set(segments.flat())];
    const tube = { ...d.tube, ...(m.tube || {}) };
    let length = 0;
    let cx = 0, cy = 0, cz = 0;
    for (const [a, b] of segments) {
      const pa = nodeVec(nodes.get(a)), pb = nodeVec(nodes.get(b));
      const l = len(sub(pb, pa));
      length += l;
      cx += (pa[0] + pb[0]) / 2 * l; cy += (pa[1] + pb[1]) / 2 * l; cz += (pa[2] + pb[2]) / 2 * l;
    }
    const centroid = length ? [cx / length, cy / length, cz / length] : nodeVec(nodes.get(nodeIds[0]));
    const lbPerFt = m.lbPerFt ?? d.lbPerFt;
    const mm = { ...m, segments, nodeIds, tube, length, centroid, weight: (length / 12) * lbPerFt };
    mm.box = boxFit(mm, nodes, d.box);
    members.push(mm);
    memberById.set(mm.id, mm);
  }

  const bolts = [];
  const pushBolt = (b, memberId) => {
    const m = memberById.get(memberId);
    if (!m) return;
    const raw = rawMembers.find((r) => r.id === memberId);
    const seg = raw && raw.segments[b.seg];
    if (!seg || !nodes.has(seg[0]) || !nodes.has(seg[1])) return;
    const pa = nodeVec(nodes.get(seg[0])), pb = nodeVec(nodes.get(seg[1]));
    const s = Math.min(1, Math.max(0, b.s));
    bolts.push({ ...b, memberId, s, nodeId: s < 0.5 ? seg[0] : seg[1], pos: add(pa, scale(sub(pb, pa), s)) });
  };
  for (const b of d.bolts) {
    const m = d.members.find((x) => x.id === b.memberId);
    if (!m || (d.mirrorB && m.plane === 'B')) continue;
    pushBolt(b, b.memberId);
    if (d.mirrorB && m.plane === 'A') pushBolt({ ...b, id: b.id + MIRROR_SUFFIX }, b.memberId + MIRROR_SUFFIX);
  }

  return { nodes, members, memberById, bolts };
}

// Does the member fit inside the size box (any orientation)? Members are treated as bars of the
// tube cross-section, so their outline grows by the tube size on every side (a conservative check).
export function boxFit(member, nodes, box) {
  const pts = member.nodeIds.map((id) => nodeVec(nodes.get(id)));
  const { w, d } = member.tube;
  const target = [...box].sort((a, b) => a - b);
  // Find the member's plane from its segment directions.
  const dirs = member.segments.map(([a, b]) => sub(nodeVec(nodes.get(b)), nodeVec(nodes.get(a)))).filter((v) => len(v) > 1e-6);
  let u = dirs.length ? norm(dirs[0]) : [1, 0, 0];
  let normal = null;
  for (const v of dirs) {
    const c = cross(u, v);
    if (len(c) > 1e-3 * len(v)) { normal = norm(c); break; }
  }
  if (!normal) {
    // Straight member: pick any normal, preferring the truss plane normal (y) so w/d stay meaningful.
    const guess = Math.abs(u[1]) < 0.9 ? [0, 1, 0] : [0, 0, 1];
    normal = norm(cross(u, cross(guess, u)));
  }
  const v = cross(normal, u);
  const p0 = pts[0];
  const local = pts.map((p) => { const q = sub(p, p0); return [dot(q, u), dot(q, v), dot(q, normal)]; });
  const ns = local.map((p) => p[2]);
  const thickness = Math.max(...ns) - Math.min(...ns) + w;

  const evalAngle = (deg) => {
    const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
    let minA = Infinity, maxA = -Infinity, minB = Infinity, maxB = -Infinity;
    for (const p of local) {
      const pa = p[0] * c + p[1] * s, pb = -p[0] * s + p[1] * c;
      if (pa < minA) minA = pa; if (pa > maxA) maxA = pa;
      if (pb < minB) minB = pb; if (pb > maxB) maxB = pb;
    }
    const dims = [maxA - minA + d, maxB - minB + d, thickness].sort((x, y) => x - y);
    const score = Math.max(dims[0] / target[0], dims[1] / target[1], dims[2] / target[2]);
    return { dims, score, deg };
  };
  // `best` = orientation that fits most easily (may be tilted inside the box);
  // `snug` = tightest outline (smallest area), which is what we report as the member's size.
  let best = evalAngle(0), snug = best;
  const area = (r) => r.dims[0] * r.dims[1] * r.dims[2]; // thickness is the same at every angle
  for (let deg = 0; deg < 180; deg += 1) {
    const r = evalAngle(deg);
    if (r.score < best.score) best = r;
    if (area(r) < area(snug) - 1e-9) snug = r;
  }
  for (let deg = best.deg - 1; deg <= best.deg + 1; deg += 0.05) { const r = evalAngle(deg); if (r.score < best.score) best = r; }
  for (let deg = snug.deg - 1; deg <= snug.deg + 1; deg += 0.05) { const r = evalAngle(deg); if (area(r) < area(snug) - 1e-9) snug = r; }
  const round = (x) => Math.round(x * 100) / 100;
  return { dims: snug.dims.map(round), fits: best.score <= 1 + 1e-9, tilted: best.score <= 1 + 1e-9 && snug.score > 1 + 1e-9, score: best.score };
}

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

// Distance from point p to segment ab (2D), and the parameter t along it.
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
export function defaultCalib(img, flip, widthIn = 240) {
  const s = widthIn / (img.w || 1);
  return flip ? { a: [s, 0], b: [0, s * img.h] } : { a: [s, 0], b: [0, 0] };
}
