// The build order in the game: the list of assemblies and single pieces, in the order they become
// available in the ready area. It comes from the Build Sequencer's plan (js/model/buildorder.js).
// Each item is {id, memberIds, buddy, time}:
//   buddy – large or awkward: whoever carries it into place can only hold it there, and someone
//           else has to bolt it
//   time  – seconds to make the assembly (null = the setup's assembly time)
import { buildModel, footingRanges } from '../../js/model/geometry.js';

export const isAssembly = (item) => item.memberIds.length > 1;

export function itemName(item, model, i) {
  const names = item.memberIds.map((id) => model.memberById.get(id)?.name || '?');
  return (i != null ? '#' + (i + 1) + ' ' : '') + names.join(' + ');
}

// Problems that stop the game from starting (each {msg}): shared with the sequencer.
export { orderProblems } from '../../js/model/buildorder.js';

// Seconds for one builder to make an assembly: each connection inside it lined up and its nuts fastened.
export function assemblyTime(item, project, model, fastenTime) {
  if (item.time != null) return item.time;
  if (!isAssembly(item)) return 0;
  const tm = project.timing;
  const ids = new Set(item.memberIds);
  let t = 0;
  for (const c of model.contacts) {
    if (!ids.has(c.a) || !ids.has(c.b) || !c.bolts) continue;
    const align = c.alignTime ?? (tm.assemblyAlignTime || tm.alignTime || 6);
    const bolt = c.boltTime ?? (tm.assemblyBoltTime || fastenTime);
    t += align + c.bolts * ((tm.insertTime || 0) + bolt);
  }
  return Math.max(5, Math.round(t));
}

// Default time to fasten one nut: the first fastening tool's time, else by hand.
// Seconds for an assembly in the game: its own time if set (order editor), else
// the setup's assembly time (settings.assemblyTime), or the sequencer's time if that is 0.
export function gameAssemblyTime(item, project, model, settings) {
  if (item.time != null) return item.time;
  if (!isAssembly(item)) return 0;
  if (settings.assemblyTime > 0) return settings.assemblyTime;
  return assemblyTime({ ...item, time: null }, project, model, defaultFastenTime(project));
}

// The game's default nut time: quicker than the sequencer's (a game should keep moving).
export const gameFastenTime = (project) => Math.max(0.5, Math.round(defaultFastenTime(project) * 0.6 * 10) / 10);

export function defaultFastenTime(project) {
  const tool = project.tools.find((t) => t.kind === 'fastener' && t.boltTime > 0);
  return tool ? tool.boltTime : project.timing.boltTimeHand || 10;
}

// Which footing (index into footingRanges, west first) an item starts from.
export function startFooting(project, model, item) {
  const F = footingRanges(project);
  if (!F.length || !item) return 0;
  const ms = item.memberIds.map((id) => model.memberById.get(id)).filter(Boolean);
  const xs = ms.filter((m) => m.bearing).map((m) => m.bearingPoint[0]);
  const x = xs.length ? xs[0] : ms.reduce((s, m) => s + m.centroid[0], 0) / Math.max(1, ms.length);
  let best = 0;
  F.forEach(([a, b], i) => { if (Math.abs((a + b) / 2 - x) < Math.abs((F[best][0] + F[best][1]) / 2 - x)) best = i; });
  return best;
}
