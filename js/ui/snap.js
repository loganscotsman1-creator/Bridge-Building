// Snapping for box members: line a box's edge up with an edge of a nearby box (parallel and on
// the same line), then slide it so corners or midpoints line up too.
import { boxCorners, polyEdges } from '../model/geometry.js';

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

/**
 * @param {object} box {u, v, angle, len, depth}
 * @param {Array<[number, number][]>} targets outlines (lists of corners) to snap to
 * @param {number} tol world distance that counts as "close"
 * @returns {{box: object, lines: Array}} snapped box and the target edges it snapped to (for drawing)
 */
export function snapBox(box, targets, tol, angTol = 4) {
  const edges = polyEdges(boxCorners(box)).map(edgeInfo);
  let best = null;
  for (const t of targets) {
    for (const fe of polyEdges(t)) {
      const f = edgeInfo(fe);
      if (f.len < 0.05) continue;
      for (let i = 0; i < 4; i++) {
        const dA = parallelDelta(edges[i].ang, f.ang);
        if (Math.abs(dA) > angTol) continue;
        const b2 = { ...box, angle: box.angle + dA };
        const e2 = edgeInfo(polyEdges(boxCorners(b2))[i]);
        const n = [-f.dir[1], f.dir[0]];
        const off = (f.a[0] - e2.a[0]) * n[0] + (f.a[1] - e2.a[1]) * n[1];
        if (Math.abs(off) > tol) continue;
        // Only snap edges that face each other or overlap along their length.
        const proj = (p) => (p[0] - f.a[0]) * f.dir[0] + (p[1] - f.a[1]) * f.dir[1];
        const s0 = Math.min(proj(e2.a), proj(e2.b)), s1 = Math.max(proj(e2.a), proj(e2.b));
        if (s1 < -tol || s0 > f.len + tol) continue;
        const score = Math.abs(off) + Math.abs(dA) * 0.05;
        if (!best || score < best.score) best = { score, i, dA, off, n, f, s0, s1 };
      }
    }
  }
  if (!best) return { box, lines: [] };
  const { dA, off, n, f, s0, s1 } = best;
  let out = { ...box, angle: box.angle + dA, u: box.u + n[0] * off, v: box.v + n[1] * off };
  // Slide along the edge so ends or midpoints line up, if one is close.
  const shifts = [0 - s0, f.len - s1, 0 - s1, f.len - s0, f.len / 2 - (s0 + s1) / 2].filter((s) => Math.abs(s) <= tol);
  if (shifts.length) {
    const s = shifts.reduce((p, q) => (Math.abs(q) < Math.abs(p) ? q : p));
    out = { ...out, u: out.u + f.dir[0] * s, v: out.v + f.dir[1] * s };
  }
  return { box: out, lines: [[f.a, f.b]] };
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
