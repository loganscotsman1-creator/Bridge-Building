// The timeline the plan is built on: one row per builder, with each step as a bar. Steps from the
// task list are dropped onto a row, and bars can be dragged to another time or builder, or (support
// and "other" bars) stretched by their right end. Marks on the bars and the alert strip along the
// top show what the plan is missing as it's being built.
import { html, useEffect, useRef, useState } from '../lib/preact.js';
import { SEGMENT_KINDS, fmt } from '../sim/simulate.js';
import { sideOf, taskLabel } from '../model/plan.js';
import { TASK_KINDS, dropSlot, shortLabel, taskBlocks, taskGroup } from '../model/timeline.js';

const LEFT = 132, RULER = 22, ALERTS = 18, MAIN = 30, ALONG = 18, LANE = MAIN + ALONG + 4;

export function Timeline({ project, model, plan, sim, checks, t, setT, selected, onSelect, dragging, apiRef, onMove, onEdit }) {
  const ref = useRef(null);
  const [pps, setPps] = useState(4); // pixels per second
  const [press, setPress] = useState(null); // a bar being pressed or dragged: {taskId, x0, y0, x, y, moved}
  const [stretch, setStretch] = useState(null); // a support or "other" bar being stretched: {task, start, t1}
  const blocks = taskBlocks(plan, sim, project);
  const builders = project.builders;
  const allBlocks = [...blocks.values()].flat();
  const lastT = Math.max(sim.endTime || 0, 0, ...allBlocks.map((b) => b.end));
  const end = Math.max(lastT + 45, 120);
  const inner = LEFT + end * pps;
  const height = RULER + ALERTS + builders.length * LANE;

  const slotAt = (x, y, exclude) => {
    const el = ref.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (x < r.left || x > r.right || y < r.top || y > r.bottom) return null;
    const ly = y - r.top + el.scrollTop - RULER - ALERTS;
    if (ly < 0) return null;
    const lane = Math.floor(ly / LANE);
    const b = builders[lane];
    if (!b) return null;
    const time = Math.max(0, (x - r.left + el.scrollLeft - LEFT) / pps);
    return { ...dropSlot(blocks, b.id, time, ly - lane * LANE > MAIN + 1, exclude), lane };
  };
  if (apiRef) apiRef.current = { slotAt };
  const slotRef = useRef(slotAt);
  slotRef.current = slotAt;
  const handlers = useRef(null);
  handlers.current = { onSelect, onMove, onEdit, plan, pps };

  // Keep what's being dragged in view by scrolling at the edges.
  const nudge = (x) => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (x > r.right - 30) el.scrollLeft += 24;
    else if (x < r.left + LEFT + 20) el.scrollLeft -= 24;
  };

  const pressing = !!press;
  useEffect(() => {
    if (!pressing) return;
    let cur = press;
    const move = (e) => {
      cur = { ...cur, x: e.clientX, y: e.clientY, moved: cur.moved || Math.hypot(e.clientX - cur.x0, e.clientY - cur.y0) > 5 };
      setPress(cur);
      if (cur.moved) nudge(e.clientX);
    };
    const up = (e) => {
      const h = handlers.current;
      if (!cur.moved) h.onSelect(cur.taskId);
      else {
        const slot = slotRef.current(e.clientX, e.clientY, new Set(taskGroup(h.plan.tasks, cur.taskId).map((x) => x.id)));
        if (slot) h.onMove(cur.taskId, slot);
      }
      setPress(null);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
  }, [pressing]);

  const stretching = !!stretch;
  useEffect(() => {
    if (!stretching) return;
    let cur = stretch;
    const timeAt = (e) => {
      const r = ref.current.getBoundingClientRect();
      return (e.clientX - r.left + ref.current.scrollLeft - LEFT) / handlers.current.pps;
    };
    const move = (e) => { cur = { ...cur, t1: Math.max(cur.start + 0.5, timeAt(e)) }; setStretch(cur); nudge(e.clientX); };
    const up = () => {
      const secs = Math.round((cur.t1 - cur.start) * 10) / 10;
      handlers.current.onEdit(cur.task.id, cur.task.kind === 'support' ? { until: secs } : { duration: secs });
      setStretch(null);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
  }, [stretching]);

  const seekFrom = (e) => {
    const r = ref.current.getBoundingClientRect();
    setT(Math.max(0, Math.min(lastT, (e.clientX - r.left + ref.current.scrollLeft - LEFT) / pps)));
  };
  const startSeek = (e) => {
    e.preventDefault();
    seekFrom(e);
    const move = (ev) => seekFrom(ev);
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const fit = () => {
    const w = ref.current.clientWidth - LEFT - 24;
    setPps(Math.max(0.2, Math.min(40, w / Math.max(30, lastT + 10))));
    ref.current.scrollLeft = 0;
  };
  const zoomBy = (f) => {
    const el = ref.current;
    const centre = (el.scrollLeft + el.clientWidth / 2 - LEFT) / pps;
    const next = Math.max(0.2, Math.min(40, pps * f));
    setPps(next);
    requestAnimationFrame(() => { if (ref.current) ref.current.scrollLeft = centre * next + LEFT - el.clientWidth / 2; });
  };
  useEffect(() => {
    const el = ref.current;
    const wheel = (e) => { if (!e.ctrlKey && !e.metaKey) return; e.preventDefault(); zoomBy(Math.exp(-e.deltaY * 0.002)); };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  });

  const tickStep = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600].find((s) => s * pps >= 56) || 600;
  const ticks = [];
  for (let s = 0; s <= end; s += tickStep) ticks.push(s);
  const X = (s) => LEFT + s * pps;
  const laneY = (i) => RULER + ALERTS + i * LANE;
  const laneOf = new Map(builders.map((b, i) => [b.id, i]));

  // Bars' colors come from what happens within them.
  const segsOf = new Map();
  const loose = [];
  for (const s of sim.segments || []) {
    if (s.taskId) { if (!segsOf.has(s.taskId)) segsOf.set(s.taskId, []); segsOf.get(s.taskId).push(s); } else loose.push(s);
  }
  const problems = new Map();
  const note = (list, level) => list.forEach((e) => {
    const task = e.step != null && e.step >= 0 ? plan.tasks[e.step] : null;
    if (!task) return;
    const cur = problems.get(task.id);
    problems.set(task.id, { level: cur?.level === 'err' ? 'err' : level, msgs: [...(cur?.msgs || []), e.msg] });
  });
  note(sim.errors || [], 'err');
  note(sim.warnings || [], 'warn');

  // What a drag would do, shown as a marker.
  const liftedIds = press?.moved ? new Set(taskGroup(plan.tasks, press.taskId).map((x) => x.id)) : null;
  const dragSlot = dragging ? slotAt(dragging.x, dragging.y, new Set()) : liftedIds ? slotAt(press.x, press.y, liftedIds) : null;
  const markerTime = (slot) => {
    if (slot.with) return allBlocks.find((b) => b.task.id === slot.with)?.start ?? slot.time;
    if (slot.before) return allBlocks.find((b) => b.task.id === slot.before)?.start ?? slot.time;
    const mine = (blocks.get(slot.builder) || []).filter((b) => !b.along && !liftedIds?.has(b.task.id));
    return mine.length ? mine[mine.length - 1].end : 0;
  };
  const flag = (e, i, cls) => e.t != null && html`<button key=${cls + i} class=${'tl-flag ' + cls} style=${{ left: X(e.t) + 'px' }} title=${e.msg}
    onClick=${() => { if (plan.tasks[e.step]) onSelect(plan.tasks[e.step].id); setT(e.t); }}>!</button>`;

  return html`<div class="tl-wrap">
    <div class="tl-zoom">
      <button class="small" title="Zoom out (or Ctrl + scroll)" onClick=${() => zoomBy(0.7)}>−</button>
      <button class="small" title="Zoom in (or Ctrl + scroll)" onClick=${() => zoomBy(1.4)}>+</button>
      <button class="small" title="Show the whole plan" onClick=${fit}>Fit</button>
    </div>
    <div class="tl" ref=${ref} data-tour="seq-timeline">
      <div class="tl-inner" style=${{ width: inner + 'px', height: height + 'px' }}>
        ${ticks.map((s) => html`<i key=${'g' + s} class="tl-grid" style=${{ left: X(s) + 'px', height: height + 'px' }}></i>`)}
        ${builders.map((b, i) => {
          const sb = sim.builders?.find((x) => x.id === b.id);
          const side = sideOf(project.site, b.start);
          return html`<div key=${b.id} class=${'tl-lane' + (i % 2 ? ' odd' : '') + (dragSlot?.lane === i ? ' over' : '')} style=${{ top: laneY(i) + 'px', height: LANE + 'px', width: inner + 'px' }}>
            <div class="tl-name">
              <span class="dot" style=${{ background: b.color }}></span>
              <span class="nm"><b>${b.name}</b><small>${side || ''}${sb?.boltCount ? ` · ${sb.boltsUsed || 0}/${sb.boltCount} bolts` : ''}</small></span>
            </div>
          </div>`;
        })}
        ${loose.map((s, i) => laneOf.has(s.builderId) && html`<i key=${'l' + i} class="tl-loose" title=${s.label || SEGMENT_KINDS[s.kind]?.label}
          style=${{ left: X(s.t0) + 'px', width: Math.max(1, (s.t1 - s.t0) * pps) + 'px', top: laneY(laneOf.get(s.builderId)) + 2 + 'px', height: MAIN + 'px', background: SEGMENT_KINDS[s.kind]?.color }}></i>`)}
        ${allBlocks.map((block) => {
          const { task, start, ghost, along, why } = block;
          const beingStretched = stretch?.task.id === task.id;
          const barEnd = beingStretched ? stretch.t1 : block.end;
          const i = laneOf.get(task.builder);
          if (i == null) return null;
          const w = Math.max(along ? 12 : 16, (barEnd - start) * pps);
          const pb = problems.get(task.id);
          const marks = checks.marks.get(task.id) || [];
          const canStretch = (task.kind === 'support' || task.kind === 'other') && !ghost;
          const title = [taskLabel(task, model, plan, project), ghost ? '' : `${fmt(start)} – ${fmt(barEnd)} (${(barEnd - start).toFixed(1)} s)`, why, ...(pb?.msgs || []), ...marks.map((m) => m.text)].filter(Boolean).join('\n');
          return html`<div key=${task.id} data-task=${task.id} title=${title}
            class=${'tl-bar' + (along ? ' along' : '') + (ghost ? ' ghost' : '') + (selected === task.id ? ' sel' : '') + (pb ? ' ' + pb.level : '') + (liftedIds?.has(task.id) ? ' lifted' : '')}
            style=${{ left: X(start) + 'px', width: w + 'px', top: laneY(i) + (along ? MAIN + 3 : 2) + 'px', height: (along ? ALONG : MAIN) + 'px' }}
            onPointerDown=${(e) => { if (e.button !== 0) return; e.preventDefault(); e.stopPropagation(); setPress({ taskId: task.id, x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, moved: false }); }}>
            ${!ghost && (segsOf.get(task.id) || []).map((s, k) => html`<i key=${k} style=${{ left: (s.t0 - start) * pps + 'px', width: Math.max(1, ((beingStretched ? barEnd : s.t1) - s.t0) * pps) + 'px', background: SEGMENT_KINDS[s.kind]?.color }}></i>`)}
            <span class="tl-text"><span class="ic">${TASK_KINDS[task.kind]?.[0]}</span> ${shortLabel(task, model, plan, project)}</span>
            ${marks.length > 0 && html`<span class="tl-marks">${marks.map((m, k) => html`<b key=${k} class=${m.bad ? 'bad' : ''}>${m.icon}${m.n > 1 ? m.n : ''}</b>`)}</span>`}
            ${canStretch && html`<span class="tl-stretch" title="Drag to change how long this lasts"
              onPointerDown=${(e) => { e.preventDefault(); e.stopPropagation(); setStretch({ task, start, t1: block.end }); }}></span>`}
            ${beingStretched && html`<span class="tl-secs">${(barEnd - start).toFixed(1)} s</span>`}
          </div>`;
        })}
        ${dragSlot && html`<i class=${'tl-drop' + (dragSlot.along ? ' along' : '')} style=${{ left: X(markerTime(dragSlot)) + 'px', top: laneY(dragSlot.lane) + (dragSlot.along ? MAIN + 3 : 1) + 'px', height: (dragSlot.along ? ALONG : MAIN + 2) + 'px' }}>
          <em>${dragSlot.along ? 'At the same time' : dragSlot.before ? 'Before this' : 'Next'}</em></i>`}
        <i class="tl-now" style=${{ left: X(t) + 'px', height: height + 'px' }}></i>
        ${!plan.tasks?.length && html`<div class="tl-empty" style=${{ left: LEFT + 20 + 'px', top: RULER + ALERTS + 12 + 'px' }}>Drag a task from the list onto a builder's row to start.</div>`}
        <div class="tl-head" style=${{ width: inner + 'px' }}>
          <div class="tl-ruler" onPointerDown=${startSeek} title="Click or drag to see the bridge at that moment">
            ${ticks.map((s) => html`<span key=${s} style=${{ left: X(s) + 'px' }}>${fmt(s).replace(/\.\d$/, '')}</span>`)}
          </div>
          <div class="tl-alerts">
            ${(sim.warnings || []).map((e, i) => flag(e, i, 'warn'))}
            ${(sim.errors || []).map((e, i) => flag(e, i, 'err'))}
          </div>
          <div class="tl-corner">Problems</div>
        </div>
      </div>
    </div>
  </div>`;
}
