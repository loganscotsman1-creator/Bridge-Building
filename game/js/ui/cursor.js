// Player 1's controller as a mouse on the menu screens (setup and results): the left stick moves a
// pointer, A clicks what's under it, the right stick scrolls (so does holding the pointer at the
// top or bottom edge), and LB / RB step a number field down / up. The pointer fades out when the
// stick is left alone. The d-pad is left to the setup screen's own controller handling.
import { html, useEffect, useRef } from '../../../js/lib/preact.js';

let active = false, suspended = false;
// In use right now (the setup screen leaves player 1's A alone then).
export const cursorActive = () => active && !suspended;
// While player 1 types a name on the on-screen keyboard, the stick and A belong to that.
export const suspendCursor = (s) => { suspended = s; };

const btn = (p, i) => !!(p.buttons[i] && (p.buttons[i].pressed || p.buttons[i].value > 0.5));

// Step a number field the way typing in it would.
function nudgeNumber(input, dir) {
  const step = parseFloat(input.dataset.step || input.step) || 1;
  const v = Math.max(0, Math.round(((parseFloat(input.value) || 0) + dir * step) * 100) / 100);
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, String(v));
  input.dispatchEvent(new Event('input', { bubbles: true }));
}
function clickAt(x, y) {
  const el = document.elementFromPoint(x, y);
  if (!el) return;
  const t = el.closest('button, a, summary, label, input, select') || el;
  if (t.tagName === 'INPUT' && t.type !== 'checkbox' && t.type !== 'radio' && t.type !== 'color') { t.focus(); return; }
  if (t.tagName === 'SELECT') { t.focus(); return; }
  t.click();
}
// The nearest thing under the pointer that scrolls, else the page.
function scroller(x, y) {
  for (let el = document.elementFromPoint(x, y); el && el !== document.body; el = el.parentElement) {
    const st = getComputedStyle(el);
    if (/(auto|scroll)/.test(st.overflowY) && el.scrollHeight > el.clientHeight + 2) return el;
  }
  return document.scrollingElement || document.documentElement;
}

export function PadCursor({ device }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!device || !device.startsWith('pad')) return undefined;
    const idx = +device.slice(3);
    let x = innerWidth / 2, y = innerHeight / 2, last = performance.now(), idle = 99, raf;
    const was = { a: true, lb: true, rb: true };
    const loop = (t) => {
      const dt = Math.min(0.05, (t - last) / 1000);
      last = t;
      const p = navigator.getGamepads ? navigator.getGamepads()[idx] : null;
      if (p && p.connected && !suspended) {
        const sx = p.axes[0] || 0, sy = p.axes[1] || 0, m = Math.hypot(sx, sy);
        if (m > 0.2) {
          const speed = Math.pow(Math.min(1, (m - 0.2) / 0.75), 1.6) * 1100 + 60;
          x = Math.max(2, Math.min(innerWidth - 4, x + (sx / m) * speed * dt));
          y = Math.max(2, Math.min(innerHeight - 4, y + (sy / m) * speed * dt));
          idle = 0;
        } else idle += dt;
        const ry = p.axes[3] || 0;
        let scroll = Math.abs(ry) > 0.2 ? ry * 900 * dt : 0;
        if (idle < 0.2 && y < 28) scroll = -600 * dt;
        if (idle < 0.2 && y > innerHeight - 28) scroll = 600 * dt;
        if (scroll) { scroller(x, y).scrollBy(0, scroll); idle = Math.min(idle, 1); }
        active = idle < 6;
        const a = btn(p, 0), lb = btn(p, 4), rb = btn(p, 5);
        if (active && a && !was.a) clickAt(x, y);
        const num = (lb && !was.lb) || (rb && !was.rb) ? document.elementFromPoint(x, y)?.closest('.oe-num, label')?.querySelector('input[type=number]') : null;
        if (num) nudgeNumber(num, rb && !was.rb ? 1 : -1);
        was.a = a; was.lb = lb; was.rb = rb;
      } else active = false;
      const el = ref.current;
      if (el) { el.style.transform = `translate(${x}px, ${y}px)`; el.style.opacity = active && !suspended ? '1' : '0'; }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => { cancelAnimationFrame(raf); active = false; };
  }, [device]);
  if (!device || !device.startsWith('pad')) return null;
  return html`<div ref=${ref} class="oe-cursor" aria-hidden="true"><svg viewBox="0 0 24 24" width="26" height="26"><path d="M3 2 L3 20 L8 15 L12 23 L15 21.5 L11 14 L18 14 Z" fill="#facc15" stroke="#0f172a" stroke-width="1.6" stroke-linejoin="round" /></svg></div>`;
}
