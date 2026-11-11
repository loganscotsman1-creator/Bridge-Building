// Snapping site zones (axis-aligned rectangles) to the site's edges and to each other's edges
// while they're dragged or resized, so a layout can be laid out quickly and exactly.

// Lines a zone can snap to along one axis: the site's two edges and every other zone's two edges.
export function snapLines(site, skipId) {
  const xs = [0, site.width], ys = [0, site.depth];
  for (const z of site.zones) {
    if (z.id === skipId) continue;
    xs.push(z.x, z.x + z.w);
    ys.push(z.y, z.y + z.h);
  }
  return { x: [...new Set(xs)], y: [...new Set(ys)] };
}

// The nearest line to any of `edges` within `tol`: {shift, at} or null.
function nearest(edges, lines, tol) {
  let best = null;
  for (const e of edges) {
    for (const l of lines) {
      const d = l - e;
      if (Math.abs(d) <= tol && (!best || Math.abs(d) < Math.abs(best.shift))) best = { shift: d, at: l };
    }
  }
  return best;
}

/**
 * Move a zone to (x, y), snapping either of its edges on each axis to a nearby line.
 * @returns {{x, y, guides: Array<{axis: 'x'|'y', at: number}>}}
 */
export function snapZoneMove(site, zone, x, y, tol) {
  const L = snapLines(site, zone.id);
  const guides = [];
  const sx = nearest([x, x + zone.w], L.x, tol);
  if (sx) { x += sx.shift; guides.push({ axis: 'x', at: sx.at }); }
  const sy = nearest([y, y + zone.h], L.y, tol);
  if (sy) { y += sy.shift; guides.push({ axis: 'y', at: sy.at }); }
  return { x, y, guides };
}

// Snap one moving edge (a coordinate on `axis`) while resizing. Returns {at, guide}.
export function snapZoneEdge(site, zone, axis, at, tol) {
  const s = nearest([at], snapLines(site, zone.id)[axis], tol);
  return s ? { at: s.at, guide: { axis, at: s.at } } : { at, guide: null };
}

// Read a length typed as inches ("150", "150 in", '150"') or feet and inches ("12'", "12' 6\"",
// "12 ft 6 in", "12ft"). Returns inches, or null if it isn't a length.
export function parseLength(text) {
  const s = String(text ?? '').trim().toLowerCase();
  if (!s) return null;
  const num = '(-?\\d+(?:\\.\\d+)?)';
  let m = s.match(new RegExp('^' + num + "\\s*(?:'|ft|feet|foot)\\s*(?:" + num + '\\s*(?:"|in|inch|inches)?)?$'));
  if (m) return parseFloat(m[1]) * 12 + (m[2] ? parseFloat(m[2]) : 0);
  m = s.match(new RegExp('^' + num + '\\s*(?:"|in|inch|inches)?$'));
  return m ? parseFloat(m[1]) : null;
}

// Inches as feet and inches for showing next to a field: 150 → 12' 6".
export function feetInches(inches) {
  if (!Number.isFinite(inches)) return '';
  const neg = inches < 0;
  let a = Math.abs(inches);
  let ft = Math.floor(a / 12 + 1e-9), inch = Math.round((a - ft * 12) * 100) / 100;
  if (inch >= 12) { ft++; inch -= 12; }
  return (neg ? '-' : '') + (ft ? ft + "'" : '') + (inch || !ft ? (ft ? ' ' : '') + inch + '"' : '');
}
