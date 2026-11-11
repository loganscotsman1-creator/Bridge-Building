// Controllers (the browser's Gamepad API: Xbox, PlayStation, Switch Pro… over USB or Bluetooth)
// and two keyboard players. Every device reads as {mx, my, a, x, lb, start}.
const keys = new Set();
const taps = new Set(); // pressed since the last frame, so a quick tap between frames still counts
// Some keyboards (and remote-desktop tools) leave `code` empty; work it out from the key instead.
const FROM_KEY = { ' ': 'Space', '/': 'Slash', '.': 'Period', ',': 'Comma', Escape: 'Escape', Backspace: 'Backspace', ArrowUp: 'ArrowUp', ArrowDown: 'ArrowDown', ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight' };
const codeOf = (e) => e.code || FROM_KEY[e.key] || (/^[a-z]$/i.test(e.key || '') ? 'Key' + e.key.toUpperCase() : e.key);
if (typeof window !== 'undefined') {
  window.addEventListener('keydown', (e) => {
    if (e.target && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
    const code = codeOf(e);
    keys.add(code);
    taps.add(code);
    // Space and slash join or act; don't let them scroll the page or press a focused button.
    if (KEY_CODES.has(code) && (document.body.classList.contains('playing') || code === 'Space' || code === 'Slash')) e.preventDefault();
  });
  window.addEventListener('keyup', (e) => keys.delete(codeOf(e)));
  window.addEventListener('blur', () => keys.clear());
}

export const KEYBOARDS = {
  kb1: { name: 'Keyboard left', up: 'KeyW', down: 'KeyS', left: 'KeyA', right: 'KeyD', a: 'Space', x: 'KeyE', lb: 'KeyQ', start: 'Escape', caps: { A: 'Space', X: 'E', LB: 'Q' }, help: 'WASD move · Space = A · E = X · Q = hold bridge' },
  kb2: { name: 'Keyboard right', up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight', a: 'Slash', x: 'Period', lb: 'Comma', start: 'Backspace', caps: { A: '/', X: '.', LB: ',' }, help: 'Arrows move · / = A · . = X · , = hold bridge' },
};
const KEY_CODES = new Set(Object.values(KEYBOARDS).flatMap((k) => [k.up, k.down, k.left, k.right, k.a, k.x, k.lb]));

const pads = () => (typeof navigator !== 'undefined' && navigator.getGamepads ? [...navigator.getGamepads()] : []);

export function deviceName(id) {
  if (KEYBOARDS[id]) return KEYBOARDS[id].name;
  const i = +id.slice(3);
  const p = pads()[i];
  return 'Controller ' + (i + 1) + (p ? ' · ' + p.id.replace(/\(.*?\)/g, '').trim().slice(0, 28) : ' (not connected)');
}
export const deviceHelp = (id) => (KEYBOARDS[id] ? KEYBOARDS[id].help : 'Stick move · A grab/place/pass · X fasten/assemble · LB hold bridge');

export function readDevice(id) {
  const k = KEYBOARDS[id];
  if (k) {
    const down = (c) => keys.has(c) || taps.has(c);
    return {
      mx: (keys.has(k.right) ? 1 : 0) - (keys.has(k.left) ? 1 : 0),
      my: (keys.has(k.down) ? 1 : 0) - (keys.has(k.up) ? 1 : 0),
      a: down(k.a), x: down(k.x), lb: down(k.lb), start: down(k.start),
    };
  }
  const p = pads()[+id.slice(3)];
  if (!p || !p.connected) return { mx: 0, my: 0, a: false, x: false, lb: false, start: false };
  const btn = (i) => !!(p.buttons[i] && (p.buttons[i].pressed || p.buttons[i].value > 0.5));
  let mx = p.axes[0] || 0, my = p.axes[1] || 0;
  const m = Math.hypot(mx, my);
  if (m < 0.22) { mx = 0; my = 0; } else { const s = Math.min(1, (m - 0.22) / 0.7) / m; mx *= s; my *= s; }
  if (btn(14)) mx = -1; if (btn(15)) mx = 1; if (btn(12)) my = -1; if (btn(13)) my = 1;
  return { mx, my, a: btn(0), x: btn(2) || btn(1), lb: btn(4) || btn(6), start: btn(9) };
}

// Devices with A (or Space / slash) pressed right now, for joining.
export function pressedDevices() {
  const out = [];
  for (const id of Object.keys(KEYBOARDS)) if (readDevice(id).a) out.push(id);
  pads().forEach((p, i) => { if (p && p.connected && readDevice('pad' + i).a) out.push('pad' + i); });
  return out;
}

// Call once per frame after reading every device.
export function endFrame() { taps.clear(); }
