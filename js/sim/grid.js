// Walking paths on the site. The site is cut into square cells; a builder may stand in a cell if
// it is inside the site, not in a no-go zone, and (when the builder is restricted) inside one of
// their allowed zones. Paths are found with A* and then straightened.

export class SiteGrid {
  constructor(site) {
    this.site = site;
    this.cell = Math.max(2, site.cell || 6);
    this.nx = Math.max(1, Math.ceil(site.width / this.cell));
    this.ny = Math.max(1, Math.ceil(site.depth / this.cell));
    const n = this.nx * this.ny;
    this.nogo = new Uint8Array(n);
    this.zoneCells = new Map(); // zoneId -> Uint8Array
    for (const z of site.zones) {
      const arr = new Uint8Array(n);
      this.forCellsIn(z, (i) => { arr[i] = 1; if (z.type === 'nogo') this.nogo[i] = 1; });
      this.zoneCells.set(z.id, arr);
    }
    this.masks = new Map();
    this.pathCache = new Map();
    this.nearCache = new Map();
  }

  forCellsIn(z, fn) {
    const c = this.cell;
    const i0 = Math.max(0, Math.floor(z.x / c)), i1 = Math.min(this.nx - 1, Math.floor((z.x + z.w - 1e-6) / c));
    const j0 = Math.max(0, Math.floor(z.y / c)), j1 = Math.min(this.ny - 1, Math.floor((z.y + z.h - 1e-6) / c));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      // A cell belongs to the zone if its center is inside.
      const cx = (i + 0.5) * c, cy = (j + 0.5) * c;
      if (cx >= z.x && cx <= z.x + z.w && cy >= z.y && cy <= z.y + z.h) fn(j * this.nx + i);
    }
  }

  // zoneIds: null = anywhere that isn't no-go; otherwise only inside those zones.
  mask(zoneIds) {
    const key = zoneIds ? [...zoneIds].sort().join(',') : '*';
    let m = this.masks.get(key);
    if (m) return m;
    const n = this.nx * this.ny;
    const walk = new Uint8Array(n);
    const lists = zoneIds ? zoneIds.map((id) => this.zoneCells.get(id)).filter(Boolean) : null;
    for (let i = 0; i < n; i++) {
      if (this.nogo[i]) continue;
      walk[i] = lists ? (lists.some((a) => a[i]) ? 1 : 0) : 1;
    }
    m = { key, walk };
    this.masks.set(key, m);
    return m;
  }

  cellIndex(p) {
    const i = Math.min(this.nx - 1, Math.max(0, Math.floor(p.x / this.cell)));
    const j = Math.min(this.ny - 1, Math.max(0, Math.floor(p.y / this.cell)));
    return j * this.nx + i;
  }

  center(idx) {
    const i = idx % this.nx, j = (idx / this.nx) | 0;
    return { x: (i + 0.5) * this.cell, y: (j + 0.5) * this.cell };
  }

  inside(p) {
    return p.x >= 0 && p.y >= 0 && p.x <= this.site.width && p.y <= this.site.depth;
  }

  canStand(mask, p) {
    return this.inside(p) && mask.walk[this.cellIndex(p)] === 1;
  }

  // Closest place the builder can stand to point p: {x, y, dist} or null if the mask is empty.
  nearestStand(mask, p) {
    if (this.canStand(mask, p)) return { x: p.x, y: p.y, dist: 0 };
    const key = mask.key + '|' + Math.round(p.x * 2) + ',' + Math.round(p.y * 2);
    if (this.nearCache.has(key)) return this.nearCache.get(key);
    const ci = Math.min(this.nx - 1, Math.max(0, Math.floor(p.x / this.cell)));
    const cj = Math.min(this.ny - 1, Math.max(0, Math.floor(p.y / this.cell)));
    let best = null;
    const maxR = Math.max(this.nx, this.ny);
    for (let r = 0; r <= maxR; r++) {
      if (best && (r - 1) * this.cell > best.dist) break;
      for (let j = cj - r; j <= cj + r; j++) for (let i = ci - r; i <= ci + r; i++) {
        if (Math.max(Math.abs(i - ci), Math.abs(j - cj)) !== r) continue;
        if (i < 0 || j < 0 || i >= this.nx || j >= this.ny) continue;
        const idx = j * this.nx + i;
        if (!mask.walk[idx]) continue;
        // Stand at the point of the cell nearest to p (not just its center).
        const x = Math.min(Math.max(p.x, i * this.cell + 0.01), (i + 1) * this.cell - 0.01);
        const y = Math.min(Math.max(p.y, j * this.cell + 0.01), (j + 1) * this.cell - 0.01);
        const dist = Math.hypot(x - p.x, y - p.y);
        if (!best || dist < best.dist) best = { x, y, dist };
      }
    }
    this.nearCache.set(key, best);
    return best;
  }

  lineClear(mask, a, b) {
    const d = Math.hypot(b.x - a.x, b.y - a.y);
    const steps = Math.ceil(d / (this.cell * 0.4));
    for (let k = 1; k < steps; k++) {
      const t = k / steps;
      if (!mask.walk[this.cellIndex({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t })]) return false;
    }
    return true;
  }

  // Path from a to b: {points, length} or null when b can't be reached.
  path(mask, a, b) {
    if (Math.hypot(a.x - b.x, a.y - b.y) < 1e-6) return { points: [a, b], length: 0 };
    const s = this.cellIndex(a), g = this.cellIndex(b);
    if (!mask.walk[s] || !mask.walk[g]) {
      // Start or goal is off-limits (e.g. a builder standing on a zone edge): allow the straight
      // hop only if everything between is walkable, otherwise route from the nearest cells.
      const as = this.nearestStand(mask, a), bs = this.nearestStand(mask, b);
      if (!as || !bs) return null;
      if (as.dist > this.cell * 1.5 || bs.dist > this.cell * 1.5) return null;
      const inner = this.path(mask, as, bs);
      if (!inner) return null;
      const points = [a, ...inner.points, b];
      return { points, length: polyLength(points) };
    }
    if (s === g || this.lineClear(mask, a, b)) return { points: [a, b], length: Math.hypot(a.x - b.x, a.y - b.y) };
    const key = mask.key + '|' + s + '|' + g;
    let cells = this.pathCache.get(key);
    if (cells === undefined) {
      cells = this.astar(mask, s, g);
      this.pathCache.set(key, cells);
    }
    if (!cells) return null;
    const raw = [a, ...cells.slice(1, -1).map((c) => this.center(c)), b];
    // Straighten: keep only the corners where a straight line would cross blocked cells.
    const points = [raw[0]];
    let i = 0;
    while (i < raw.length - 1) {
      let j = raw.length - 1;
      while (j > i + 1 && !this.lineClear(mask, raw[i], raw[j])) j--;
      points.push(raw[j]);
      i = j;
    }
    return { points, length: polyLength(points) };
  }

  astar(mask, s, g) {
    const nx = this.nx, n = nx * this.ny;
    const gs = new Float64Array(n).fill(Infinity);
    const came = new Int32Array(n).fill(-1);
    const closed = new Uint8Array(n);
    const gx = g % nx, gy = (g / nx) | 0;
    const h = (idx) => {
      const dx = Math.abs((idx % nx) - gx), dy = Math.abs(((idx / nx) | 0) - gy);
      return Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy);
    };
    const heap = new MinHeap();
    gs[s] = 0;
    heap.push(h(s), s);
    while (heap.size) {
      const cur = heap.pop();
      if (cur === g) break;
      if (closed[cur]) continue;
      closed[cur] = 1;
      const cx = cur % nx, cy = (cur / nx) | 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const x = cx + dx, y = cy + dy;
        if (x < 0 || y < 0 || x >= nx || y >= this.ny) continue;
        const nb = y * nx + x;
        if (!mask.walk[nb] || closed[nb]) continue;
        if (dx && dy && (!mask.walk[cy * nx + x] || !mask.walk[y * nx + cx])) continue; // no corner cutting
        const cost = gs[cur] + (dx && dy ? Math.SQRT2 : 1);
        if (cost < gs[nb]) { gs[nb] = cost; came[nb] = cur; heap.push(cost + h(nb), nb); }
      }
    }
    if (gs[g] === Infinity) return null;
    const cells = [];
    for (let c = g; c !== -1; c = came[c]) cells.push(c);
    return cells.reverse();
  }
}

export function polyLength(points) {
  let l = 0;
  for (let i = 1; i < points.length; i++) l += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  return l;
}

// Position at distance d along a polyline.
export function pointAlong(points, d) {
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    const l = Math.hypot(b.x - a.x, b.y - a.y);
    if (d <= l || i === points.length - 1) {
      const t = l ? Math.min(1, Math.max(0, d / l)) : 1;
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, dir: Math.atan2(b.y - a.y, b.x - a.x) };
    }
    d -= l;
  }
  const p = points[points.length - 1];
  return { x: p.x, y: p.y, dir: 0 };
}

class MinHeap {
  constructor() { this.k = []; this.v = []; }
  get size() { return this.k.length; }
  push(key, val) {
    const k = this.k, v = this.v;
    let i = k.length;
    k.push(key); v.push(val);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= key) break;
      k[i] = k[p]; v[i] = v[p]; i = p;
    }
    k[i] = key; v[i] = val;
  }
  pop() {
    const k = this.k, v = this.v;
    const top = v[0];
    const lk = k.pop(), lv = v.pop();
    if (k.length) {
      let i = 0;
      const n = k.length;
      while (true) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && k[c + 1] < k[c]) c++;
        if (k[c] >= lk) break;
        k[i] = k[c]; v[i] = v[c]; i = c;
      }
      k[i] = lk; v[i] = lv;
    }
    return top;
  }
}
