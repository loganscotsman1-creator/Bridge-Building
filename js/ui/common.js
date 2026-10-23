// Small form building blocks shared by every tab.
import { html, useEffect, useRef, useState } from '../lib/preact.js';

const fmtNum = (v) => (v == null || Number.isNaN(v) ? '' : String(Math.round(v * 1000) / 1000));

export function NumField({ label, value, onChange, step = 'any', min, max, unit, title, disabled }) {
  const [text, setText] = useState(fmtNum(value));
  const focused = useRef(false);
  useEffect(() => { if (!focused.current) setText(fmtNum(value)); }, [value]);
  return html`<label class="field" title=${title}>
    <span class="lbl">${label}</span>
    <span class="inp">
      <input type="number" step=${step} min=${min} max=${max} value=${text} disabled=${disabled}
        onFocus=${() => { focused.current = true; }}
        onBlur=${() => { focused.current = false; setText(fmtNum(value)); }}
        onInput=${(e) => {
          setText(e.target.value);
          const n = parseFloat(e.target.value);
          if (Number.isFinite(n)) onChange(min != null ? Math.max(min, n) : n);
        }} />
      ${unit && html`<em>${unit}</em>`}
    </span>
  </label>`;
}

export function TextField({ label, value, onChange, placeholder, title }) {
  return html`<label class="field" title=${title}>
    <span class="lbl">${label}</span>
    <span class="inp"><input type="text" value=${value ?? ''} placeholder=${placeholder} onInput=${(e) => onChange(e.target.value)} /></span>
  </label>`;
}

export function SelectField({ label, value, options, onChange, title }) {
  return html`<label class="field" title=${title}>
    <span class="lbl">${label}</span>
    <span class="inp"><select value=${value} onChange=${(e) => onChange(e.target.value)}>
      ${options.map(([v, l]) => html`<option value=${v} selected=${v === value}>${l}</option>`)}
    </select></span>
  </label>`;
}

export function Check({ label, checked, onChange, title }) {
  return html`<label class="check" title=${title}><input type="checkbox" checked=${!!checked} onChange=${(e) => onChange(e.target.checked)} /> ${label}</label>`;
}

export function Section({ title, children, right, open = true }) {
  const [isOpen, setOpen] = useState(open);
  return html`<section class="panel-section">
    <header onClick=${() => setOpen(!isOpen)}>
      <span class="caret">${isOpen ? '▾' : '▸'}</span><h3>${title}</h3>
      <span class="spacer"></span>${right && html`<span onClick=${(e) => e.stopPropagation()}>${right}</span>`}
    </header>
    ${isOpen && html`<div class="body">${children}</div>`}
  </section>`;
}

export function Hint({ children }) {
  return html`<p class="hint">${children}</p>`;
}

export function ColorDot({ color }) {
  return html`<span class="dot" style=${{ background: color }}></span>`;
}

// Keyboard shortcuts that shouldn't fire while typing in a field.
export function isTyping(e) {
  const t = e.target;
  return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
}
