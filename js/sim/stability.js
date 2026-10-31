// "Basic physics": decides which installed pieces can stand on their own and which still need a
// builder (or a support tool) holding them.
//
// Each installed unit (a member, or an assembly) is a rigid body, and units joined by rigid
// connections are merged into one body. A body is stable when it is held in place at two
// different points by things that are already fixed, or at one point by a moment connection.
// Fixed things are:
//   - bearings (nodes marked as resting on a footing) and nodes with a support tool under them
//   - nodes of bodies that are already stable (but only through fastened bolts at that node)
//   - "triangle" joints: when two bodies, each already pinned at one other point, are bolted
//     together at a node and are not in a straight line, that node is fixed (this is what makes
//     a triangulated truss rigid even though every joint is a single-bolt pin).
// A joint counts as a moment connection when the body has at least `rigidBoltCount` fastened bolts
// there.
//
// Pieces a builder is holding can be passed in as `held`: a hand holds a piece firmly (like a
// moment connection), so a held piece counts as fixed and can hold up whatever is bolted to it,
// e.g. one builder holding a lateral that's bolted to both trusses holds both sides up.
//
// Known simplifications (good places to improve the model):
//   - out-of-plane tipping of a single truss is ignored
//   - deflection, bolt slop and member strength are ignored
//   - the check is conservative for some mechanisms that are actually stable (e.g. three-hinged
//     shapes that need two joints to be found at once)

const SUPPORT = '#support';
const JOINT = '#joint';

/**
 * @param {object} args
 * @param {{key: string, nodeIds: string[], attached: Record<string, number>}[]} args.units
 *        attached[nodeId] = number of fastened bolts this unit has at that node
 * @param {Set<string>} args.supportNodes bearing nodes and nodes with a support tool
 * @param {Map<string, {x:number,y:number,z:number}>} args.nodePos
 * @param {number} args.rigidBoltCount
 * @param {Set<string>} [args.held] unit keys being held by a builder
 * @returns {{stable: Set<string>, fixedNodes: Set<string>}}
 */
export function computeStability({ units, supportNodes, nodePos, rigidBoltCount, held = new Set() }) {
  // Pieces joined by rigid connections move together, so treat each rigidly connected group as
  // one body (a whole truss bolted with 2-bolt connections is one body pinned at its footings).
  const parent = new Map(units.map((u) => [u.key, u.key]));
  const find = (k) => { while (parent.get(k) !== k) { parent.set(k, parent.get(parent.get(k))); k = parent.get(k); } return k; };
  const rigidAt = new Map(); // nodeId -> unit keys rigidly attached there
  for (const u of units) {
    for (const [n, c] of Object.entries(u.attached)) {
      if (c < rigidBoltCount || supportNodes.has(n)) continue;
      if (!rigidAt.has(n)) rigidAt.set(n, []);
      rigidAt.get(n).push(u.key);
    }
  }
  for (const keys of rigidAt.values()) for (let i = 1; i < keys.length; i++) parent.set(find(keys[i]), find(keys[0]));
  const groups = new Map();
  for (const u of units) {
    const r = find(u.key);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(u);
  }
  const bodies = [];
  for (const [r, list] of groups) {
    if (list.length === 1) { bodies.push(list[0]); continue; }
    // Connections inside the group don't hold it to anything else.
    const count = new Map();
    for (const u of list) for (const n of u.nodeIds) count.set(n, (count.get(n) || 0) + 1);
    const nodeIds = [...count.keys()].filter((n) => supportNodes.has(n) || count.get(n) === 1);
    const attached = {};
    for (const u of list) for (const [n, c] of Object.entries(u.attached)) if (nodeIds.includes(n)) attached[n] = Math.max(attached[n] || 0, c);
    bodies.push({ key: 'group:' + r, nodeIds, attached, members: list.map((u) => u.key) });
  }
  const heldBodies = new Set(bodies.filter((b) => (b.members || [b.key]).some((k) => held.has(k))).map((b) => b.key));
  const res = solveBodies({ units: bodies, supportNodes, nodePos, rigidBoltCount, held: heldBodies });
  const stable = new Set();
  for (const b of bodies) if (res.stable.has(b.key)) for (const k of b.members || [b.key]) stable.add(k);
  return { stable, fixedNodes: res.fixedNodes };
}

function solveBodies({ units, supportNodes, nodePos, rigidBoltCount, held }) {
  const stable = new Set();
  const fixedBy = new Map();
  const addSource = (n, s) => {
    let set = fixedBy.get(n);
    if (!set) fixedBy.set(n, (set = new Set()));
    set.add(s);
  };
  for (const n of supportNodes) addSource(n, SUPPORT);
  for (const u of units) {
    if (!held.has(u.key)) continue;
    stable.add(u.key);
    for (const n of u.nodeIds) addSource(n, u.key);
  }

  const contactsOf = (u) => {
    const pts = [];
    let strong = false;
    for (const n of u.nodeIds) {
      const src = fixedBy.get(n);
      if (!src) continue;
      const bolts = u.attached[n] || 0;
      if (supportNodes.has(n)) {
        pts.push(n);
        // Bolted to a stable body that sits on the support: may also be a moment connection.
        if (bolts >= rigidBoltCount && [...src].some((s) => s !== u.key && s !== SUPPORT)) strong = true;
        continue;
      }
      if (bolts <= 0) continue;
      let other = false;
      for (const s of src) if (s !== u.key) { other = true; break; }
      if (!other) continue;
      pts.push(n);
      if (bolts >= rigidBoltCount) strong = true;
    }
    return { pts, strong };
  };

  let changed = true;
  let guard = 0;
  while (changed && guard++ < 10000) {
    changed = false;
    for (const u of units) {
      if (stable.has(u.key)) continue;
      const { pts, strong } = contactsOf(u);
      if (pts.length >= 2 || strong) {
        stable.add(u.key);
        for (const n of u.nodeIds) addSource(n, u.key);
        changed = true;
      }
    }
    if (changed) continue;

    // Triangle joints.
    const byNode = new Map();
    for (const u of units) {
      if (stable.has(u.key)) continue;
      const { pts } = contactsOf(u);
      if (pts.length !== 1) continue;
      const p = pts[0];
      for (const n of u.nodeIds) {
        if (n === p || fixedBy.has(n) || !(u.attached[n] > 0)) continue;
        if (!byNode.has(n)) byNode.set(n, []);
        byNode.get(n).push(p);
      }
    }
    for (const [n, anchors] of byNode) {
      if (anchors.length < 2) continue;
      const pn = nodePos.get(n);
      let found = false;
      for (let i = 0; i < anchors.length && !found; i++) {
        for (let j = i + 1; j < anchors.length && !found; j++) {
          if (anchors[i] === anchors[j]) continue;
          const a = nodePos.get(anchors[i]), b = nodePos.get(anchors[j]);
          const d1 = [pn.x - a.x, pn.y - a.y, pn.z - a.z], d2 = [pn.x - b.x, pn.y - b.y, pn.z - b.z];
          const c = [d1[1] * d2[2] - d1[2] * d2[1], d1[2] * d2[0] - d1[0] * d2[2], d1[0] * d2[1] - d1[1] * d2[0]];
          const l1 = Math.hypot(...d1), l2 = Math.hypot(...d2);
          if (Math.hypot(...c) > 0.05 * l1 * l2) found = true;
        }
      }
      if (found) { addSource(n, JOINT); changed = true; }
    }
  }
  return { stable, fixedNodes: new Set(fixedBy.keys()) };
}
