// Build simulator. Walks through the plan's steps in order and schedules every builder:
// walking, carrying, holding, aligning, fastening, ground assembly and placing/removing supports.
//
// Scheduling is greedy: each step takes the builder(s) who can get to the work soonest (or the
// ones the plan assigns). Steps overlap whenever builders are free, but pieces are placed on the
// bridge in plan order. A builder who places a piece keeps holding it until the stability model
// (stability.js) says it stands on its own.
//
// Competition rules modelled:
//   - a builder carries only one member or assembly at a time (tools, nuts and bolts are extra)
//   - tools and hardware are picked up after the clock starts (gear-up at time 0)
//   - assemblies are built only in ground-assembly zones
//   - builders stay out of no-go zones and inside their allowed zones
import { buildModel, bridgeToSite, dist2d } from '../model/geometry.js';
import { activePlan } from '../model/schema.js';
import { planUnits, stagingSpots, stepLabel, nodeLabel } from '../model/plan.js';
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
  pickup: { label: 'Pick up / set down', color: '#93c5fd' },
  gear: { label: 'Grabbing tools / hardware', color: '#94a3b8' },
  wait: { label: 'Waiting', color: '#f1f5f9' },
  hold: { label: 'Holding a piece', color: '#f97316' },
  align: { label: 'Aligning', color: '#fde047' },
  fasten: { label: 'Fastening', color: '#ca8a04' },
  assemble: { label: 'Ground assembly', color: '#a855f7' },
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

class Sim {
  constructor(project, plan) {
    this.project = project;
    this.plan = plan;
    this.T = project.timing;
    this.site = project.site;
    this.model = buildModel(project);
    this.grid = new SiteGrid(project.site);
    this.segments = [];
    this.holds = [];
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

    this.nodePos = new Map();
    for (const [id, n] of this.model.nodes) this.nodePos.set(id, { x: n.x, y: n.y, z: n.z });
    this.bearings = new Set([...this.model.nodes.values()].filter((n) => n.bearing).map((n) => n.id));
    this.supported = new Map(); // nodeId -> count of support tools under it
    this.present = new Map(); // nodeId -> Set(unitKey) installed there

    // Units
    const { units } = planUnits(this.model, plan);
    const spots = stagingSpots(project, this.model);
    this.units = new Map();
    for (const u of units) {
      const unit = {
        ...u,
        nodeIds: [...new Set(u.memberIds.flatMap((id) => this.model.memberById.get(id).nodeIds))],
        boltsAt: {},
        fastened: {},
        attached: {},
        installed: false,
        built: u.type === 'member',
        stable: false,
        holder: null,
        pos: null,
        readyAt: 0,
      };
      if (u.type === 'member') unit.pos = spots.get(u.id);
      this.units.set(u.key, unit);
    }
    this.unitOfMember = new Map();
    for (const u of this.units.values()) for (const m of u.memberIds) this.unitOfMember.set(m, u);
    for (const b of this.model.bolts) {
      const u = this.unitOfMember.get(b.memberId);
      if (u) u.boltsAt[b.nodeId] = (u.boltsAt[b.nodeId] || 0) + 1;
    }
    for (const m of this.model.members) {
      const s = spots.get(m.id);
      this.tracks.set(m.id, [{ t: 0, kind: 'staging', x: s.x, y: s.y }]);
      if (!this.grid.inside(s)) this.warn(`${m.name} starts outside the site.`);
    }

    // Builders
    const zoneIds = new Set(this.site.zones.map((z) => z.id));
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
      return { id: b.id, name: b.name, role: b.role || 'any', color: b.color, start: pos, pos, freeAt: 0, holding: null, holdSince: 0, mask, gear: [], hardware: false, boltTime: this.T.boltTimeHand, tasks: 0 };
    });
    this.builderById = new Map(this.builders.map((b) => [b.id, b]));

    // Tool instances
    this.toolInst = [];
    for (const tool of project.tools) {
      for (let i = 0; i < Math.max(0, tool.count | 0); i++) {
        this.toolInst.push({ key: tool.id + '#' + i, tool, pos: { ...tool.start }, carriedBy: null, placedAt: null });
      }
    }
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
      this.error(`${b.name} can't find a path to (${Math.round(to.x)}, ${Math.round(to.y)}) without leaving their allowed zones.`);
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

  // Where builder b should stand to reach one of the target points.
  standFor(b, targets) {
    let best = null;
    for (const p of targets) {
      const s = this.grid.nearestStand(b.mask, p);
      if (!s) continue;
      const score = s.dist + 0.01 * dist2d(b.pos, s);
      if (!best || score < best.score) best = { stand: { x: s.x, y: s.y }, reach: s.dist, target: p, score };
    }
    return best;
  }

  unitTargets(u) {
    const pts = [];
    for (const id of u.memberIds) {
      const m = this.model.memberById.get(id);
      for (const [a, b] of m.segments) {
        const pa = this.nodePos.get(a), pb = this.nodePos.get(b);
        const l = Math.hypot(pb.x - pa.x, pb.y - pa.y, pb.z - pa.z);
        const k = Math.max(1, Math.ceil(l / 6));
        for (let i = 0; i <= k; i++) {
          const t = i / k;
          pts.push(bridgeToSite(this.site, pa.x + (pb.x - pa.x) * t, pa.y + (pb.y - pa.y) * t));
        }
      }
    }
    return pts;
  }

  // Choose the builder who can reach `dest(b)` soonest. Returns {b, plan} or null.
  pick(roles, explicit, dest, readyTime, exclude = null, what = 'this task') {
    let pool;
    if (explicit && explicit !== 'auto' && explicit !== 'carrier') {
      const b = this.builderById.get(explicit);
      if (!b) this.warn(`A step is assigned to a builder who no longer exists; picking automatically.`);
      else if (b.holding) this.warn(`${b.name} is assigned to ${what} but is still holding ${this.units.get(b.holding).name}; picking someone else.`);
      else if (b.id === exclude) this.warn(`${b.name} can't do ${what} while holding the piece; picking someone else.`);
      else pool = [b];
    }
    if (!pool) pool = this.builders.filter((b) => roles.has(b.role));
    let best = null;
    for (const b of pool) {
      if (b.holding || b.id === exclude || !Number.isFinite(b.freeAt)) continue;
      const d = dest(b);
      if (!d) continue;
      const r = this.travel(b, b.pos, d.to, false);
      if (!r) continue;
      const extra = d.extra || 0;
      const at = Math.max(b.freeAt + r.time + extra, readyTime);
      const score = at + b.tasks * 1e-3;
      if (!best || score < best.score) best = { b, score, d };
    }
    return best;
  }

  noBuilder(what) {
    const holding = this.builders.filter((b) => b.holding).map((b) => `${b.name} (holding ${this.units.get(b.holding).name})`);
    let msg = `No builder can do "${what}".`;
    if (holding.length) msg += ' Busy holding unstable pieces: ' + holding.join(', ') + '. Add a support, change the order, or add builders.';
    else msg += ' Check builder roles and allowed zones.';
    this.error(msg);
    this.aborted = true;
  }

  // ---------- stability ----------
  updateStability(t) {
    const installed = [...this.units.values()].filter((u) => u.installed);
    const supportNodes = new Set(this.bearings);
    for (const [n, c] of this.supported) if (c > 0) supportNodes.add(n);
    const res = computeStability({
      units: installed.map((u) => ({ key: u.key, nodeIds: u.nodeIds, attached: u.attached })),
      supportNodes,
      nodePos: this.nodePos,
      rigidBoltCount: this.project.design.rigidBoltCount,
    });
    for (const u of installed) {
      const now = res.stable.has(u.key);
      if (now && !u.stable) {
        u.stable = true;
        u.stableAt = t;
        this.status(u, t, 'stable');
        if (u.holder) this.release(u, t);
      } else if (!now && u.stable) {
        u.stable = false;
        this.status(u, t, 'unstable');
        if (!u.holder) this.error(`${u.name} loses its support at ${fmt(t)} and would fall.`);
      }
    }
  }

  release(u, t) {
    const b = this.builderById.get(u.holder);
    const rec = this.holds.find((h) => h.unitKey === u.key && h.end == null);
    if (rec) rec.end = t;
    u.holder = null;
    b.holding = null;
    if (!Number.isFinite(b.freeAt)) {
      // Pure holding: the builder was blocked until now.
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
    for (const b of this.builders) {
      const src = this.project.builders.find((x) => x.id === b.id);
      const items = [];
      for (const toolId of src.loadout || []) {
        const inst = this.toolInst.find((ti) => ti.tool.id === toolId && !taken.has(ti.key));
        if (!inst) { const tool = this.project.tools.find((t) => t.id === toolId); if (tool) this.warn(`Not enough ${tool.name}s: ${b.name} starts without one.`); continue; }
        taken.add(inst.key);
        items.push({ pos: inst.pos, inst });
      }
      if (src.hardware) items.push({ pos: this.site.hardware, hardware: true });
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

  assemblySpot(zone, slot) {
    const cols = Math.max(1, Math.floor((zone.w - 10) / 50));
    const col = slot % cols, row = Math.floor(slot / cols);
    return { x: Math.min(zone.x + zone.w - 5, zone.x + 30 + col * 50), y: Math.min(zone.y + zone.h - 5, zone.y + 15 + row * 30) };
  }

  doBuild(step) {
    const u = this.units.get('a:' + step.assemblyId);
    if (!u) { this.warn('A build step refers to an assembly that no longer exists; skipped.'); return; }
    if (u.built) { this.warn(`${u.name} is built more than once in the plan; extra build step skipped.`); return; }
    if (!u.memberIds.length) { this.warn(`${u.name} has no members.`); u.built = true; return; }
    const zones = this.site.zones.filter((z) => z.type === 'assembly');
    let zone = zones.find((z) => z.id === u.assembly.areaZoneId) || zones[0];
    if (!zone) { this.error(`${u.name} needs a ground-assembly area, but the site has none.`); this.aborted = true; return; }
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
        return st && { to: st.stand };
      }, 0, null, `fetch ${m.name}`);
      if (!choice) { this.noBuilder(`fetch ${m.name} for ${u.name}`); return; }
      const b = choice.b;
      b.tasks++;
      this.go(b, choice.d.to, 'walk', { label: 'To ' + m.name });
      this.seg(b, 'pickup', b.freeAt, b.freeAt + this.T.pickupTime, { label: 'Pick up ' + m.name });
      this.track([id], b.freeAt, { kind: 'carried', builderId: b.id });
      const dst = this.standFor(b, [drop]);
      if (!dst) { this.error(`${b.name} can't reach the assembly area ${zone.name}.`); this.aborted = true; return; }
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
    const joined = [arrivals[0].id];
    const memberNodes = (id) => this.model.memberById.get(id).nodeIds;
    const boltsOn = (id, n) => this.model.bolts.filter((bb) => bb.memberId === id && bb.nodeId === n).length;
    for (let i = 1; i < arrivals.length; i++) {
      const id = arrivals[i].id;
      this.waitUntil(a, arrivals[i].t);
      const shared = memberNodes(id).filter((n) => joined.some((j) => memberNodes(j).includes(n)));
      let bolts = 0;
      for (const n of shared) {
        bolts += boltsOn(id, n);
        for (const j of joined) if (!u.fastened[n]) bolts += boltsOn(j, n);
        u.fastened[n] = true;
      }
      if (!shared.length) this.warn(`${this.model.memberById.get(id).name} doesn't share a joint with the rest of ${u.name}.`);
      const dur = this.T.assemblyJoinTime > 0 ? this.T.assemblyJoinTime : shared.length * this.T.alignTime + bolts * a.boltTime;
      this.seg(a, 'assemble', a.freeAt, a.freeAt + dur, { label: `Join ${this.model.memberById.get(id).name} into ${u.name}`, unitKey: u.key });
      joined.push(id);
    }
    // Every internal joint is now bolted. Internal bolts hold the assembly together but don't
    // attach it to anything else, so they don't count toward `attached`.
    for (const n of u.nodeIds) {
      const touching = u.memberIds.filter((id) => memberNodes(id).includes(n));
      if (touching.length >= 2) u.fastened[n] = true;
    }
    u.built = true;
    u.readyAt = a.freeAt;
    u.pos = spot;
    this.track(u.memberIds, a.freeAt, { kind: 'ground', x: spot.x, y: spot.y, assembled: true });
    u.buildSpan = { start: arrivals[0].t, end: a.freeAt };
  }

  jointsFor(u) {
    const joints = [];
    for (const n of u.nodeIds) {
      const others = [...(this.present.get(n) || [])].filter((k) => k !== u.key).map((k) => this.units.get(k));
      if (!others.length) continue;
      const needs = [u, ...others].some((x) => (x.boltsAt[n] || 0) > 0 && !x.fastened[n]);
      if (needs) joints.push({ n, others });
    }
    return joints;
  }

  // A unit's attachment strength at a joint is the number of its own bolts there (so "2 bolts at a
  // member end" = moment connection). A unit with no bolts of its own at the joint is still pinned
  // by the other members' bolts.
  fastenJoint(u, joint) {
    let bolts = 0;
    const parties = [u, ...joint.others];
    for (const x of parties) {
      const c = x.boltsAt[joint.n] || 0;
      if (c > 0 && !x.fastened[joint.n]) {
        bolts += c;
        x.fastened[joint.n] = true;
        x.attached[joint.n] = (x.attached[joint.n] || 0) + c;
      }
    }
    if (bolts > 0) for (const x of parties) x.attached[joint.n] = Math.max(x.attached[joint.n] || 0, 1);
    return bolts;
  }

  doInstall(step) {
    const key = (step.unit.type === 'assembly' ? 'a:' : 'm:') + step.unit.id;
    const u = this.units.get(key);
    if (!u) { this.warn('An install step refers to a member or assembly that no longer exists (or is now part of an assembly); skipped.'); return; }
    if (u.installed) { this.warn(`${u.name} is installed more than once in the plan; extra step skipped.`); return; }
    if (!u.memberIds.length) { this.warn(`${u.name} has no members; skipped.`); return; }
    if (!u.built) {
      this.warn(`${u.name} is installed without a build step before it, so it is built right before installing. Add a build step earlier to overlap the work.`);
      this.doBuild({ assemblyId: u.id, builder: 'auto' });
      if (this.aborted || !u.built) return;
    }
    const targets = this.unitTargets(u);
    const choice = this.pick(CARRY_ROLES, step.carrier, (b) => {
      const st = this.standFor(b, [u.pos]);
      return st && { to: st.stand };
    }, u.readyAt, null, `carry ${u.name}`);
    if (!choice) { this.noBuilder(`carry ${u.name}`); return; }
    const c = choice.b;
    c.tasks++;
    this.go(c, choice.d.to, 'walk', { label: 'To ' + u.name });
    this.waitUntil(c, u.readyAt, 'wait', { label: `Wait for ${u.name} to be ready` });
    this.seg(c, 'pickup', c.freeAt, c.freeAt + this.T.pickupTime, { label: 'Pick up ' + u.name });
    this.track(u.memberIds, c.freeAt, { kind: 'carried', builderId: c.id });
    const st = this.standFor(c, targets);
    if (!st) { this.error(`${c.name} can't reach anywhere near ${u.name}'s spot on the bridge.`); this.aborted = true; return; }
    if (st.reach > this.T.maxReach) this.warn(`${c.name} has to reach ${Math.round(st.reach)} in to place ${u.name} (max reach ${this.T.maxReach} in).`);
    if (!this.go(c, st.stand, 'carry', { label: 'Carry ' + u.name, memberIds: u.memberIds })) { this.aborted = true; return; }
    this.waitUntil(c, this.lastPlace, 'hold', { label: `Holding ${u.name} until the previous piece is placed`, unitKey: u.key });
    const placeAt = c.freeAt;
    this.lastPlace = placeAt;

    u.installed = true;
    u.installedAt = placeAt;
    for (const n of u.nodeIds) {
      if (!this.present.has(n)) this.present.set(n, new Set());
      this.present.get(n).add(u.key);
    }
    this.track(u.memberIds, placeAt, { kind: 'bridge' });
    this.status(u, placeAt, 'held');
    u.holder = c.id;
    c.holding = u.key;
    c.holdSince = placeAt;
    const rec = { unitKey: u.key, name: u.name, builderId: c.id, start: placeAt, end: null, alignStart: null, workEnd: null, solo: false, step: this.stepIndex };
    this.holds.push(rec);
    c.freeAt = Infinity;
    this.updateStability(placeAt);

    const joints = this.jointsFor(u);
    if (!joints.length && !u.stable) {
      this.warn(`${u.name} has no bolted joint with anything installed before it, so someone has to hold it until a later piece connects to it.`);
    }
    if (joints.length) {
      let solo = step.fastener === 'carrier';
      let f = null;
      if (!solo) {
        const first = this.nodeSite(joints[0].n);
        const fc = this.pick(FASTEN_ROLES, step.fastener, (b) => {
          const s = this.standFor(b, [first]);
          return s && { to: s.stand };
        }, placeAt, c.id, `fasten ${u.name}`);
        if (fc) { f = fc.b; f.tasks++; } else solo = true;
        if (solo) this.warn(`Nobody else can fasten ${u.name}, so ${c.name} fastens it while holding it (slower).`);
      }
      if (solo) {
        f = c;
        rec.solo = true;
        c.freeAt = placeAt; // the carrier works while holding
      }
      const mult = solo ? this.T.soloMultiplier : 1;
      if (!f.hardware) this.warn(`${f.name} fastens bolts but isn't carrying nuts & bolts (turn on "Carries nuts & bolts" in Crew).`);
      // Visit joints nearest-first.
      const todo = joints.slice();
      while (todo.length) {
        todo.sort((a, b) => dist2d(f.pos, this.nodeSite(a.n)) - dist2d(f.pos, this.nodeSite(b.n)));
        const j = todo.shift();
        if (!this.jointsFor(u).some((x) => x.n === j.n)) continue;
        const where = this.nodeSite(j.n);
        if (!solo) {
          const s = this.standFor(f, [where]);
          if (!s) { this.error(`${f.name} can't reach the joint at ${nodeLabel(this.model, j.n)}.`); continue; }
          if (s.reach > this.T.maxReach) this.warn(`${f.name} has to reach ${Math.round(s.reach)} in to fasten at ${nodeLabel(this.model, j.n)}.`);
          this.go(f, s.stand, 'walk', { label: 'To joint' });
        } else if (dist2d(c.pos, where) > this.T.maxReach * 1.5) {
          this.warn(`${c.name} fastens ${u.name} alone but the joint at ${nodeLabel(this.model, j.n)} is ${Math.round(dist2d(c.pos, where))} in away.`);
        }
        this.waitUntil(f, placeAt, 'wait', { label: `Wait for ${u.name}` });
        if (rec.alignStart == null) rec.alignStart = f.freeAt;
        this.seg(f, 'align', f.freeAt, f.freeAt + this.T.alignTime * mult, { label: 'Align ' + u.name, unitKey: u.key, nodeId: j.n, holding: solo });
        const bolts = this.fastenJoint(u, j);
        this.seg(f, 'fasten', f.freeAt, f.freeAt + bolts * f.boltTime * mult, { label: `Fasten ${bolts} bolt${bolts === 1 ? '' : 's'} on ${u.name}`, unitKey: u.key, nodeId: j.n, holding: solo, bolts });
        this.updateStability(f.freeAt);
      }
      rec.workEnd = f.freeAt;
      this.lastWorkEnd = Math.max(this.lastWorkEnd, f.freeAt);
      if (solo && u.holder === c.id) {
        // Still not stable after fastening: keep holding.
        c.holdSince = c.freeAt;
        c.freeAt = Infinity;
      }
    } else {
      this.lastWorkEnd = Math.max(this.lastWorkEnd, placeAt);
    }
  }

  doSupport(step) {
    const tool = this.project.tools.find((t) => t.id === step.toolId);
    if (!tool) { this.warn('A support step uses a tool that no longer exists; skipped.'); return; }
    if (!this.nodePos.has(step.nodeId)) { this.warn('A support step refers to a node that no longer exists; skipped.'); return; }
    const where = this.nodeSite(step.nodeId);
    const label = stepLabel(step, this.model, this.plan, this.project);
    if (step.action === 'remove') {
      const inst = this.toolInst.find((ti) => ti.tool.id === tool.id && ti.placedAt === step.nodeId);
      if (!inst) { this.warn(`"${label}": there is no ${tool.name} at that node to remove; skipped.`); return; }
      const ch = this.pick(SUPPORT_ROLES, step.builder, (b) => { const s = this.standFor(b, [where]); return s && { to: s.stand }; }, this.lastWorkEnd, null, label);
      if (!ch) { this.noBuilder(label); return; }
      const b = ch.b;
      b.tasks++;
      this.go(b, ch.d.to, 'walk', { label: 'To ' + tool.name });
      this.waitUntil(b, this.lastWorkEnd, 'wait', { label: 'Wait for the bolts before removing ' + tool.name });
      this.seg(b, 'support', b.freeAt, b.freeAt + (tool.removeTime || 0), { label });
      inst.placedAt = null;
      inst.carriedBy = b.id;
      b.gear.push(inst);
      this.supported.set(step.nodeId, (this.supported.get(step.nodeId) || 1) - 1);
      this.supportEvents.push({ t: b.freeAt, key: inst.key, nodeId: step.nodeId, action: 'remove', name: tool.name });
      this.updateStability(b.freeAt);
      return;
    }
    const free = this.toolInst.filter((ti) => ti.tool.id === tool.id && !ti.placedAt);
    if (!free.length) { this.error(`"${label}": every ${tool.name} is already in use. Remove one first or add more in Tools.`); return; }
    const ch = this.pick(SUPPORT_ROLES, step.builder, (b) => {
      const s = this.standFor(b, [where]);
      if (!s) return null;
      const mine = free.find((ti) => ti.carriedBy === b.id);
      if (mine) return { to: s.stand, inst: mine };
      // Fetch one that's lying around (or from someone who's carrying it).
      let best = null;
      for (const ti of free) {
        const from = ti.carriedBy ? this.builderById.get(ti.carriedBy).pos : ti.pos;
        const toTool = this.travel(b, b.pos, from, false);
        const toNode = this.travel(b, from, s.stand, false);
        if (!toTool || !toNode) continue;
        if (!best || toTool.time + toNode.time < best.cost) best = { cost: toTool.time + toNode.time, ti, from };
      }
      return best && { to: best.from, extra: best.cost - (this.travel(b, b.pos, best.from, false)?.time || 0), inst: best.ti, fetchFrom: best.from, stand: s.stand };
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
      this.go(b, ch.d.stand, 'walk', { label: 'To ' + nodeLabel(this.model, step.nodeId) });
    } else {
      this.go(b, ch.d.to, 'walk', { label: 'To ' + nodeLabel(this.model, step.nodeId) });
    }
    this.seg(b, 'support', b.freeAt, b.freeAt + (tool.placeTime || 0), { label });
    b.gear = b.gear.filter((g) => g !== inst);
    inst.carriedBy = null;
    inst.placedAt = step.nodeId;
    this.supported.set(step.nodeId, (this.supported.get(step.nodeId) || 0) + 1);
    this.supportEvents.push({ t: b.freeAt, key: inst.key, nodeId: step.nodeId, action: 'place', name: tool.name });
    this.updateStability(b.freeAt);
  }

  finish() {
    const finite = this.segments.filter((s) => Number.isFinite(s.t1));
    let end = finite.length ? Math.max(...finite.map((s) => s.t1)) : 0;
    for (const u of this.units.values()) if (u.installed && u.stableAt == null && u.holder) end = Math.max(end, u.installedAt);
    // Close any holds that never ended so they show up on the chart.
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
      const loose = [];
      for (const u of this.units.values()) {
        if (!u.installed) continue;
        for (const [n, c] of Object.entries(u.boltsAt)) if (c > 0 && !u.fastened[n]) loose.push(`${u.name} at ${nodeLabel(this.model, n)}`);
      }
      if (loose.length) this.warn(`Bolts never fastened (nothing else connects there): ${loose.slice(0, 5).join('; ')}${loose.length > 5 ? '; …' : ''}.`);
      const left = this.toolInst.filter((ti) => ti.placedAt);
      if (left.length) this.warn(`Supports still under the bridge at the end: ${left.map((ti) => ti.tool.name + ' at ' + nodeLabel(this.model, ti.placedAt)).join('; ')}.`);
    }
    this.endTime = end;
  }

  result() {
    const busy = new Map();
    for (const s of this.segments) if (s.kind !== 'wait') busy.set(s.builderId, (busy.get(s.builderId) || 0) + Math.min(s.t1, this.endTime ?? s.t1) - s.t0);
    return {
      endTime: this.endTime ?? 0,
      segments: this.segments.filter((s) => Number.isFinite(s.t1)),
      holds: this.holds.map((h) => ({
        ...h,
        duration: (h.end ?? this.endTime) - h.start,
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
      builders: this.builders.map((b) => ({ id: b.id, name: b.name, color: b.color, start: b.start, busy: busy.get(b.id) || 0 })),
      units: [...this.units.values()].map((u) => ({ key: u.key, name: u.name, type: u.type, memberIds: u.memberIds, installedAt: u.installedAt ?? null, stableAt: u.stableAt ?? null })),
      unitOfMember: new Map([...this.unitOfMember].map(([m, u]) => [m, u.key])),
      model: this.model,
    };
  }
}

export function fmt(t) {
  if (!Number.isFinite(t)) return '–';
  const m = Math.floor(t / 60), s = t - m * 60;
  return `${m}:${s < 10 ? '0' : ''}${s.toFixed(1)}`;
}
