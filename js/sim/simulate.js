// Build simulator. Walks through the plan's steps in order and schedules every builder:
// walking, carrying, handing pieces across, holding, aligning, fastening, assembling in the
// staging yard and placing/removing supports.
//
// Scheduling is greedy: each step takes the builder(s) who can get to the work soonest (or the
// ones the plan assigns). Steps overlap whenever builders are free, but pieces are placed on the
// bridge in plan order. A builder who places a piece keeps holding it until the stability model
// (stability.js) says it stands on its own.
//
// Rules modelled (2027 numbering; the values live in site.rules so they can change by year):
//   - a builder outside the staging yard carries only one member or assembly at a time (10.3.8)
//   - builders never enter the river, so they can't cross it (10.3.6); pieces are handed across
//   - builders touch the bridge only from a construction zone, footing or riverbank (10.3.12)
//   - tools and hardware are picked up after the clock starts (10.6.3)
//   - assemblies have at most N members and are made only in a staging yard (10.3.7), right
//     where their members are staged
//   - each constructed portion starts on a footing (10.3.11)
//   - builders finish in a staging yard and supports are picked back up (10.9.1)
import { buildModel, bridgeToSite, dist2d, memberPoint } from '../model/geometry.js';
import { activePlan, ZONE_TYPES } from '../model/schema.js';
import { planUnits, stagingSpots, stepLabel, jointLabel } from '../model/plan.js';
import { SiteGrid } from './grid.js';
import { computeStability } from './stability.js';

const CARRY_ROLES = new Set(['any', 'carrier']);
const FASTEN_ROLES = new Set(['any', 'fastener']);
const FETCH_ROLES = new Set(['any', 'carrier', 'assembler']);
const ASSEMBLE_ROLES = new Set(['any', 'assembler', 'fastener']);
const SUPPORT_ROLES = new Set(['any', 'carrier', 'fastener', 'assembler']);

export const SEGMENT_KINDS = {
  walk: { label: 'Walking', color: '#cbd5e1' },
  carry: { label: 'Carrying', color: '#60a5fa' },
  pickup: { label: 'Pick up / set down / hand off', color: '#93c5fd' },
  gear: { label: 'Grabbing tools / hardware', color: '#94a3b8' },
  wait: { label: 'Waiting', color: '#f1f5f9' },
  hold: { label: 'Holding a piece', color: '#f97316' },
  align: { label: 'Aligning', color: '#fde047' },
  fasten: { label: 'Fastening', color: '#ca8a04' },
  assemble: { label: 'Assembling (staging yard)', color: '#a855f7' },
  support: { label: 'Placing / removing support', color: '#14b8a6' },
};

export function simulate(project, plan = activePlan(project)) {
  const sim = new Sim(project, plan);
  try {
    sim.run();
  } catch (e) {
    console.error(e);
    sim.error('The simulation stopped with an internal error: ' + e.message);
  }
  return sim.result();
}

const inZone = (z, p) => p.x >= z.x - 1e-6 && p.x <= z.x + z.w + 1e-6 && p.y >= z.y - 1e-6 && p.y <= z.y + z.h + 1e-6;

class Sim {
  constructor(project, plan) {
    this.project = project;
    this.plan = plan;
    this.T = project.timing;
    this.site = project.site;
    this.rules = project.site.rules || {};
    this.model = buildModel(project);
    this.grid = new SiteGrid(project.site);
    this.segments = [];
    this.holds = [];
    this.boltsDone = new Set(); // bolts put in so far (a bolt through 3+ members goes in once)
    this.credited = new Set(); // "boltId|connectionId" pairs already counted toward stability
    this.boltById = new Map(this.model.bolts.map((b) => [b.id, b]));
    this.jointById = new Map(this.model.contacts.map((c) => [c.id, c]));
    this.warnings = [];
    this.errors = [];
    this.tracks = new Map(); // memberId -> [{t, kind: staging|carried|ground|bridge, x, y, builderId}]
    this.unitStatus = new Map(); // unitKey -> [{t, status: held|stable|unstable}]
    this.supportEvents = [];
    this.stepTimes = [];
    this.lastPlace = 0;
    this.lastWorkEnd = 0;
    this.aborted = false;
    this.warned = new Set();

    const zones = this.site.zones;
    const idsOf = (pred) => zones.filter((z) => pred(ZONE_TYPES[z.type] || {}, z)).map((z) => z.id);
    this.workZones = idsOf((t) => t.work);
    this.stageZones = idsOf((t) => t.stage);

    // Positions of everything the stability model and the builders refer to.
    this.nodePos = new Map();
    for (const j of this.model.joints) this.nodePos.set(j.id, { x: j.pos[0], y: j.pos[1], z: j.pos[2] });
    for (const m of this.model.members) {
      const p = { x: m.bearingPoint[0], y: m.bearingPoint[1], z: m.bearingPoint[2] };
      this.nodePos.set('brg:' + m.id, p);
      this.nodePos.set('sup:' + m.id, p);
    }
    this.bearings = new Set(this.model.members.filter((m) => m.bearing).map((m) => 'brg:' + m.id));
    this.supported = new Map(); // 'sup:memberId' -> count of support tools under it

    // Units
    const { units } = planUnits(this.model, plan);
    const spots = stagingSpots(project, this.model);
    this.units = new Map();
    for (const u of units) {
      this.units.set(u.key, {
        ...u, joints: [], fastened: {}, attached: {},
        installed: false, built: u.type === 'member', stable: false, holder: null, pos: null, readyAt: 0,
        pos3: null,
      });
      if (u.type === 'member') this.units.get(u.key).pos = spots.get(u.id);
    }
    this.unitOfMember = new Map();
    for (const u of this.units.values()) for (const m of u.memberIds) this.unitOfMember.set(m, u);
    for (const j of this.model.joints) {
      const ua = this.unitOfMember.get(j.a), ub = this.unitOfMember.get(j.b);
      if (!ua || !ub) continue;
      if (ua === ub) { ua.internal = ua.internal || []; ua.internal.push(j); continue; }
      ua.joints.push(j);
      ub.joints.push(j);
    }
    for (const u of this.units.values()) {
      u.nodeIds = [...u.joints.map((j) => j.id), ...u.memberIds.flatMap((m) => ['brg:' + m, 'sup:' + m])];
    }
    for (const m of this.model.members) {
      const s = spots.get(m.id);
      this.tracks.set(m.id, [{ t: 0, kind: 'staging', x: s.x, y: s.y }]);
      if (!this.grid.inside(s)) this.warn(`${m.name} starts outside the site.`);
    }

    // Builders
    const zoneIds = new Set(zones.map((z) => z.id));
    if (project.builders.length > (this.rules.maxBuilders ?? Infinity)) this.error(`The rules allow at most ${this.rules.maxBuilders} builders; this crew has ${project.builders.length} (10.2.2).`);
    const builderAreas = zones.filter((z) => z.type === 'builders');
    this.builders = project.builders.map((b) => {
      let allowed = b.allowedZones && b.allowedZones.length ? b.allowedZones.filter((id) => zoneIds.has(id)) : null;
      if (b.allowedZones && b.allowedZones.length && !allowed.length) {
        this.warn(`${b.name}'s allowed zones no longer exist on this site, so they may go anywhere.`);
        allowed = null;
      }
      const mask = this.grid.mask(allowed);
      let pos = { ...b.start };
      if (!this.grid.canStand(mask, pos)) {
        const near = this.grid.nearestStand(mask, pos);
        if (near) { this.warn(`${b.name} starts somewhere they aren't allowed to stand; moved to the nearest allowed spot.`); pos = { x: near.x, y: near.y }; }
      }
      if (builderAreas.length && !builderAreas.some((z) => inZone(z, pos))) this.warn(`${b.name} doesn't start in a builders area of a staging yard (10.6.3).`);
      return {
        id: b.id, name: b.name, role: b.role || 'any', color: b.color, start: pos, pos, freeAt: 0, holding: null, holdSince: 0,
        mask, work: this.grid.maskAnd(mask, this.workZones), stage: this.grid.maskAnd(mask, this.stageZones),
        gear: [], hardware: false, boltTime: this.T.boltTimeHand, tasks: 0,
      };
    });
    this.builderById = new Map(this.builders.map((b) => [b.id, b]));

    // Tool instances
    this.toolInst = [];
    const toolAreas = zones.filter((z) => z.type === 'tools');
    for (const tool of project.tools) {
      if (toolAreas.length && !toolAreas.some((z) => inZone(z, tool.start))) this.warn(`${tool.name} doesn't start in a tools area of a staging yard (10.6.1).`);
      for (let i = 0; i < Math.max(0, tool.count | 0); i++) {
        this.toolInst.push({ key: tool.id + '#' + i, tool, pos: { ...tool.start }, carriedBy: null, placedAt: null });
      }
    }
    this.checkLayout(spots);
  }

  // Static checks of the design against the site and rules.
  checkLayout(spots) {
    const zones = this.site.zones;
    const memberAreas = zones.filter((z) => z.type === 'members');
    if (memberAreas.length) {
      const out = this.model.members.filter((m) => !memberAreas.some((z) => inZone(z, spots.get(m.id))));
      if (out.length) this.warn(`${out.length} member${out.length === 1 ? '' : 's'} start outside the members area (10.6.1.4): ${out.slice(0, 4).map((m) => m.name).join(', ')}${out.length > 4 ? ', …' : ''}.`);
    }
    const footings = zones.filter((z) => z.type === 'footing');
    if (footings.length) {
      for (const m of this.model.members.filter((x) => x.bearing)) {
        const p = bridgeToSite(this.site, m.bearingPoint[0], m.bearingPoint[1]);
        if (!footings.some((z) => inZone(z, p))) this.warn(`${m.name} is marked as resting on a footing, but it isn't over one on the site (9.3.1).`);
      }
    }
    // 10.3.14: no part of the bridge in the transportation zone or a staging yard.
    const banned = zones.filter((z) => z.type === 'transport' || ZONE_TYPES[z.type]?.stage);
    const hits = new Set();
    for (const m of this.model.members) {
      for (const [x, y] of m.footprint) {
        const p = bridgeToSite(this.site, x, y);
        for (const z of banned) if (inZone(z, p)) hits.add(z.name);
      }
    }
    if (hits.size) this.error(`Part of the bridge extends into ${[...hits].join(', ')} (10.3.14).`);
    const loose = this.model.contacts.filter((c) => c.bolts === 0);
    if (loose.length) this.warn(`Members touch without a bolt at ${loose.length} place${loose.length === 1 ? '' : 's'} (9.5.1: every place members touch needs a connection): ${loose.slice(0, 4).map((c) => jointLabel(this.model, c)).join('; ')}${loose.length > 4 ? '; …' : ''}.`);
    const orphans = this.model.bolts.filter((b) => !b.jointId);
    if (orphans.length) this.warn(`${orphans.length} bolt${orphans.length === 1 ? ' is' : 's are'} no longer on a place where two members touch (a member moved). They're shown in red in tab 1.`);
    const big = this.model.members.filter((m) => !m.box.fits);
    if (big.length) this.error(`${big.length} member${big.length === 1 ? ' is' : 's are'} bigger than the ${this.model.limits.len} × ${this.model.limits.depth} × ${this.model.limits.thick} in box (8.2.2.2).`);
  }

  // ---------- bookkeeping ----------
  warn(msg, stepIndex = this.stepIndex) {
    if (this.warned.has(msg)) return;
    this.warned.add(msg);
    this.warnings.push({ msg, step: stepIndex });
  }

  error(msg, stepIndex = this.stepIndex) {
    this.errors.push({ msg, step: stepIndex });
  }

  seg(b, kind, t0, t1, extra = {}) {
    if (t1 - t0 < 1e-6 && kind !== 'pickup') return;
    this.segments.push({ builderId: b.id, kind, t0, t1, x: b.pos.x, y: b.pos.y, step: this.stepIndex, ...extra });
    b.freeAt = t1;
  }

  speed(carrying) {
    return Math.max(1, carrying ? this.T.carrySpeed : this.T.walkSpeed);
  }

  travel(b, from, to, carrying) {
    const r = this.grid.path(b.mask, from, to);
    if (!r) return null;
    return { ...r, time: r.length / this.speed(carrying) };
  }

  go(b, to, kind, extra = {}) {
    const r = this.travel(b, b.pos, to, kind === 'carry');
    if (!r) {
      this.error(`${b.name} can't find a path to (${Math.round(to.x)}, ${Math.round(to.y)}) without leaving their allowed zones or crossing the river.`);
      return false;
    }
    if (r.length > 0.01) {
      this.segments.push({ builderId: b.id, kind, t0: b.freeAt, t1: b.freeAt + r.time, x: b.pos.x, y: b.pos.y, path: r.points, step: this.stepIndex, ...extra });
      b.freeAt += r.time;
    }
    b.pos = { x: to.x, y: to.y };
    return true;
  }

  waitUntil(b, t, kind = 'wait', extra = {}) {
    if (t > b.freeAt + 1e-6) this.seg(b, kind, b.freeAt, t, extra);
  }

  track(memberIds, t, ev) {
    for (const id of memberIds) this.tracks.get(id).push({ t, ...ev });
  }

  status(u, t, status) {
    if (!this.unitStatus.has(u.key)) this.unitStatus.set(u.key, []);
    this.unitStatus.get(u.key).push({ t, status });
  }

  nodeSite(nodeId) {
    const n = this.nodePos.get(nodeId);
    return bridgeToSite(this.site, n.x, n.y);
  }

  // Where builder b should stand to reach one of the target points. `area`: 'walk' (anywhere they
  // may go) or 'work' (where they may touch the bridge).
  standFor(b, targets, area = 'walk') {
    const mask = area === 'work' ? b.work : b.mask;
    let best = null;
    for (const p of targets) {
      const s = this.grid.nearestStand(mask, p);
      if (!s) continue;
      // Must also be reachable from where the builder is (same side of the river).
      const score = s.dist + 0.01 * dist2d(b.pos, s);
      if (!best || score < best.score) {
        if (!this.grid.path(b.mask, b.pos, s)) continue;
        best = { stand: { x: s.x, y: s.y }, reach: s.dist, target: p, score };
      }
    }
    return best;
  }

  unitTargets(u) {
    const pts = [];
    for (const id of u.memberIds) {
      const m = this.model.memberById.get(id);
      const k = Math.max(1, Math.ceil(m.len / 6));
      for (let i = 0; i <= k; i++) {
        const p = memberPoint(m, i / k);
        pts.push(bridgeToSite(this.site, p[0], p[1]));
      }
    }
    return pts;
  }

  available(b, exclude) {
    return !b.holding && b.id !== exclude && Number.isFinite(b.freeAt);
  }

  pool(roles, explicit, what, exclude = null) {
    if (explicit && explicit !== 'auto' && explicit !== 'carrier') {
      const b = this.builderById.get(explicit);
      if (!b) this.warn(`A step is assigned to a builder who no longer exists; picking automatically.`);
      else if (b.holding) this.warn(`${b.name} is assigned to ${what} but is still holding ${this.units.get(b.holding).name}; picking someone else.`);
      else if (b.id === exclude) this.warn(`${b.name} can't do ${what} while holding the piece; picking someone else.`);
      else return [b];
    }
    return this.builders.filter((b) => roles.has(b.role));
  }

  // Choose the builder who can reach `dest(b)` soonest. Returns {b, d} or null.
  pick(roles, explicit, dest, readyTime, exclude = null, what = 'this task') {
    let best = null;
    for (const b of this.pool(roles, explicit, what, exclude)) {
      if (!this.available(b, exclude)) continue;
      const d = dest(b);
      if (!d) continue;
      const r = this.travel(b, b.pos, d.to, false);
      if (!r) continue;
      const at = Math.max(b.freeAt + r.time + (d.extra || 0), readyTime);
      const score = at + b.tasks * 1e-3;
      if (!best || score < best.score) best = { b, score, d };
    }
    return best;
  }

  noBuilder(what) {
    const holding = this.builders.filter((b) => b.holding).map((b) => `${b.name} (holding ${this.units.get(b.holding).name})`);
    let msg = `No builder can do "${what}".`;
    if (holding.length) msg += ' Busy holding unstable pieces: ' + holding.join(', ') + '. Add a support, change the order, or add builders.';
    else msg += ' Check builder roles, which side of the river they start on, and their allowed zones.';
    this.error(msg);
    this.aborted = true;
  }

  // ---------- stability ----------
  // Which pieces stand on their own, and which builders can let go. A held piece counts as
  // fixed, so it can hold up what's bolted to it; a holder lets go as soon as everything that's up
  // stays up without them (pieces that now stand on their own first, then the longest-held, so
  // the builder holding the newest piece is the one who keeps holding).
  updateStability(t) {
    const installed = [...this.units.values()].filter((u) => u.installed);
    const supportNodes = new Set(this.bearings);
    for (const [n, c] of this.supported) if (c > 0) supportNodes.add(n);
    const solve = (held) => computeStability({
      units: installed.map((u) => ({ key: u.key, nodeIds: u.nodeIds, attached: u.attached })),
      supportNodes,
      nodePos: this.nodePos,
      rigidBoltCount: this.project.design.rigidBoltCount,
      held,
    }).stable;
    const real = solve(new Set());
    let holds = new Set(installed.filter((u) => u.holder).map((u) => u.key));
    let up = solve(holds);
    const order = [...holds].sort((a, b) => (real.has(b) - real.has(a)) || (this.units.get(a).holdStart - this.units.get(b).holdStart));
    for (const k of order) {
      const next = new Set(holds);
      next.delete(k);
      const s = solve(next);
      if ([...up].every((x) => s.has(x))) {
        const u = this.units.get(k);
        // Who keeps it up now: the held piece it would fall without (for the holding table).
        let by = null;
        if (!real.has(k)) {
          for (const h of next) {
            const fewer = new Set(next);
            fewer.delete(h);
            if (!solve(fewer).has(k)) { by = this.units.get(h); break; }
          }
        }
        holds = next;
        up = s;
        this.release(u, t, by);
      }
    }
    for (const u of installed) {
      const now = real.has(u.key);
      if (now && !u.stable) {
        u.stable = true;
        u.stableAt = t;
        this.status(u, t, 'stable');
      } else if (!now && u.stable) {
        u.stable = false;
        this.status(u, t, up.has(u.key) ? 'held' : 'unstable');
      }
      // Up only because someone is holding it or a piece it's bolted to.
      if (!now && !up.has(u.key) && !u.fell) {
        u.fell = true;
        this.status(u, t, 'unstable');
        this.error(`${u.name} loses its support at ${fmt(t)} and would fall.`);
      } else if (up.has(u.key)) u.fell = false;
    }
  }

  release(u, t, heldUpBy = null) {
    const b = this.builderById.get(u.holder);
    const rec = this.holds.find((h) => h.unitKey === u.key && h.end == null);
    if (rec) {
      rec.end = t;
      if (heldUpBy) rec.heldUpBy = { name: heldUpBy.name, builder: this.builderById.get(heldUpBy.holder)?.name };
    }
    u.holder = null;
    b.holding = null;
    if (!Number.isFinite(b.freeAt)) {
      if (t - b.holdSince > 1e-6) this.segments.push({ builderId: b.id, kind: 'hold', t0: b.holdSince, t1: t, x: b.pos.x, y: b.pos.y, unitKey: u.key, label: 'Holding ' + u.name, step: rec ? rec.step : this.stepIndex });
      b.freeAt = t;
    }
  }

  // ---------- phases ----------
  run() {
    this.stepIndex = -1;
    this.gearUp();
    const steps = this.plan.steps;
    for (let i = 0; i < steps.length && !this.aborted; i++) {
      this.stepIndex = i;
      const s = steps[i];
      const before = this.segments.length;
      if (s.kind === 'build') this.doBuild(s);
      else if (s.kind === 'install') this.doInstall(s);
      else if (s.kind === 'support') this.doSupport(s);
      const segs = this.segments.slice(before);
      this.stepTimes[i] = segs.length ? { start: Math.min(...segs.map((x) => x.t0)), end: Math.max(...segs.map((x) => x.t1)) } : null;
    }
    this.stepIndex = null;
    this.finish();
  }

  gearUp() {
    const taken = new Set();
    const hwZones = this.site.zones.filter((z) => z.type === 'hardware');
    for (const b of this.builders) {
      const src = this.project.builders.find((x) => x.id === b.id);
      const items = [];
      for (const toolId of src.loadout || []) {
        const insts = this.toolInst.filter((ti) => ti.tool.id === toolId && !taken.has(ti.key));
        const inst = insts.find((ti) => this.grid.path(b.mask, b.pos, ti.pos) || this.grid.nearestStand(b.mask, ti.pos)?.dist < this.T.maxReach);
        if (!inst) {
          const tool = this.project.tools.find((t) => t.id === toolId);
          if (tool) this.warn(insts.length ? `${b.name} can't reach a ${tool.name} from their side of the site.` : `Not enough ${tool.name}s: ${b.name} starts without one.`);
          continue;
        }
        taken.add(inst.key);
        items.push({ pos: inst.pos, inst });
      }
      if (src.hardware) {
        const reachable = hwZones.map((z) => ({ x: z.x + z.w / 2, y: z.y + z.h / 2 })).filter((p) => this.standFor(b, [p]));
        reachable.sort((p, q) => dist2d(b.pos, p) - dist2d(b.pos, q));
        if (reachable.length) items.push({ pos: reachable[0], hardware: true });
        else this.warn(`${b.name} has no nuts & bolts area they can reach.`);
      }
      while (items.length) {
        items.sort((p, q) => dist2d(b.pos, p.pos) - dist2d(b.pos, q.pos));
        const it = items.shift();
        const stand = this.standFor(b, [it.pos]);
        if (!stand || !this.go(b, stand.stand, 'walk', { label: 'To ' + (it.hardware ? 'nuts & bolts' : it.inst.tool.name) })) continue;
        this.seg(b, 'gear', b.freeAt, b.freeAt + this.T.gearUpTime, { label: 'Grab ' + (it.hardware ? 'nuts & bolts' : it.inst.tool.name) });
        if (it.hardware) b.hardware = true;
        else { it.inst.carriedBy = b.id; b.gear.push(it.inst); }
      }
      const fasteners = b.gear.filter((g) => g.tool.kind === 'fastener');
      if (fasteners.length) b.boltTime = Math.min(...fasteners.map((g) => g.tool.boltTime));
    }
  }

  // Where an assembly is put together: a staging yard (2027) or an assembly area.
  assemblyZone(u) {
    const zones = this.site.zones;
    const chosen = zones.find((z) => z.id === u.assembly.areaZoneId);
    if (this.rules.assemblyIn === 'assembly') return chosen && chosen.type === 'assembly' ? chosen : zones.find((z) => z.type === 'assembly');
    if (chosen && chosen.type === 'staging') return chosen;
    const first = this.tracks.get(u.memberIds[0])[0];
    return zones.find((z) => z.type === 'staging' && inZone(z, first)) || zones.find((z) => z.type === 'staging');
  }

  assemblySpot(zone, slot) {
    // Lay assemblies out along the zone's middle, away from the edges.
    const cols = Math.max(1, Math.floor((zone.w - 10) / 50));
    const col = slot % cols, row = Math.floor(slot / cols);
    return { x: Math.min(zone.x + zone.w - 5, zone.x + 30 + col * 50), y: Math.min(zone.y + zone.h - 5, zone.y + zone.h * 0.7 + row * 14) };
  }

  doBuild(step) {
    const u = this.units.get('a:' + step.assemblyId);
    if (!u) { this.warn('An assemble step refers to an assembly that no longer exists; skipped.'); return; }
    if (u.built) { this.warn(`${u.name} is assembled more than once in the plan; extra step skipped.`); return; }
    if (!u.memberIds.length) { this.warn(`${u.name} has no members.`); u.built = true; return; }
    const max = this.rules.maxAssemblyMembers ?? Infinity;
    if (u.memberIds.length > max) this.error(`${u.name} has ${u.memberIds.length} members; the rules allow at most ${max} (10.3.7).`);
    if (u.memberIds.length < 2) this.warn(`${u.name} has only one member, so it isn't really an assembly.`);
    if (this.rules.assemblyIn !== 'assembly') { this.buildInPlace(step, u); return; }
    const zone = this.assemblyZone(u);
    if (!zone) { this.error(`${u.name} needs a ${this.rules.assemblyIn === 'assembly' ? 'ground-assembly area' : 'staging yard'} to be assembled in, but the site has none.`); this.aborted = true; return; }
    this.assemblySlots = (this.assemblySlots || 0) + 1;
    const spot = this.assemblySpot(zone, this.assemblySlots - 1);

    const arrivals = [];
    u.memberIds.forEach((id, k) => {
      if (this.aborted) return;
      const m = this.model.memberById.get(id);
      const from = this.tracks.get(id)[0];
      const drop = { x: spot.x, y: spot.y + (k - (u.memberIds.length - 1) / 2) * 4 };
      const choice = this.pick(FETCH_ROLES, 'auto', (b) => {
        const st = this.standFor(b, [from]);
        return st && this.standFor(b, [drop]) && { to: st.stand };
      }, 0, null, `fetch ${m.name}`);
      if (!choice) { this.noBuilder(`fetch ${m.name} for ${u.name}`); return; }
      const b = choice.b;
      b.tasks++;
      this.go(b, choice.d.to, 'walk', { label: 'To ' + m.name });
      this.seg(b, 'pickup', b.freeAt, b.freeAt + this.T.pickupTime, { label: 'Pick up ' + m.name });
      this.track([id], b.freeAt, { kind: 'carried', builderId: b.id });
      const dst = this.standFor(b, [drop]);
      this.go(b, dst.stand, 'carry', { label: `Carry ${m.name} to ${zone.name}`, memberIds: [id] });
      this.seg(b, 'pickup', b.freeAt, b.freeAt + this.T.pickupTime, { label: 'Set down ' + m.name });
      this.track([id], b.freeAt, { kind: 'ground', x: drop.x, y: drop.y });
      arrivals.push({ id, t: b.freeAt });
    });
    if (this.aborted) return;
    arrivals.sort((a, b) => a.t - b.t);

    const choice = this.pick(ASSEMBLE_ROLES, step.builder, (b) => {
      const st = this.standFor(b, [spot]);
      return st && { to: st.stand };
    }, arrivals.length > 1 ? arrivals[1].t : arrivals[0].t, null, `assemble ${u.name}`);
    if (!choice) { this.noBuilder(`assemble ${u.name}`); return; }
    const a = choice.b;
    a.tasks++;
    this.go(a, choice.d.to, 'walk', { label: 'To ' + zone.name });
    const joined = new Set([arrivals[0].id]);
    for (let i = 1; i < arrivals.length; i++) {
      const id = arrivals[i].id;
      this.waitUntil(a, arrivals[i].t);
      const inner = (u.internal || []).filter((j) => (j.a === id && joined.has(j.b)) || (j.b === id && joined.has(j.a)));
      if (!inner.length) this.warn(`${this.model.memberById.get(id).name} doesn't touch the rest of ${u.name}.`);
      const dur = this.joinTime(a, inner, joined, id);
      this.seg(a, 'assemble', a.freeAt, a.freeAt + dur, { label: `Bolt ${this.model.memberById.get(id).name} into ${u.name}`, unitKey: u.key });
      joined.add(id);
    }
    for (const j of u.internal || []) u.fastened[j.id] = true;
    u.built = true;
    u.readyAt = a.freeAt;
    u.pos = spot;
    this.track(u.memberIds, a.freeAt, { kind: 'ground', x: spot.x, y: spot.y, assembled: true });
  }

  // Assemblies are bolted together right where their members are staged (they're staged ready to
  // connect), so nothing is carried; an assembler walks over and joins them one by one.
  buildInPlace(step, u) {
    const spots = u.memberIds.map((id) => this.tracks.get(id)[0]);
    const spot = { x: spots.reduce((s, p) => s + p.x, 0) / spots.length, y: spots.reduce((s, p) => s + p.y, 0) / spots.length };
    const yards = this.site.zones.filter((z) => ZONE_TYPES[z.type]?.stage);
    if (yards.length && !spots.every((p) => yards.some((z) => inZone(z, p)))) this.error(`${u.name} is assembled where its members are staged, but some aren't in a staging yard (10.3.7.2).`);
    const choice = this.pick(ASSEMBLE_ROLES, step.builder, (b) => {
      const st = this.standFor(b, spots);
      return st && st.reach <= this.T.maxReach && { to: st.stand };
    }, 0, null, `assemble ${u.name}`);
    if (!choice) { this.noBuilder(`assemble ${u.name}`); return; }
    const a = choice.b;
    a.tasks++;
    this.go(a, choice.d.to, 'walk', { label: 'To ' + u.name });
    const joined = new Set([u.memberIds[0]]);
    for (const id of u.memberIds.slice(1)) {
      const inner = (u.internal || []).filter((j) => (j.a === id && joined.has(j.b)) || (j.b === id && joined.has(j.a)));
      if (!inner.length) this.warn(`${this.model.memberById.get(id).name} doesn't touch the rest of ${u.name}.`);
      const dur = this.joinTime(a, inner, joined, id);
      this.seg(a, 'assemble', a.freeAt, a.freeAt + dur, { label: `Bolt ${this.model.memberById.get(id).name} into ${u.name}`, unitKey: u.key });
      joined.add(id);
    }
    for (const j of u.internal || []) u.fastened[j.id] = true;
    u.built = true;
    u.readyAt = a.freeAt;
    u.pos = spot;
    this.track(u.memberIds, a.freeAt, { kind: 'ground', x: spot.x, y: spot.y, assembled: true });
  }

  // Who carries a unit to the bridge, and how it gets to them: directly, or handed across from a
  // builder on the other side (e.g. members start east of the river, most of the bridge is west).
  planDelivery(u, step, targets) {
    const carriers = this.pool(CARRY_ROLES, step.carrier, `carry ${u.name}`).filter((c) => this.available(c));
    let best = null;
    for (const c of carriers) {
      const st = this.standFor(c, targets, 'work');
      if (!st) continue;
      const src = this.standFor(c, [u.pos]);
      if (src && src.reach <= this.T.maxReach) {
        const toSrc = this.travel(c, c.pos, src.stand, false);
        const carry = this.travel(c, src.stand, st.stand, true);
        if (toSrc && carry) {
          const at = Math.max(c.freeAt + toSrc.time, u.readyAt) + this.T.pickupTime + carry.time;
          if (!best || at < best.at) best = { at, c, st, src, relay: null };
          continue;
        }
      }
      // Hand-off from a runner who can reach the piece.
      for (const r of this.builders) {
        if (r === c || !this.available(r) || !FETCH_ROLES.has(r.role)) continue;
        const rs = this.standFor(r, [u.pos]);
        if (!rs || rs.reach > this.T.maxReach) continue;
        const spots = this.grid.handoffs(this.grid.region(r.mask, r.pos), this.grid.region(c.mask, c.pos), this.T.passReach);
        if (!spots.length) continue;
        // Shortlist by straight-line distance, then time the best few properly.
        const ranked = spots.map((h) => ({ h, est: dist2d(rs.stand, h.g) + dist2d(h.t, st.stand) + 0.5 * dist2d(c.pos, h.t) })).sort((p, q) => p.est - q.est).slice(0, 4);
        for (const { h } of ranked) {
          const rTo = this.travel(r, r.pos, rs.stand, false), rCarry = this.travel(r, rs.stand, h.g, true);
          const cTo = this.travel(c, c.pos, h.t, false), cCarry = this.travel(c, h.t, st.stand, true);
          if (!rTo || !rCarry || !cTo || !cCarry) continue;
          const rAt = Math.max(r.freeAt + rTo.time, u.readyAt) + this.T.pickupTime + rCarry.time;
          const hand = Math.max(rAt, c.freeAt + cTo.time) + this.T.pickupTime;
          const at = hand + cCarry.time;
          if (!best || at < best.at) best = { at, c, st, src: rs, relay: { r, h } };
        }
      }
    }
    return best;
  }

  doInstall(step) {
    const key = (step.unit.type === 'assembly' ? 'a:' : 'm:') + step.unit.id;
    const u = this.units.get(key);
    if (!u) { this.warn('An install step refers to a member or assembly that no longer exists (or is now part of an assembly); skipped.'); return; }
    if (u.installed) { this.warn(`${u.name} is installed more than once in the plan; extra step skipped.`); return; }
    if (!u.memberIds.length) { this.warn(`${u.name} has no members; skipped.`); return; }
    if (!u.built) {
      this.warn(`${u.name} is installed without an assemble step before it, so it is assembled right before installing. Add an assemble step earlier to overlap the work.`);
      this.doBuild({ assemblyId: u.id, builder: 'auto' });
      if (this.aborted || !u.built) return;
    }
    const targets = this.unitTargets(u);
    const plan = this.planDelivery(u, step, targets);
    if (!plan) { this.noBuilder(`carry ${u.name} to the bridge`); return; }
    const { c, st, src, relay } = plan;
    c.tasks++;
    if (!relay) {
      this.go(c, src.stand, 'walk', { label: 'To ' + u.name });
      this.waitUntil(c, u.readyAt, 'wait', { label: `Wait for ${u.name} to be ready` });
      this.seg(c, 'pickup', c.freeAt, c.freeAt + this.T.pickupTime, { label: 'Pick up ' + u.name });
      this.track(u.memberIds, c.freeAt, { kind: 'carried', builderId: c.id });
    } else {
      const { r, h } = relay;
      r.tasks++;
      this.go(r, src.stand, 'walk', { label: 'To ' + u.name });
      this.waitUntil(r, u.readyAt, 'wait', { label: `Wait for ${u.name} to be ready` });
      this.seg(r, 'pickup', r.freeAt, r.freeAt + this.T.pickupTime, { label: 'Pick up ' + u.name });
      this.track(u.memberIds, r.freeAt, { kind: 'carried', builderId: r.id });
      this.go(r, h.g, 'carry', { label: `Carry ${u.name} to hand to ${c.name}`, memberIds: u.memberIds });
      this.go(c, h.t, 'walk', { label: `Meet ${r.name} for ${u.name}` });
      const t0 = Math.max(r.freeAt, c.freeAt);
      this.waitUntil(r, t0, 'wait', { label: `Wait for ${c.name}` });
      this.waitUntil(c, t0, 'wait', { label: `Wait for ${r.name}` });
      this.seg(r, 'pickup', t0, t0 + this.T.pickupTime, { label: `Hand ${u.name} to ${c.name}` });
      this.seg(c, 'pickup', t0, t0 + this.T.pickupTime, { label: `Take ${u.name} from ${r.name}` });
      this.track(u.memberIds, c.freeAt, { kind: 'carried', builderId: c.id });
      u.handedOff = true;
    }
    if (st.reach > this.T.maxReach) this.warn(`${c.name} has to reach ${Math.round(st.reach)} in to place ${u.name} (max reach ${this.T.maxReach} in).`);
    if (!this.go(c, st.stand, 'carry', { label: 'Carry ' + u.name, memberIds: u.memberIds })) { this.aborted = true; return; }
    this.waitUntil(c, this.lastPlace, 'hold', { label: `Holding ${u.name} until the previous piece is placed`, unitKey: u.key });
    const placeAt = c.freeAt;
    this.lastPlace = placeAt;

    // 10.3.11: a piece that touches nothing installed starts a new constructed portion, which
    // must start on a footing.
    const touching = u.joints.some((j) => this.unitOfMember.get(u.memberIds.includes(j.a) ? j.b : j.a)?.installed);
    const onFooting = u.memberIds.some((m) => this.bearings.has('brg:' + m));
    if (!touching && !onFooting) this.error(`${u.name} doesn't touch any installed piece or a footing, so it can't start a constructed portion (10.3.11).`);

    u.installed = true;
    u.installedAt = placeAt;
    this.track(u.memberIds, placeAt, { kind: 'bridge' });
    this.status(u, placeAt, 'held');
    u.holder = c.id;
    c.holding = u.key;
    c.holdSince = placeAt;
    u.holdStart = placeAt;
    const rec = { unitKey: u.key, name: u.name, builderId: c.id, start: placeAt, end: null, alignStart: null, workEnd: null, solo: false, step: this.stepIndex };
    this.holds.push(rec);
    c.freeAt = Infinity;
    this.updateStability(placeAt);

    const joints = this.jointsFor(u);
    if (!joints.length && !u.stable) {
      this.warn(`${u.name} has no bolted connection to anything installed before it, so someone has to hold it until a later piece connects to it.`);
    }
    if (joints.length) {
      let solo = step.fastener === 'carrier';
      let f = null;
      if (!solo) {
        const first = this.nodeSite(joints[0].id);
        const fc = this.pick(FASTEN_ROLES, step.fastener, (b) => {
          const s = this.standFor(b, [first], 'work');
          return s && { to: s.stand };
        }, placeAt, c.id, `fasten ${u.name}`);
        if (fc) { f = fc.b; f.tasks++; } else solo = true;
        if (solo) this.warn(`Nobody else can reach to fasten ${u.name}, so ${c.name} fastens it while holding it (slower).`);
      }
      if (solo) {
        f = c;
        rec.solo = true;
        c.freeAt = placeAt;
      }
      const mult = solo ? this.T.soloMultiplier : 1;
      if (!f.hardware) this.warn(`${f.name} fastens bolts but isn't carrying nuts & bolts (turn on "Nuts & bolts" in Crew).`);
      const todo = joints.slice();
      while (todo.length) {
        todo.sort((a, b) => dist2d(f.pos, this.nodeSite(a.id)) - dist2d(f.pos, this.nodeSite(b.id)));
        const j = todo.shift();
        const where = this.nodeSite(j.id);
        const label = jointLabel(this.model, j);
        if (!solo) {
          const s = this.standFor(f, [where], 'work');
          if (!s) { this.error(`${f.name} can't reach the connection ${label} from a construction zone or riverbank.`); continue; }
          if (s.reach > this.T.maxReach) this.warn(`${f.name} has to reach ${Math.round(s.reach)} in to fasten ${label}.`);
          this.go(f, s.stand, 'walk', { label: 'To ' + label });
        } else if (dist2d(c.pos, where) > this.T.maxReach * 1.5) {
          this.warn(`${c.name} fastens ${u.name} alone but the connection ${label} is ${Math.round(dist2d(c.pos, where))} in away.`);
        }
        this.waitUntil(f, placeAt, 'wait', { label: `Wait for ${u.name}` });
        if (rec.alignStart == null) rec.alignStart = f.freeAt;
        this.seg(f, 'align', f.freeAt, f.freeAt + this.alignTimeOf(j, false) * mult, { label: 'Align ' + label, unitKey: u.key, nodeId: j.id, holding: solo });
        const bolts = this.fastenJoint(j);
        // (0 when its bolts went in with an earlier connection through the same stack, or wait for a
        // later member)
        if (bolts > 0) this.seg(f, 'fasten', f.freeAt, f.freeAt + bolts * this.boltTimeOf(j, f, false) * mult, { label: `Fasten ${bolts} bolt${bolts === 1 ? '' : 's'}: ${label}`, unitKey: u.key, nodeId: j.id, holding: solo, bolts });
        this.updateStability(f.freeAt);
      }
      rec.workEnd = f.freeAt;
      this.lastWorkEnd = Math.max(this.lastWorkEnd, f.freeAt);
      if (solo && u.holder === c.id) {
        c.holdSince = c.freeAt;
        c.freeAt = Infinity;
      }
    } else {
      this.lastWorkEnd = Math.max(this.lastWorkEnd, placeAt);
    }
  }

  // Connections between this unit and units already installed that still need bolting.
  jointsFor(u) {
    return u.joints.filter((j) => {
      if (j.bolts <= 0 || u.fastened[j.id]) return false;
      const other = this.unitOfMember.get(u.memberIds.includes(j.a) ? j.b : j.a);
      return other && other.installed && other !== u;
    });
  }

  // Can this bolt go in once the members in `joined` are together? A bolt through 3+ members goes
  // in as soon as two are joined, once all are in place, or once a chosen member is placed.
  boltReady(b, joined) {
    const here = b.memberIds.filter((id) => joined.has(id)).length;
    if (here < 2) return false;
    if (b.when === 'all') return here === b.memberIds.length;
    if (b.when && b.when !== 'first' && b.memberIds.includes(b.when)) return joined.has(b.when);
    return true;
  }

  // Put in the bolts at these connections that are ready and not in yet (each bolt once, even
  // when it passes through several members). Every connection a bolt passes through gets
  // stronger, including ones fastened earlier. Returns the bolts put in, per connection.
  newBolts(joints, joined) {
    const out = new Map();
    for (const j of joints) {
      let n = 0;
      for (const id of j.boltIds || []) {
        if (this.boltsDone.has(id)) continue;
        const b = this.boltById.get(id);
        if (!b || !this.boltReady(b, joined)) continue;
        this.boltsDone.add(id);
        n++;
        for (const jid of b.jointIds) this.credit(b.id, jid);
      }
      out.set(j.id, n);
    }
    return out;
  }

  // Count a bolt that's in toward one of its connections, once both sides are in the bridge.
  credit(boltId, jid) {
    const key = boltId + '|' + jid;
    if (this.credited.has(key)) return;
    const jj = this.jointById.get(jid);
    const ua = jj && this.unitOfMember.get(jj.a), ub = jj && this.unitOfMember.get(jj.b);
    if (!ua || !ub || ua === ub || !ua.installed || !ub.installed) return; // bolts inside an assembly don't attach it to anything
    this.credited.add(key);
    for (const x of [ua, ub]) x.attached[jid] = (x.attached[jid] || 0) + 1;
  }

  // Members already in the bridge (including the piece being installed).
  installedMembers() {
    const s = new Set();
    for (const u of this.units.values()) if (u.installed) for (const id of u.memberIds) s.add(id);
    return s;
  }

  // Align time and time per bolt for one connection: its own override if it has one, otherwise
  // the staging-yard times for assemblies and the builder's tool time in the bridge.
  alignTimeOf(j, staging) {
    if (j.alignTime != null) return j.alignTime;
    return staging && this.T.assemblyAlignTime > 0 ? this.T.assemblyAlignTime : this.T.alignTime;
  }
  boltTimeOf(j, builder, staging) {
    if (j.boltTime != null) return j.boltTime;
    return staging && this.T.assemblyBoltTime > 0 ? this.T.assemblyBoltTime : builder.boltTime;
  }

  // Time to bolt one more member into an assembly in the staging yard.
  joinTime(a, inner, joined, id) {
    const now = new Set([...joined, id]);
    const put = this.newBolts(inner, now);
    if (this.T.assemblyJoinTime > 0 && !inner.some((j) => j.alignTime != null || j.boltTime != null)) return this.T.assemblyJoinTime;
    return inner.reduce((s, j) => s + this.alignTimeOf(j, true) + put.get(j.id) * this.boltTimeOf(j, a, true), 0);
  }

  // Returns how many bolts have to be put in for this connection.
  fastenJoint(j) {
    const ua = this.unitOfMember.get(j.a), ub = this.unitOfMember.get(j.b);
    for (const x of [ua, ub]) x.fastened[j.id] = true;
    const n = this.newBolts([j], this.installedMembers()).get(j.id);
    // Bolts that went in earlier (with another connection through the same stack) hold this one too.
    for (const id of j.boltIds || []) if (this.boltsDone.has(id)) this.credit(id, j.id);
    return n;
  }

  doSupport(step) {
    const tool = this.project.tools.find((t) => t.id === step.toolId);
    if (!tool) { this.warn('A support step uses a tool that no longer exists; skipped.'); return; }
    const m = this.model.memberById.get(step.memberId);
    if (!m) { this.warn('A support step refers to a member that no longer exists; skipped.'); return; }
    const node = 'sup:' + m.id;
    const where = this.nodeSite(node);
    const label = stepLabel(step, this.model, this.plan, this.project);
    if (step.action === 'remove') {
      const inst = this.toolInst.find((ti) => ti.tool.id === tool.id && ti.placedAt === node);
      if (!inst) { this.warn(`"${label}": there is no ${tool.name} there to remove; skipped.`); return; }
      const ch = this.pick(SUPPORT_ROLES, step.builder, (b) => { const s = this.standFor(b, [where], 'work'); return s && { to: s.stand }; }, this.lastWorkEnd, null, label);
      if (!ch) { this.noBuilder(label); return; }
      const b = ch.b;
      b.tasks++;
      this.go(b, ch.d.to, 'walk', { label: 'To ' + tool.name });
      this.waitUntil(b, this.lastWorkEnd, 'wait', { label: 'Wait for the bolts before removing ' + tool.name });
      this.seg(b, 'support', b.freeAt, b.freeAt + (tool.removeTime || 0), { label });
      inst.placedAt = null;
      inst.carriedBy = b.id;
      b.gear.push(inst);
      this.supported.set(node, (this.supported.get(node) || 1) - 1);
      this.supportEvents.push({ t: b.freeAt, key: inst.key, nodeId: node, action: 'remove', name: tool.name });
      this.updateStability(b.freeAt);
      return;
    }
    // 10.4.2: a tool touching the river is an accident.
    if (this.site.zones.some((z) => z.type === 'nogo' && inZone(z, where))) this.warn(`"${label}": the support would stand in the river or a no-go zone, which is an accident penalty (10.4.2).`);
    const free = this.toolInst.filter((ti) => ti.tool.id === tool.id && !ti.placedAt);
    if (!free.length) { this.error(`"${label}": every ${tool.name} is already in use. Remove one first or add more in Tools.`); return; }
    const ch = this.pick(SUPPORT_ROLES, step.builder, (b) => {
      const s = this.standFor(b, [where], 'work');
      if (!s) return null;
      const mine = free.find((ti) => ti.carriedBy === b.id);
      if (mine) return { to: s.stand, inst: mine };
      let best = null;
      for (const ti of free) {
        const from = ti.carriedBy ? this.builderById.get(ti.carriedBy).pos : ti.pos;
        const toTool = this.travel(b, b.pos, from, false);
        const toNode = this.travel(b, from, s.stand, false);
        if (!toTool || !toNode) continue;
        if (!best || toTool.time + toNode.time < best.cost) best = { cost: toTool.time + toNode.time, ti, from, toNode: toNode.time };
      }
      return best && { to: best.from, extra: best.toNode, inst: best.ti, fetchFrom: best.from, stand: s.stand };
    }, 0, null, label);
    if (!ch) { this.noBuilder(label); return; }
    const b = ch.b;
    b.tasks++;
    const inst = ch.d.inst;
    if (ch.d.fetchFrom) {
      this.go(b, ch.d.fetchFrom, 'walk', { label: 'To ' + tool.name });
      this.seg(b, 'gear', b.freeAt, b.freeAt + this.T.gearUpTime, { label: 'Grab ' + tool.name });
      const prev = inst.carriedBy && this.builderById.get(inst.carriedBy);
      if (prev) prev.gear = prev.gear.filter((g) => g !== inst);
      inst.carriedBy = b.id;
      this.go(b, ch.d.stand, 'walk', { label: 'To ' + m.name });
    } else {
      this.go(b, ch.d.to, 'walk', { label: 'To ' + m.name });
    }
    this.seg(b, 'support', b.freeAt, b.freeAt + (tool.placeTime || 0), { label });
    b.gear = b.gear.filter((g) => g !== inst);
    inst.carriedBy = null;
    inst.placedAt = node;
    this.supported.set(node, (this.supported.get(node) || 0) + 1);
    this.supportEvents.push({ t: b.freeAt, key: inst.key, nodeId: node, action: 'place', name: tool.name });
    this.updateStability(b.freeAt);
  }

  finish() {
    // 10.9.1: everyone ends in a staging yard.
    if (!this.aborted && this.rules.returnToStaging !== false && this.stageZones.length) {
      for (const b of this.builders) {
        if (b.holding || !Number.isFinite(b.freeAt)) continue;
        if (this.grid.canStand(b.stage, b.pos)) continue;
        const s = this.grid.nearestStand(b.stage, b.pos);
        if (!s || !this.grid.path(b.mask, b.pos, s)) { this.warn(`${b.name} can't get back to a staging yard at the finish.`); continue; }
        this.stepIndex = null;
        this.go(b, { x: s.x, y: s.y }, 'walk', { label: 'Return to staging yard' });
      }
    }
    if (!this.aborted) {
      const left = this.model.bolts.filter((b) => b.jointId && !this.boltsDone.has(b.id) && b.memberIds.every((id) => this.unitOfMember.get(id)?.installed));
      if (left.length) this.warn(`${left.length} bolt${left.length === 1 ? ' never goes' : 's never go'} in (check when each bolt through a stack is set to go in): ${left.map((b) => b.memberIds.map((id) => this.model.memberById.get(id)?.name).join('/')).join(', ')}.`);
    }
    const finite = this.segments.filter((s) => Number.isFinite(s.t1));
    let end = finite.length ? Math.max(...finite.map((s) => s.t1)) : 0;
    for (const u of this.units.values()) if (u.installed && u.stableAt == null && u.holder) end = Math.max(end, u.installedAt);
    for (const b of this.builders) {
      if (b.holding) {
        const u = this.units.get(b.holding);
        if (!this.aborted) this.error(`${u.name} never becomes stable: ${b.name} is still holding it at the end. Add a support or another piece that braces it.`);
        if (!Number.isFinite(b.freeAt)) this.segments.push({ builderId: b.id, kind: 'hold', t0: b.holdSince, t1: end, x: b.pos.x, y: b.pos.y, unitKey: u.key, label: 'Holding ' + u.name + ' (never released)', open: true });
        const rec = this.holds.find((h) => h.unitKey === u.key && h.end == null);
        if (rec) { rec.end = end; rec.open = true; }
      }
    }
    if (!this.aborted) {
      const missing = [...this.units.values()].filter((u) => !u.installed);
      if (missing.length) this.warn(`${missing.length} piece${missing.length === 1 ? ' is' : 's are'} not in the sequence yet: ${missing.slice(0, 6).map((u) => u.name).join(', ')}${missing.length > 6 ? ', …' : ''}.`);
      const left = this.toolInst.filter((ti) => ti.placedAt);
      if (left.length) this.error(`Supports still under the bridge at the finish; tools must be back in the staging yard or with a builder (10.9.1): ${left.map((ti) => ti.tool.name).join(', ')}.`);
      const limit = (this.rules.timeLimitMin || 0) * 60, halt = (this.rules.haltMin || 0) * 60;
      if (halt && end > halt) this.error(`Construction takes ${fmt(end)}, past the ${this.rules.haltMin}-minute limit when judges halt construction (10.8.2).`);
      else if (limit && end > limit) this.warn(`Construction takes ${fmt(end)}, over ${this.rules.timeLimitMin} minutes, which is scored as 180 minutes (10.8.1).`);
    }
    this.endTime = end;
  }

  constructionCost(end) {
    const r = this.rules;
    if (!r.costPerBuilderMin) return null;
    const n = this.builders.length;
    const gamma = n >= (r.crewFactorMinBuilders ?? Infinity) ? r.crewFactor ?? 1 : 1;
    const minutes = r.timeLimitMin && end > r.timeLimitMin * 60 ? 180 : end / 60;
    return minutes * n * r.costPerBuilderMin * gamma;
  }

  result() {
    const busy = new Map();
    for (const s of this.segments) if (s.kind !== 'wait') busy.set(s.builderId, (busy.get(s.builderId) || 0) + Math.min(s.t1, this.endTime ?? s.t1) - s.t0);
    const endTime = this.endTime ?? 0;
    return {
      endTime,
      cost: this.constructionCost(endTime),
      segments: this.segments.filter((s) => Number.isFinite(s.t1)),
      holds: this.holds.map((h) => ({
        ...h,
        duration: (h.end ?? endTime) - h.start,
        waitForFastener: h.alignStart != null ? h.alignStart - h.start : null,
        working: h.alignStart != null && h.workEnd != null ? Math.min(h.workEnd, h.end ?? h.workEnd) - h.alignStart : null,
      })),
      warnings: this.warnings,
      errors: this.errors,
      aborted: this.aborted,
      tracks: this.tracks,
      unitStatus: this.unitStatus,
      supportEvents: this.supportEvents,
      stepTimes: this.stepTimes,
      handoffs: [...this.units.values()].filter((u) => u.handedOff).length,
      builders: this.builders.map((b) => ({ id: b.id, name: b.name, color: b.color, start: b.start, busy: busy.get(b.id) || 0 })),
      units: [...this.units.values()].map((u) => ({ key: u.key, name: u.name, type: u.type, memberIds: u.memberIds, installedAt: u.installedAt ?? null, stableAt: u.stableAt ?? null })),
      unitOfMember: new Map([...this.unitOfMember].map(([m, u]) => [m, u.key])),
      nodePos: this.nodePos,
      model: this.model,
    };
  }
}

export function fmt(t) {
  if (!Number.isFinite(t)) return '–';
  const m = Math.floor(t / 60), s = t - m * 60;
  return `${m}:${s < 10 ? '0' : ''}${s.toFixed(1)}`;
}

export function fmtCost(c) {
  if (c == null) return '–';
  return '$' + Math.round(c).toLocaleString('en-US');
}
