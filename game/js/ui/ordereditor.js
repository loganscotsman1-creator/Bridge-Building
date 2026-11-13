// Pick the build order on a rotatable 3D bridge: click pieces in the order they come in, group up
// to three into an assembly, and mark the awkward ones as needing a buddy.
import { html, useState } from '../../../js/lib/preact.js';
import { IsoView } from '../../../js/ui/IsoView.js';
import { gameAssemblyTime, defaultOrder, itemId, orderProblems } from '../order.js';

const hue = (i, n) => `hsl(${Math.round(220 - (200 * i) / Math.max(1, n - 1))} 70% 50%)`;
const hex = (i, n) => {
  // IsoView shades hex colors, so convert.
  const h = (220 - (200 * i) / Math.max(1, n - 1)) / 360, s = 0.7, l = 0.5;
  const f = (k) => { const t = (k + h * 12) % 12; const c = l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(t - 3, 9 - t, 1)); return Math.round(c * 255).toString(16).padStart(2, '0'); };
  return '#' + f(0) + f(8) + f(4);
};

export function OrderEditor({ project, model, order, setOrder, settings, onDone }) {
  const [sel, setSel] = useState(null); // selected item id
  const [drag, setDrag] = useState(null);
  const max = project.site.rules?.maxAssemblyMembers || 3;
  const idx = new Map();
  order.forEach((it, i) => it.memberIds.forEach((id) => idx.set(id, i)));
  const selItem = order.find((it) => it.id === sel);
  const problems = orderProblems(order, model, project.site.rules);
  const missing = model.members.filter((m) => !idx.has(m.id));

  const update = (fn) => setOrder(fn(order.map((it) => ({ ...it, memberIds: [...it.memberIds] }))).filter((it) => it.memberIds.length));

  const pick = (m) => {
    if (idx.has(m.id)) {
      const it = order[idx.get(m.id)];
      // With an item selected, clicking one of its pieces takes it back out.
      if (selItem && it.id === selItem.id && it.memberIds.length > 1) { update((o) => o.map((x) => (x.id === it.id ? { ...x, memberIds: x.memberIds.filter((id) => id !== m.id) } : x)).concat([{ id: itemId(), memberIds: [m.id], buddy: false, time: null }])); return; }
      if (selItem && selItem.memberIds.length < max && it.id !== selItem.id) {
        update((o) => o.map((x) => (x.id === it.id ? { ...x, memberIds: x.memberIds.filter((id) => id !== m.id) } : x.id === selItem.id ? { ...x, memberIds: [...x.memberIds, m.id] } : x)));
        return;
      }
      setSel(it.id === sel ? null : it.id);
      return;
    }
    if (selItem && selItem.memberIds.length < max) update((o) => o.map((x) => (x.id === selItem.id ? { ...x, memberIds: [...x.memberIds, m.id] } : x)));
    else { const it = { id: itemId(), memberIds: [m.id], buddy: false, time: null }; update((o) => [...o, it]); }
  };

  const styleOf = (m) => {
    if (!idx.has(m.id)) return { color: '#cbd5e1', opacity: 0.35, label: m.name, dash: '2 2' };
    const i = idx.get(m.id);
    const it = order[i];
    return { color: hex(i, order.length), label: '#' + (i + 1) + (it.buddy ? '★' : ''), outline: it.id === sel ? '#facc15' : null };
  };

  const move = (from, to) => update((o) => { const c = [...o]; const [x] = c.splice(from, 1); c.splice(to, 0, x); return c; });
  const patch = (id, p) => update((o) => o.map((x) => (x.id === id ? { ...x, ...p } : x)));

  return html`<div class="oe oe-editor">
    <header class="oe-top">
      <div class="oe-logo small">OVER<br />ENGINEERED</div>
      <div>
        <b>Build order</b>
        <div class="oe-tag">Click pieces in the order they come in. Select an item, then click pieces to group them into it (up to ${max}); click one of its pieces again to take it out. Drag to turn the bridge.</div>
      </div>
      <div class="row">
        <button onClick=${() => { if (confirm('Start the order over from the sequencer plan?')) { setOrder(defaultOrder(project, model)); setSel(null); } }}>From the sequencer plan</button>
        <button onClick=${() => { if (confirm('Clear the order and click every piece in again?')) { setOrder([]); setSel(null); } }}>Clear</button>
        <button class="primary" onClick=${onDone}>Done</button>
      </div>
    </header>
    <div class="oe-edit-body">
      <div class="oe-3d">
        <${IsoView} model=${model} styleOf=${styleOf} onPick=${pick} label=${selItem ? 'Adding to #' + (order.indexOf(selItem) + 1) + ' · click it in the list to stop' : missing.length ? missing.length + ' pieces still to add' : 'Every piece is in the order'} />
      </div>
      <aside class="oe-list">
        ${problems.length > 0 && html`<ul class="oe-problems">${problems.map((p) => html`<li>${p.msg}</li>`)}</ul>`}
        ${order.map((it, i) => html`<div key=${it.id} class=${'oe-item' + (it.id === sel ? ' sel' : '') + (drag === i ? ' dragging' : '')} draggable="true"
            onDragStart=${(e) => { setDrag(i); e.dataTransfer.effectAllowed = 'move'; }}
            onDragOver=${(e) => e.preventDefault()}
            onDrop=${(e) => { e.preventDefault(); if (drag != null && drag !== i) move(drag, i); setDrag(null); }}
            onDragEnd=${() => setDrag(null)}
            onClick=${() => setSel(it.id === sel ? null : it.id)}>
          <span class="sw" style=${{ background: hue(i, order.length) }}>${i + 1}</span>
          <div class="bd">
            <div class="pcs">${it.memberIds.map((id) => html`<span class="pc">${model.memberById.get(id)?.name || '?'}</span>`)}</div>
            <div class="row" onClick=${(e) => e.stopPropagation()}>
              <label class="oe-chk" title="Large or awkward: whoever carries it into place can only hold it there, and someone else bolts it">
                <input type="checkbox" checked=${it.buddy} onChange=${(e) => patch(it.id, { buddy: e.target.checked })} /> Needs a buddy ★
              </label>
              ${it.memberIds.length > 1 && html`<label class="oe-chk">Make in <input type="number" min="1" step="any" value=${it.time ?? ''} placeholder=${gameAssemblyTime({ ...it, time: null }, project, model, settings)}
                onInput=${(e) => { const v = parseFloat(e.target.value); patch(it.id, { time: Number.isFinite(v) && v > 0 ? v : null }); }} /> s</label>`}
            </div>
          </div>
          <div class="ops" onClick=${(e) => e.stopPropagation()}>
            <button class="small" disabled=${i === 0} title="Earlier" onClick=${() => move(i, i - 1)}>↑</button>
            <button class="small" disabled=${i === order.length - 1} title="Later" onClick=${() => move(i, i + 1)}>↓</button>
            ${it.memberIds.length > 1 && html`<button class="small" title="Split into single pieces" onClick=${() => update((o) => o.flatMap((x) => (x.id === it.id ? x.memberIds.map((id) => ({ id: itemId(), memberIds: [id], buddy: false, time: null })) : [x])))}>Split</button>`}
            <button class="small" title="Take out of the order" onClick=${() => { if (sel === it.id) setSel(null); update((o) => o.filter((x) => x.id !== it.id)); }}>✕</button>
          </div>
        </div>`)}
        ${missing.length > 0 && html`<div class="oe-missing"><b>Not in the order yet</b> (click them on the bridge, or here to add at the end)
          <div class="pcs">${missing.map((m) => html`<button class="small" onClick=${() => pick(m)}>${m.name}</button>`)}</div></div>`}
      </aside>
    </div>
  </div>`;
}
