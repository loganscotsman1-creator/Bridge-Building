// The shape of a project file, plus defaults. All lengths are inches, all times are seconds.
//
// project
//   design   – the bridge as marked up on screenshots: nodes (joints), members (made of
//              segments between nodes), bolts, and the screenshots with their scale
//   site     – ground layout: zones, where the bridge sits, where hardware and pieces start
//   tools    – impact drivers, jack stands, etc.
//   timing   – how long things take
//   builders – the crew
//   plans    – build sequences (several, so you can compare variants)
import { uid } from './ids.js';

export const SCHEMA_VERSION = 1;

export const ZONE_TYPES = {
  staging: { label: 'Staging yard', color: '#2563eb' },
  construction: { label: 'Construction zone', color: '#16a34a' },
  assembly: { label: 'Ground assembly area', color: '#9333ea' },
  nogo: { label: 'No-go (river / off limits)', color: '#dc2626' },
  walkway: { label: 'Walkway / transit', color: '#64748b' },
};

export const ROLES = {
  any: 'Any task (adapts)',
  carrier: 'Carrier / holder',
  fastener: 'Fastener',
  assembler: 'Ground assembler',
};

export const TOOL_KINDS = {
  fastener: 'Fastening tool',
  support: 'Temporary support',
  other: 'Other',
};

export const DEFAULT_TIMING = {
  walkSpeed: 54, // in/s walking empty-handed (4.5 ft/s)
  carrySpeed: 36, // in/s while carrying a member or assembly
  pickupTime: 2, // s to pick up or set down a piece
  alignTime: 6, // s to line up one bolted joint
  boltTimeHand: 12, // s per bolt with no fastening tool (insert + hand tighten)
  assemblyJoinTime: 0, // s to add one member to a ground assembly; 0 = align time + bolt times
  gearUpTime: 2, // s to grab one tool or the nuts & bolts at the start
  soloMultiplier: 1.5, // align/fasten time multiplier when the carrier fastens while holding
  maxReach: 40, // in a builder can reach from where they stand
};

export const DEFAULT_COLORS = ['#e11d48', '#2563eb', '#16a34a', '#d97706', '#7c3aed', '#0891b2', '#db2777', '#65a30d'];

export function emptyView() {
  return { imageId: null, calib: null, scaled: false, opacity: 0.6 };
}

export function emptySite() {
  return {
    name: 'Untitled site',
    year: '',
    notes: '',
    width: 600,
    depth: 360,
    cell: 6,
    zones: [],
    bridge: { x: 120, y: 150, rotation: 0 },
    hardware: { x: 40, y: 40 },
    staging: {}, // memberId -> {x, y}; members without an entry are laid out automatically
  };
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
      trussSpacing: 30, // centerline distance between truss A and truss B
      mirrorB: true,
      box: [4, 6, 42],
      tube: { w: 1, d: 1 }, // default member cross-section: w = out of the member's plane, d = in plane
      lbPerFt: 1.2,
      rigidBoltCount: 2, // a joint with at least this many bolts resists rotation (can cantilever)
      views: { sideA: emptyView(), sideB: emptyView(), top: emptyView() },
      isoRefs: [], // [{imageId, caption}]
      nodes: [], // {id, plane: 'A'|'B'|'L', x, y, z, bearing}
      members: [], // {id, name, plane, segments: [[nodeId, nodeId]], tube?, lbPerFt?, color?}
      bolts: [], // {id, memberId, seg, s}  (s = 0..1 along that segment)
    },
    site: emptySite(),
    tools: [], // {id, name, kind, count, boltTime, placeTime, removeTime, start: {x, y}, notes}
    timing: { ...DEFAULT_TIMING },
    builders: [], // {id, name, color, role, start: {x, y}, allowedZones: null | [zoneId], loadout: [toolId], hardware}
    plans: [plan],
    activePlanId: plan.id,
  };
}

// Fill in anything missing so older or hand-edited files still load.
export function normalizeProject(p) {
  const base = emptyProject();
  const out = { ...base, ...p };
  out.design = { ...base.design, ...(p.design || {}) };
  out.design.views = { ...base.design.views, ...(out.design.views || {}) };
  for (const k of Object.keys(base.design.views)) out.design.views[k] = { ...emptyView(), ...out.design.views[k] };
  out.design.tube = { ...base.design.tube, ...out.design.tube };
  out.site = normalizeSite(p.site || {});
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

export function normalizeSite(s) {
  const base = emptySite();
  return { ...base, ...s, bridge: { ...base.bridge, ...(s.bridge || {}) }, hardware: { ...base.hardware, ...(s.hardware || {}) }, zones: s.zones || [], staging: s.staging || {} };
}

export function activePlan(project) {
  return project.plans.find((p) => p.id === project.activePlanId) || project.plans[0];
}
