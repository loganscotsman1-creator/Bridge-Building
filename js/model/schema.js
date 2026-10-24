// The shape of a project file, plus defaults. All lengths are inches, all times are seconds.
//
// project
//   design   – the bridge as marked up on screenshots: members are box outlines placed over a
//              view (everything inside a box is one rigid welded piece), bolts sit where boxes
//              touch, plus the screenshots with their scale
//   site     – ground layout: zones, where the bridge sits, where pieces start, and the
//              competition rules for that year (they travel together in shared layout files)
//   tools    – impact drivers, jack stands, etc.
//   timing   – how long things take
//   builders – the crew
//   plans    – build sequences (several, so you can compare variants)
import { uid } from './ids.js';
import { RULES_2027, site2027 } from './rules2027.js';

export const SCHEMA_VERSION = 2;

// Zone types. `walk`: builders may stand there. `work`: builders standing there may touch the
// bridge. `stage`: counts as a staging yard (start/finish, ground assembly).
export const ZONE_TYPES = {
  staging: { label: 'Staging yard', color: '#2563eb', walk: true, stage: true },
  members: { label: 'Members area', color: '#0369a1', walk: true, stage: true, sub: true },
  tools: { label: 'Tools area', color: '#0e7490', walk: true, stage: true, sub: true },
  hardware: { label: 'Nuts & bolts area', color: '#a16207', walk: true, stage: true, sub: true },
  builders: { label: 'Builders area', color: '#4338ca', walk: true, stage: true, sub: true },
  construction: { label: 'Construction zone', color: '#16a34a', walk: true, work: true },
  riverbank: { label: 'Riverbank', color: '#65a30d', walk: true, work: true },
  footing: { label: 'Footing', color: '#b45309', walk: true, work: true, sub: true },
  transport: { label: 'Transportation zone', color: '#64748b', walk: true },
  nogo: { label: 'River / no-go', color: '#dc2626', walk: false },
  assembly: { label: 'Ground assembly area', color: '#9333ea', walk: true },
  walkway: { label: 'Walkway', color: '#94a3b8', walk: true },
};

export const ROLES = {
  any: 'Any task (adapts)',
  carrier: 'Carrier / holder',
  fastener: 'Fastener',
  assembler: 'Staging-yard assembler',
};

export const TOOL_KINDS = {
  fastener: 'Fastening tool',
  support: 'Temporary support',
  other: 'Other',
};

export const DEFAULT_TIMING = {
  walkSpeed: 54, // in/s walking empty-handed (4.5 ft/s)
  carrySpeed: 36, // in/s while carrying a member or assembly
  pickupTime: 2, // s to pick up, set down, or hand off a piece
  alignTime: 6, // s to line up one bolted connection
  boltTimeHand: 12, // s per bolt with no fastening tool (insert + hand tighten)
  assemblyJoinTime: 0, // s to add one member to an assembly; 0 = align time + bolt times
  gearUpTime: 2, // s to grab one tool or the nuts & bolts at the start
  soloMultiplier: 1.5, // align/fasten time multiplier when the carrier fastens while holding
  maxReach: 40, // in a builder can reach from where they stand
  passReach: 90, // in between two builders handing a piece across (e.g. over the river)
};

export const DEFAULT_COLORS = ['#e11d48', '#2563eb', '#16a34a', '#d97706', '#7c3aed', '#0891b2', '#db2777', '#65a30d'];

export function emptyView() {
  return { imageId: null, calib: null, scaled: false, opacity: 0.6 };
}

export function emptyPlan(name = 'Plan 1') {
  return { id: uid('p'), name, assemblies: [], steps: [] };
}

export function emptyProject() {
  const plan = emptyPlan();
  return {
    version: SCHEMA_VERSION,
    name: 'Untitled bridge',
    images: {}, // imageId -> {url (data URL), w, h, name}
    design: {
      trussSpacing: 38, // centerline distance between truss A and truss B
      mirrorB: true,
      lbPerFt: 1.2,
      rigidBoltCount: 2, // a connection with at least this many bolts resists rotation (can cantilever)
      views: { sideA: emptyView(), sideB: emptyView(), top: emptyView() },
      isoRefs: [], // [{imageId, caption}]
      // Box members. plane A/B: drawn on a side view (u = x along the span, v = z up).
      // plane L (laterals): drawn on the top view (u = x, v = y across), centered at height z.
      // len × depth is the outline in its view; thick is the size out of the view.
      members: [], // {id, name, plane, u, v, angle (deg), len, depth, thick, z?, bearing, lbPerFt?, color?}
      bolts: [], // {id, plane, a, b, u, v}: a bolt through members a and b, at (u, v) on that plane's view
    },
    site: site2027(),
    tools: [], // {id, name, kind, count, boltTime, placeTime, removeTime, start: {x, y}, notes}
    timing: { ...DEFAULT_TIMING },
    builders: [], // {id, name, color, role, start: {x, y}, allowedZones: null | [zoneId], loadout: [toolId], hardware}
    plans: [plan],
    activePlanId: plan.id,
  };
}

// Box limits from the rules, sorted: [length, depth, thickness].
export function boxLimits(project) {
  const b = [...(project.site.rules?.box || RULES_2027.box)].sort((x, y) => y - x);
  return { len: b[0], depth: b[1], thick: b[2] };
}

// Fill in anything missing so older or hand-edited files still load.
export function normalizeProject(p) {
  const base = emptyProject();
  const out = { ...base, ...p };
  out.design = { ...base.design, ...(p.design || {}) };
  out.design.views = { ...base.design.views, ...(out.design.views || {}) };
  for (const k of Object.keys(base.design.views)) out.design.views[k] = { ...emptyView(), ...out.design.views[k] };
  out.site = normalizeSite(p.site || base.site);
  if ((p.version || 1) < 2) upgradeV1(out, p);
  out.design.members = (out.design.members || []).map((m) => ({ bearing: false, angle: 0, z: 0, ...m }));
  out.timing = { ...DEFAULT_TIMING, ...(p.timing || {}) };
  out.images = p.images || {};
  out.tools = (p.tools || []).map((t) => ({ kind: 'other', count: 1, boltTime: 4, placeTime: 6, removeTime: 5, start: { x: 0, y: 0 }, notes: '', ...t }));
  out.builders = (p.builders || []).map((b, i) => ({
    role: 'any', color: DEFAULT_COLORS[i % DEFAULT_COLORS.length], start: { x: 0, y: 0 }, allowedZones: null, loadout: [], hardware: true, ...b,
  }));
  out.plans = (p.plans && p.plans.length ? p.plans : base.plans).map((pl) => ({ assemblies: [], steps: [], ...pl }));
  if (!out.plans.some((pl) => pl.id === out.activePlanId)) out.activePlanId = out.plans[0].id;
  out.version = SCHEMA_VERSION;
  return out;
}

// Version 1 traced members as lines between joints. Turn each straight line into a box of the
// old tube size; bolts and supports-at-joints can't carry over.
function upgradeV1(out, p) {
  const d = p.design || {};
  const nodes = new Map((d.nodes || []).map((n) => [n.id, n]));
  const tube = d.tube || { w: 1, d: 1 };
  const members = [];
  for (const m of d.members || []) {
    if (!m.segments) { members.push(m); continue; }
    m.segments.forEach(([a, b], i) => {
      const na = nodes.get(a), nb = nodes.get(b);
      if (!na || !nb) return;
      const top = m.plane === 'L';
      const pa = top ? [na.x, na.y] : [na.x, na.z], pb = top ? [nb.x, nb.y] : [nb.x, nb.z];
      const len = Math.hypot(pb[0] - pa[0], pb[1] - pa[1]);
      members.push({
        id: i ? m.id + '-' + i : m.id, name: i ? m.name + '.' + i : m.name, plane: m.plane,
        u: (pa[0] + pb[0]) / 2, v: (pa[1] + pb[1]) / 2, angle: (Math.atan2(pb[1] - pa[1], pb[0] - pa[0]) * 180) / Math.PI,
        len, depth: (m.tube && m.tube.d) || tube.d, thick: (m.tube && m.tube.w) || tube.w, z: top ? na.z : 0,
        bearing: !!(na.bearing || nb.bearing), color: m.color,
      });
    });
  }
  out.design = { ...out.design, members, bolts: [] };
  delete out.design.nodes;
  delete out.design.tube;
  delete out.design.box;
  for (const pl of out.plans || []) pl.steps = (pl.steps || []).filter((s) => s.kind !== 'support');
  // Version 1 only had an invented example site; start from the official layout instead.
  out.site = site2027();
}

export function normalizeSite(s) {
  const base = site2027();
  const out = { ...base, ...s, bridge: { ...base.bridge, ...(s.bridge || {}) }, zones: s.zones || [], staging: s.staging || {} };
  out.rules = { ...RULES_2027, ...(s.rules || {}) };
  // Older files had a single nuts & bolts spot.
  if (s.hardware && !out.zones.some((z) => z.type === 'hardware')) {
    out.zones = [...out.zones, { id: 'z-hw-legacy', name: 'Nuts & bolts', type: 'hardware', x: s.hardware.x - 12, y: s.hardware.y - 12, w: 24, h: 24 }];
  }
  delete out.hardware;
  return out;
}

export function activePlan(project) {
  return project.plans.find((p) => p.id === project.activePlanId) || project.plans[0];
}
