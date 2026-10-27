// Snapping for box members: line a box's edge up with an edge of a nearby box (parallel and on
// the same line), then slide it so corners or midpoints line up too. Works on any outline
// (rectangles and reshaped boxes) as a list of corners.
import { boxCorners, polyCentroid, polyEdges } from '../model/geometry.js';

const deg = (r) => (r * 180) / Math.PI;

function edgeInfo([a, b]) {
  const d = [b[0] - a[0], b[1] - a[1]];
  const l = Math.hypot(d[0], d[1]) || 1;
  return { a, b, dir: [d[0] / l, d[1] / l], len: l, ang: deg(Math.atan2(d[1], d[0])) };
}

// Smallest rotation (degrees) that makes two directions parallel (either way round).
function parallelDelta(a1, a2) {
  let d = ((a2 - a1) % 180 + 180) % 180;
  if (d > 90) d -= 180;
  return d;
}

export function rotatePoly(poly, degrees, pivot) {
  const a = (degrees * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  return poly.map(([x, y]) => {
    const dx = x - pivot[0], dy = y - pivot[1];
    return [pivot[0] + dx * c - dy * s, pivot[1] + dx * s + dy * c];
  });
}

/**
 * How to move an outline so one of its edges lands on an edge of a target.
 * @returns {{dx, dy, rot, pivot, lines}} rot in degrees about pivot (applied before dx, dy)
 */
export function snapPoly(poly, targets, tol, { angTol = 4, rotate = true } = {}) {
  const pivot = polyCentroid(poly);
  const none = { dx: 0, dy: 0, rot: 0, pivot, lines: [] };
  const edges = polyEdges(poly).map(edgeInfo);
  let best = null;
  for (const t of targets) {
    for (const fe of polyEdges(t)) {
      const f = edgeInfo(fe);
      if (f.len < 0.05) continue;
      for (let i = 0; i < edges.length; i++) {
        if (edges[i].len < 0.05) continue;
        const dA = parallelDelta(edges[i].ang, f.ang);
        if (Math.abs(dA) > (rotate ? angTol : 0.01)) continue;
        const rp = rotate && dA ? rotatePoly(poly, dA, pivot) : poly;
        const e2 = edgeInfo(polyEdges(rp)[i]);
        const n = [-f.dir[1], f.dir[0]];
        const off = (f.a[0] - e2.a[0]) * n[0] + (f.a[1] - e2.a[1]) * n[1];
        if (Math.abs(off) > tol) continue;
        // Edges must face each other along their length (overlap or nearly).
        const proj = (p) => (p[0] - f.a[0]) * f.dir[0] + (p[1] - f.a[1]) * f.dir[1];
        const s0 = Math.min(proj(e2.a), proj(e2.b)), s1 = Math.max(proj(e2.a), proj(e2.b));
        if (s1 < -tol || s0 > f.len + tol) continue;
        const score = Math.abs(off) + Math.abs(dA) * 0.05;
        if (!best || score < best.score) best = { score, dA: rotate ? dA : 0, off, n, f, s0, s1 };
      }
    }
  }
  if (!best) return none;
  const { dA, off, n, f, s0, s1 } = best;
  let dx = n[0] * off, dy = n[1] * off;
  // Slide along the edge so ends or midpoints line up, if one is close.
  const shifts = [0 - s0, f.len - s1, 0 - s1, f.len - s0, f.len / 2 - (s0 + s1) / 2].filter((s) => Math.abs(s) <= tol);
  if (shifts.length) {
    const s = shifts.reduce((p, q) => (Math.abs(q) < Math.abs(p) ? q : p));
    dx += f.dir[0] * s; dy += f.dir[1] * s;
  }
  return { dx, dy, rot: dA, pivot, lines: [[f.a, f.b]] };
}

export function applySnap(poly, s) {
  const r = s.rot ? rotatePoly(poly, s.rot, s.pivot) : poly;
  return r.map(([x, y]) => [x + s.dx, y + s.dy]);
}

/**
 * @param {object} box {u, v, angle, len, depth}
 * @returns {{box: object, lines: Array}} snapped box and the target edges it snapped to (for drawing)
 */
export function snapBox(box, targets, tol, angTol = 4) {
  const s = snapPoly(boxCorners(box), targets, tol, { angTol });
  if (!s.lines.length) return { box, lines: [] };
  // A rectangle's centroid is its center, so rotating about the pivot keeps u, v.
  return { box: { ...box, angle: box.angle + s.rot, u: box.u + s.dx, v: box.v + s.dy }, lines: s.lines };
}

// Snap a point (a dragged corner, or where a new box starts) to the nearest corner of a target,
// else onto its nearest edge. Returns {p, line} (line = the edge it landed on, for drawing).
export function snapPoint(p, targets, tol) {
  let corner = null, best = null;
  for (const t of targets) {
    for (const c of t) {
      const d = Math.hypot(c[0] - p[0], c[1] - p[1]);
      if (d <= tol && (!corner || d < corner.d)) corner = { kind: 'corner', d, p: [c[0], c[1]], line: null };
    }
  }
  for (const t of targets) {
    for (const [a, b] of polyEdges(t)) {
      const ab = [b[0] - a[0], b[1] - a[1]], l2 = ab[0] * ab[0] + ab[1] * ab[1];
      if (l2 < 1e-9) continue;
      const tt = Math.max(0, Math.min(1, ((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1]) / l2));
      const q = [a[0] + ab[0] * tt, a[1] + ab[1] * tt];
      const d = Math.hypot(q[0] - p[0], q[1] - p[1]);
      if (d <= tol && (!best || d < best.d)) best = { kind: 'edge', d, p: q, line: [a, b] };
    }
  }
  // A corner wins unless the nearest edge is clearly closer (corners are what you usually want).
  if (corner && (!best || corner.d <= best.d + tol * 0.4)) return corner;
  return best || { kind: null, d: 0, p, line: null };
}

// Snap one moving edge of a box while resizing. `axis` 'len' | 'depth', `sign` +1 front/top,
// -1 back/bottom. Returns the snapped size (or the given one).
export function snapSize(box, axis, sign, size, targets, tol) {
  const a = (box.angle * Math.PI) / 180;
  const d = axis === 'len' ? [Math.cos(a), Math.sin(a)] : [-Math.sin(a), Math.cos(a)];
  const half = axis === 'len' ? box.len / 2 : box.depth / 2;
  // The fixed edge stays put: it's on the opposite side from the one being dragged.
  const fixed = [box.u - d[0] * half * sign, box.v - d[1] * half * sign];
  let best = null;
  for (const t of targets) {
    for (const fe of polyEdges(t)) {
      const f = edgeInfo(fe);
      // Target edge must be perpendicular to the drag direction (parallel to the moving edge).
      if (Math.abs(f.dir[0] * d[0] + f.dir[1] * d[1]) > Math.sin((3 * Math.PI) / 180)) continue;
      const dist = ((f.a[0] - fixed[0]) * d[0] + (f.a[1] - fixed[1]) * d[1]) * sign;
      if (dist <= 0) continue;
      if (Math.abs(dist - size) <= tol && (!best || Math.abs(dist - size) < Math.abs(best - size))) best = dist;
    }
  }
  return best ?? size;
}

// Rotation snapping: other boxes' angles, then 15° steps.
export function snapAngle(angle, others, tol = 3) {
  let best = null;
  for (const o of others) {
    for (const cand of [o.angle, o.angle + 90]) {
      const dA = parallelDelta(angle, cand);
      if (Math.abs(dA) <= tol && (!best || Math.abs(dA) < Math.abs(best))) best = dA;
    }
  }
  if (best != null) return angle + best;
  const step = Math.round(angle / 15) * 15;
  return Math.abs(step - angle) <= 2 ? step : angle;
}
