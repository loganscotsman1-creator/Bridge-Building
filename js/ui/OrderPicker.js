// The build order window, shown when the Build sequence tab opens. Two steps, both on the 3D bridge:
//   1 · Make assemblies: click pieces into assemblies (up to three each).
//   2 · Put in order: click pieces and assemblies in the order they go in.
// The timeline offers tasks in this order, and the game (open in another tab) plays it, updating as
// it changes here. It sits over the tab only, so the other tabs stay usable.
import { html, useEffect, useState } from '../lib/preact.js';
import { updateProject } from '../model/store.js';
import { activePlan } from '../model/schema.js';
import { uid } from '../model/ids.js';
import { ASM_COLORS } from '../model/timeline.js';
import { deriveOrder, isAssemblyItem, orderProblems, planOrder, setOrder } from '../model/buildorder.js';
import { IsoView } from './IsoView.js';

// Earliest blue through to latest red, as hex (IsoView shades hex colors).
function orderColor(i, n) {
  const h = (220 - (200 * i) / Math.max(1, n - 1)) / 360, s = 0.7, l = 0.5;
  const f = (k) => { const t = (k + h * 12) % 12; const c = l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(t - 3, 9 - t, 1)); return Math.round(c * 255).toString(16).padStart(2, '0'); };
  return '#' + f(0) + f(8) + f(4);
}
const copy = (list) => list.map((it) => ({ ...it, memberIds: [...it.memberIds] }));
const single = (id) => ({ id: uid('it'), memberIds: [id], buddy: false });

export function OrderPicker({ project, model, onClose }) {
  const plan = activePlan(project);
  const order = planOrder(model, plan, { fill: false });
  const inOrder = new Set(order.map((it) => it.id));
  // Assemblies made but not put in the order yet.
  const spare = plan.assemblies.filter((a) => !inOrder.has(a.id) && a.memberIds.length > 1).map((a) => ({ id: a.id, memberIds: [...a.memberIds], buddy: false }));
  const [mode, setMode] = useState(() => (order.length ? 'order' : 'assemblies'));
  const [sel, setSel] = useState(null); // order step: the item picked out in the list
  const [cur, setCur] = useState(null); // assemblies step: the assembly pieces are clicked into
  const [draft, setDraft] = useState(null); // a new assembly with fewer than two pieces so far
  const [drag, setDrag] = useState(null);
  const max = project.site.rules?.maxAssemblyMembers || 3;

  const assemblies = [...order.filter(isAssemblyItem), ...spare, ...(draft ? [draft] : [])];
  const nameOf = (id) => plan.assemblies.find((a) => a.id === id)?.name || 'New assembly';
  const asmOfMember = new Map();
  assemblies.forEach((a) => a.memberIds.forEach((id) => asmOfMember.set(id, a.id)));
  const idx = new Map();
  order.forEach((it, i) => it.memberIds.forEach((id) => idx.set(id, i)));
  const loose = model.members.filter((m) => !idx.has(m.id) && !asmOfMember.has(m.id));
  const problems = orderProblems(order, model, project.site.rules, { strict: false });
  const gameNote = order.length && order[0].memberIds.length !== 3;

  // Every change goes straight onto the plan (undoable, autosaved, and picked up by the game).
  const commit = (items, spares) => updateProject((p) => setOrder(activePlan(p), model, items.filter((it) => it.memberIds.length), spares.filter((a) => a.memberIds.length > 1)));

  // ---- step 1: assemblies ----
  const startNew = () => { const d = { id: uid('as'), memberIds: [], buddy: false }; setDraft(d); setCur(d.id); };
  const assign = (m) => {
    let target = assemblies.find((a) => a.id === cur);
    if (!target) {
      // Nothing being filled: a piece in an assembly picks that one, any other piece starts one.
      if (asmOfMember.has(m.id)) { setCur(asmOfMember.get(m.id)); return; }
      target = { id: uid('as'), memberIds: [], buddy: false };
      setCur(target.id);
    }
    const has = target.memberIds.includes(m.id);
    if (!has && target.memberIds.length >= max) return;
    const members = has ? target.memberIds.filter((id) => id !== m.id) : [...target.memberIds, m.id];
    const isDraft = !order.some((it) => it.id === target.id) && !spare.some((a) => a.id === target.id);
    if (isDraft && members.length < 2) { setDraft({ ...target, memberIds: members }); return; }
    // The piece leaves wherever it was (another assembly, or the order as a single piece).
    const strip = (list) => copy(list).map((it) => (it.id === target.id ? it : { ...it, memberIds: it.memberIds.filter((id) => id !== m.id && !(isDraft && members.includes(id))) }));
    let items = strip(order), spares = strip(spare);
    if (isDraft) { spares.push({ id: target.id, memberIds: members, buddy: false }); setDraft(null); }
    else { items = items.map((it) => (it.id === target.id ? { ...it, memberIds: members } : it)); spares = spares.map((a) => (a.id === target.id ? { ...a, memberIds: members } : a)); }
    // An assembly left with one piece is no assembly: that piece goes back to the pool.
    items = items.filter((it) => !(it.id === target.id && members.length < 2));
    commit(items, spares);
  };
  const takeApart = (a) => {
    if (cur === a.id) setCur(null);
    if (draft?.id === a.id) { setDraft(null); return; }
    // Its pieces go back to the pool (out of the order) to be picked one by one.
    commit(copy(order).filter((it) => it.id !== a.id), spare.filter((x) => x.id !== a.id));
  };

  // ---- step 2: the order ----
  const unitOf = (m) => {
    const aid = asmOfMember.get(m.id);
    return aid ? assemblies.find((a) => a.id === aid) : single(m.id);
  };
  const place = (m) => {
    const u = unitOf(m);
    if (!u || u.memberIds.length < 1) return;
    if (u.id === draft?.id) return;
    const at = order.findIndex((it) => it.id === u.id || it.memberIds.includes(m.id));
    if (at >= 0) { setSel(order[at].id === sel ? null : order[at].id); return; }
    commit([...copy(order), { ...u, memberIds: [...u.memberIds] }], spare.filter((a) => a.id !== u.id));
  };
  const edit = (fn) => commit(fn(copy(order)), spare);
  const move = (from, to) => edit((o) => { const [x] = o.splice(from, 1); o.splice(to, 0, x); return o; });
  const patch = (id, p) => edit((o) => o.map((x) => (x.id === id ? { ...x, ...p } : x)));
  const removeItem = (it) => {
    if (sel === it.id) setSel(null);
    commit(copy(order).filter((x) => x.id !== it.id), isAssemblyItem(it) ? [...spare, it] : spare);
  };

  useEffect(() => {
    const key = (e) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      if (cur || sel) { setCur(null); setSel(null); setDraft(null); } else onClose();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  });

  const asmColor = (id) => ASM_COLORS[Math.max(0, assemblies.findIndex((a) => a.id === id)) % ASM_COLORS.length];
  const styleOf = (m) => {
    if (mode === 'assemblies') {
      const aid = asmOfMember.get(m.id);
      if (!aid) return { color: '#cbd5e1', opacity: 0.45, label: m.name, dash: '2 2', outline: null };
      return { color: asmColor(aid), label: m.name, outline: aid === cur ? '#facc15' : null };
    }
    if (!idx.has(m.id)) return { color: asmOfMember.has(m.id) ? asmColor(asmOfMember.get(m.id)) : '#cbd5e1', opacity: 0.35, label: asmOfMember.has(m.id) ? nameOf(asmOfMember.get(m.id)) : m.name, dash: '2 2' };
    const i = idx.get(m.id);
    const it = order[i];
    return { color: orderColor(i, order.length), label: '#' + (i + 1) + (it.buddy ? '★' : ''), outline: it.id === sel ? '#facc15' : null };
  };
  const curA = assemblies.find((a) => a.id === cur);
  const label = mode === 'assemblies'
    ? curA ? `Click pieces into ${curA.id === draft?.id ? 'the new assembly' : nameOf(curA.id)} (${curA.memberIds.length}/${max}); click one again to take it out` : 'Click a piece to start an assembly, or an assembly\'s piece to change it'
    : sel ? `#${order.findIndex((x) => x.id === sel) + 1} picked out · click it again (or Esc) to stop` : (loose.length + spare.length) ? `${loose.length + spare.length} still to put in order` : 'Everything is in the order';

  const asmCard = (a) => {
    const n = order.findIndex((it) => it.id === a.id);
    const isDraft = a.id === draft?.id;
    return html`<div key=${a.id} class=${'order-item asm-card' + (a.id === cur ? ' sel' : '')} data-asm=${a.id} onClick=${() => { if (a.id === cur) { setCur(null); if (isDraft) setDraft(null); } else setCur(a.id); }}>
      <span class="sw" style=${{ background: asmColor(a.id) }}>${a.memberIds.length}</span>
      <div class="bd">
        <div class="asm-name">${isDraft ? 'New assembly' : nameOf(a.id)}</div>
        <div class="pcs">${a.memberIds.length ? a.memberIds.map((id) => html`<span class="pc">${model.memberById.get(id)?.name || '?'}</span>`) : html`<span class="muted small">Click pieces on the bridge</span>`}</div>
        <div class="muted small">${isDraft ? `Needs at least two pieces` : n >= 0 ? `In the order as #${n + 1}` : 'Not in the order yet'}</div>
      </div>
      <div class="ops" onClick=${(e) => e.stopPropagation()}>
        <button class="small" title="Take it apart into loose pieces" onClick=${() => takeApart(a)}>✕</button>
      </div>
    </div>`;
  };

  return html`<div class="order-back">
    <div class="order-pop" role="dialog" aria-label="Build order" data-order-picker>
      <div class="pop-head">
        <div class="order-steps">
          <b>Build order</b>
          <button class=${mode === 'assemblies' ? 'on' : ''} data-mode="assemblies" onClick=${() => { setMode('assemblies'); setSel(null); }}>1 · Make assemblies</button>
          <button class=${mode === 'order' ? 'on' : ''} data-mode="order" onClick=${() => { setMode('order'); setCur(null); setDraft(null); }}>2 · Put in order</button>
        </div>
        <span class="spacer"></span>
        ${mode === 'order' && html`<button title="Fill the order automatically: footings first, west to east (your assemblies are kept)" onClick=${() => { if (!order.length || confirm('Replace the order with the automatic one? Your assemblies are kept.')) { commit(deriveOrder(model, { ...plan, order: null, tasks: [] }), []); setSel(null); } }}>Automatic order</button>`}
        ${mode === 'order' && html`<button disabled=${!order.length} title="Take everything out of the order (assemblies are kept)" onClick=${() => { if (confirm('Take everything out of the order? Your assemblies are kept (Ctrl+Z brings it back).')) { commit([], assemblies.filter((a) => a.id !== draft?.id)); setSel(null); } }}>Clear order</button>`}
        <button class="primary" data-continue onClick=${onClose}>Continue to the timeline →</button>
      </div>
      <div class="order-hint muted small">${mode === 'assemblies'
        ? `Click pieces on the bridge to group them into an assembly (up to ${max}). Clicking a piece that's already in an assembly picks that assembly to change. Then put everything in order in step 2. Drag to turn the bridge.`
        : 'Click pieces on the bridge in the order they go in. Clicking any piece of an assembly puts the whole assembly in. Drag items in the list (or use the arrows) to reorder. Drag to turn the bridge.'}</div>
      <div class="pop-body order-body">
        <div class="pop-canvas">
          <${IsoView} model=${model} styleOf=${styleOf} onPick=${mode === 'assemblies' ? assign : place} label=${label} />
        </div>
        <aside class="pop-list order-list">
          ${mode === 'assemblies' ? html`
            <button class="primary" data-new-asm onClick=${startNew}>+ New assembly</button>
            ${!assemblies.length && html`<div class="muted small">No assemblies yet. Click a piece on the bridge, or <b>+ New assembly</b>.</div>`}
            ${assemblies.map(asmCard)}
            <button onClick=${() => setMode('order')}>Next: put them in order →</button>
          ` : html`
            ${problems.length > 0 && html`<ul class="order-problems">${problems.map((p) => html`<li>${p.msg}</li>`)}</ul>`}
            ${gameNote && html`<div class="order-note">The game starts with a three-piece assembly, so make the first item one if you want to play this order.</div>`}
            ${!order.length && html`<div class="muted small">Nothing in order yet. Click the first piece on the bridge, use the list below, or <b>Automatic order</b>.</div>`}
            ${order.map((it, i) => html`<div key=${it.id} class=${'order-item' + (it.id === sel ? ' sel' : '') + (drag === i ? ' dragging' : '')} draggable="true" data-order-item=${i}
                onDragStart=${(e) => { setDrag(i); e.dataTransfer.effectAllowed = 'move'; }}
                onDragOver=${(e) => e.preventDefault()}
                onDrop=${(e) => { e.preventDefault(); if (drag != null && drag !== i) move(drag, i); setDrag(null); }}
                onDragEnd=${() => setDrag(null)}
                onClick=${() => setSel(it.id === sel ? null : it.id)}>
              <span class="sw" style=${{ background: orderColor(i, order.length) }}>${i + 1}</span>
              <div class="bd">
                ${isAssemblyItem(it) && html`<div class="asm-name">${nameOf(it.id)}</div>`}
                <div class="pcs">${it.memberIds.map((id) => html`<span class="pc">${model.memberById.get(id)?.name || '?'}</span>`)}</div>
                <label class="check small" onClick=${(e) => e.stopPropagation()} title="In the game: large or awkward, so whoever carries it into place can only hold it there, and someone else bolts it">
                  <input type="checkbox" checked=${!!it.buddy} onChange=${(e) => patch(it.id, { buddy: e.target.checked })} /> Needs a buddy ★</label>
              </div>
              <div class="ops" onClick=${(e) => e.stopPropagation()}>
                <button class="small" disabled=${i === 0} title="Earlier" onClick=${() => move(i, i - 1)}>↑</button>
                <button class="small" disabled=${i === order.length - 1} title="Later" onClick=${() => move(i, i + 1)}>↓</button>
                <button class="small" title="Take out of the order" onClick=${() => removeItem(it)}>✕</button>
              </div>
            </div>`)}
            ${(spare.length > 0 || loose.length > 0) && html`<div class="order-missing"><b>Not in the order yet</b> <span class="muted">(click to add at the end)</span>
              <div class="pcs">
                ${spare.map((a) => html`<button class="small asm-btn" style=${{ borderColor: asmColor(a.id) }} onClick=${() => place(model.memberById.get(a.memberIds[0]))}>🧩 ${nameOf(a.id)}</button>`)}
                ${loose.map((m) => html`<button class="small" onClick=${() => place(m)}>${m.name}</button>`)}
              </div></div>`}
          `}
        </aside>
      </div>
    </div>
  </div>`;
}
