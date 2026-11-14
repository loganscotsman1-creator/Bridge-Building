// The build order window, shown when the Build sequence tab opens: click pieces on the 3D bridge in
// the order they go in, group up to three into an assembly, and put every piece in order. The
// timeline offers tasks in this order, and the game (open in another tab) plays it, updating as
// it changes here.
import { html, useEffect, useState } from '../lib/preact.js';
import { updateProject } from '../model/store.js';
import { activePlan } from '../model/schema.js';
import { uid } from '../model/ids.js';
import { deriveOrder, isAssemblyItem, orderProblems, planOrder, setOrder } from '../model/buildorder.js';
import { IsoView } from './IsoView.js';

// Earliest blue through to latest red, as hex (IsoView shades hex colors).
function orderColor(i, n) {
  const h = (220 - (200 * i) / Math.max(1, n - 1)) / 360, s = 0.7, l = 0.5;
  const f = (k) => { const t = (k + h * 12) % 12; const c = l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(t - 3, 9 - t, 1)); return Math.round(c * 255).toString(16).padStart(2, '0'); };
  return '#' + f(0) + f(8) + f(4);
}

export function OrderPicker({ project, model, onClose }) {
  const plan = activePlan(project);
  const order = planOrder(model, plan, { fill: false });
  const [sel, setSel] = useState(null); // the item pieces are being added to
  const [drag, setDrag] = useState(null);
  const max = project.site.rules?.maxAssemblyMembers || 3;
  const idx = new Map();
  order.forEach((it, i) => it.memberIds.forEach((id) => idx.set(id, i)));
  const selItem = order.find((it) => it.id === sel);
  const missing = model.members.filter((m) => !idx.has(m.id));
  const problems = orderProblems(order, model, project.site.rules, { strict: false });
  const gameNote = order.length && order[0].memberIds.length !== 3;
  const asmName = new Map(order.filter(isAssemblyItem).map((it, i) => [it.id, plan.assemblies.find((a) => a.id === it.id)?.name || 'Assembly ' + (i + 1)]));

  // Every change goes straight onto the plan (undoable, autosaved, and picked up by the game).
  const commit = (items) => updateProject((p) => setOrder(activePlan(p), model, items.filter((it) => it.memberIds.length)));
  const edit = (fn) => commit(fn(order.map((it) => ({ ...it, memberIds: [...it.memberIds] }))));
  const single = (id) => ({ id: uid('it'), memberIds: [id], buddy: false });
  // An item that becomes an assembly gets a fresh id, so it doesn't take over a loose piece's steps.
  const grow = (it, id) => ({ ...it, id: isAssemblyItem(it) ? it.id : uid('as'), memberIds: [...it.memberIds, id] });

  const pick = (m) => {
    if (idx.has(m.id)) {
      const it = order[idx.get(m.id)];
      // With an item selected, clicking one of its pieces takes it back out (to the end of the order).
      if (selItem && it.id === selItem.id) {
        if (it.memberIds.length > 1) edit((o) => o.map((x) => (x.id === it.id ? { ...x, memberIds: x.memberIds.filter((id) => id !== m.id) } : x)).concat([single(m.id)]));
        else setSel(null);
        return;
      }
      if (selItem && selItem.memberIds.length < max) {
        const grown = grow(selItem, m.id);
        edit((o) => o.map((x) => (x.id === it.id ? { ...x, memberIds: x.memberIds.filter((id) => id !== m.id) } : x.id === selItem.id ? grown : x)));
        setSel(grown.id);
        return;
      }
      setSel(it.id === sel ? null : it.id);
      return;
    }
    if (selItem && selItem.memberIds.length < max) {
      const grown = grow(selItem, m.id);
      edit((o) => o.map((x) => (x.id === selItem.id ? grown : x)));
      setSel(grown.id);
    } else edit((o) => [...o, single(m.id)]);
  };
  const move = (from, to) => edit((o) => { const c = [...o]; const [x] = c.splice(from, 1); c.splice(to, 0, x); return c; });
  const patch = (id, p) => edit((o) => o.map((x) => (x.id === id ? { ...x, ...p } : x)));

  useEffect(() => {
    const key = (e) => { if (e.key === 'Escape') { e.stopPropagation(); if (sel) setSel(null); else onClose(); } };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  });

  const styleOf = (m) => {
    if (!idx.has(m.id)) return { color: '#cbd5e1', opacity: 0.35, label: m.name, dash: '2 2' };
    const i = idx.get(m.id);
    const it = order[i];
    return { color: orderColor(i, order.length), label: '#' + (i + 1) + (it.buddy ? '★' : ''), outline: it.id === sel ? '#facc15' : null };
  };

  return html`<div class="pop-back order-back">
    <div class="pop wide order-pop" role="dialog" aria-label="Build order" data-order-picker>
      <div class="pop-head">
        <div>
          <b>Build order</b>
          <div class="muted small">Click pieces in the order they go in. To make an assembly, select an item (click it in the list or on the bridge), then click up to ${max} pieces into it; click one of its pieces again to take it out. Drag to turn the bridge.</div>
        </div>
        <span class="spacer"></span>
        <button title="Replace this order with the automatic one: footings first, west to east" onClick=${() => { if (!order.length || confirm('Replace the order with the automatic one?')) { commit(deriveOrder(model, { ...plan, order: null, tasks: [] })); setSel(null); } }}>Automatic order</button>
        <button disabled=${!order.length} onClick=${() => { if (confirm('Clear the order and click every piece in again? Assemblies are taken apart too (Ctrl+Z brings it back).')) { commit([]); setSel(null); } }}>Clear</button>
        <button class="primary" data-continue disabled=${!order.length} onClick=${onClose}>Continue to the timeline →</button>
      </div>
      <div class="pop-body order-body">
        <div class="pop-canvas">
          <${IsoView} model=${model} styleOf=${styleOf} onPick=${pick}
            label=${selItem ? `Adding to #${order.indexOf(selItem) + 1} · click it in the list (or Esc) to stop` : missing.length ? `${missing.length} piece${missing.length === 1 ? '' : 's'} still to put in order` : 'Every piece is in the order'} />
        </div>
        <aside class="pop-list order-list">
          ${problems.length > 0 && html`<ul class="order-problems">${problems.map((p) => html`<li>${p.msg}</li>`)}</ul>`}
          ${gameNote && html`<div class="order-note">The game starts with a three-piece assembly, so make the first item one if you want to play this order.</div>`}
          ${!order.length && html`<div class="muted small">Nothing in order yet. Click the first piece on the bridge, or use <b>Automatic order</b>.</div>`}
          ${order.map((it, i) => html`<div key=${it.id} class=${'order-item' + (it.id === sel ? ' sel' : '') + (drag === i ? ' dragging' : '')} draggable="true" data-order-item=${i}
              onDragStart=${(e) => { setDrag(i); e.dataTransfer.effectAllowed = 'move'; }}
              onDragOver=${(e) => e.preventDefault()}
              onDrop=${(e) => { e.preventDefault(); if (drag != null && drag !== i) move(drag, i); setDrag(null); }}
              onDragEnd=${() => setDrag(null)}
              onClick=${() => setSel(it.id === sel ? null : it.id)}>
            <span class="sw" style=${{ background: orderColor(i, order.length) }}>${i + 1}</span>
            <div class="bd">
              ${isAssemblyItem(it) && html`<div class="asm-name">${asmName.get(it.id)}</div>`}
              <div class="pcs">${it.memberIds.map((id) => html`<span class="pc">${model.memberById.get(id)?.name || '?'}</span>`)}</div>
              <label class="check small" onClick=${(e) => e.stopPropagation()} title="In the game: large or awkward, so whoever carries it into place can only hold it there, and someone else bolts it">
                <input type="checkbox" checked=${!!it.buddy} onChange=${(e) => patch(it.id, { buddy: e.target.checked })} /> Needs a buddy ★</label>
            </div>
            <div class="ops" onClick=${(e) => e.stopPropagation()}>
              <button class="small" disabled=${i === 0} title="Earlier" onClick=${() => move(i, i - 1)}>↑</button>
              <button class="small" disabled=${i === order.length - 1} title="Later" onClick=${() => move(i, i + 1)}>↓</button>
              ${isAssemblyItem(it) && html`<button class="small" title="Split into single pieces" onClick=${() => edit((o) => o.flatMap((x) => (x.id === it.id ? x.memberIds.map(single) : [x])))}>Split</button>`}
              <button class="small" title="Take out of the order" onClick=${() => { if (sel === it.id) setSel(null); edit((o) => o.filter((x) => x.id !== it.id)); }}>✕</button>
            </div>
          </div>`)}
          ${missing.length > 0 && html`<div class="order-missing"><b>Not in the order yet</b> <span class="muted">(click them on the bridge, or here to add${selItem ? ` to #${order.indexOf(selItem) + 1}` : ' at the end'})</span>
            <div class="pcs">${missing.map((m) => html`<button class="small" onClick=${() => pick(m)}>${m.name}</button>`)}</div></div>`}
        </aside>
      </div>
    </div>
  </div>`;
}
