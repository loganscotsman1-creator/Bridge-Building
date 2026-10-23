// Pan/zoom for the 2D drawing canvases. World units are inches; `flipY` makes +v point up
// (side views) instead of down (plan and top views).
import { useEffect, useLayoutEffect, useRef, useState } from '../lib/preact.js';

export function useCamera({ flipY = false, bounds = null }) {
  const svgRef = useRef(null);
  const [size, setSize] = useState({ w: 0, h: 0 }); // 0 until the canvas has been measured
  const [cam, setCam] = useState(null);
  const camRef = useRef(null);
  const sizeRef = useRef(size);
  const panRef = useRef(null);
  camRef.current = cam;
  sizeRef.current = size;

  useLayoutEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) setSize({ w: r.width, h: r.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const fit = (b = bounds) => {
    if (!b) return;
    const { w, h } = sizeRef.current;
    const du = Math.max(1, b.maxU - b.minU), dv = Math.max(1, b.maxV - b.minV);
    const k = Math.min(w / (du * 1.15), h / (dv * 1.15));
    setCam({ cx: (b.minU + b.maxU) / 2, cy: (b.minV + b.maxV) / 2, k });
  };

  useEffect(() => {
    if (!cam && bounds && size.w > 10) fit(bounds);
  }, [size.w, size.h, !!bounds]);

  // Zoom with the wheel around the cursor (needs a non-passive listener to stop page scroll).
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const onWheel = (e) => {
      const c = camRef.current;
      if (!c) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const sx = e.clientX - r.left, sy = e.clientY - r.top;
      const before = toWorldWith(c, sizeRef.current, flipY, sx, sy);
      const k = Math.min(200, Math.max(0.05, c.k * Math.exp(-e.deltaY * 0.0015)));
      const nc = { ...c, k };
      const after = toWorldWith(nc, sizeRef.current, flipY, sx, sy);
      setCam({ k, cx: c.cx + before.u - after.u, cy: c.cy + before.v - after.v });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [flipY]);

  const c = cam || { cx: 0, cy: 0, k: 1 };
  const toScreen = (u, v) => ({
    x: (u - c.cx) * c.k + size.w / 2,
    y: flipY ? size.h / 2 - (v - c.cy) * c.k : size.h / 2 + (v - c.cy) * c.k,
  });
  const toWorld = (sx, sy) => toWorldWith(c, size, flipY, sx, sy);
  const eventPos = (e) => {
    const r = svgRef.current.getBoundingClientRect();
    return { sx: e.clientX - r.left, sy: e.clientY - r.top };
  };
  const beginPan = (e) => {
    const { sx, sy } = eventPos(e);
    panRef.current = { sx, sy, cx: c.cx, cy: c.cy };
  };
  const movePan = (e) => {
    const p = panRef.current;
    if (!p) return false;
    const { sx, sy } = eventPos(e);
    const du = (sx - p.sx) / c.k, dv = (sy - p.sy) / c.k;
    setCam({ ...c, cx: p.cx - du, cy: flipY ? p.cy + dv : p.cy - dv });
    return true;
  };
  const endPan = () => { panRef.current = null; };

  return { svgRef, size, cam: c, ready: !!cam, toScreen, toWorld, eventPos, fit, beginPan, movePan, endPan, panning: () => !!panRef.current };
}

function toWorldWith(c, size, flipY, sx, sy) {
  return {
    u: (sx - size.w / 2) / c.k + c.cx,
    v: flipY ? c.cy - (sy - size.h / 2) / c.k : (sy - size.h / 2) / c.k + c.cy,
  };
}

// Grid lines covering the visible area, spaced so they stay readable at any zoom.
export function gridLines(camera, { minor = 6, major = 12 } = {}) {
  const { size, toWorld, toScreen, cam } = camera;
  const a = toWorld(0, 0), b = toWorld(size.w, size.h);
  const u0 = Math.min(a.u, b.u), u1 = Math.max(a.u, b.u), v0 = Math.min(a.v, b.v), v1 = Math.max(a.v, b.v);
  let step = minor;
  while (step * cam.k < 14) step *= step === minor ? major / minor : 5;
  const lines = [];
  if ((u1 - u0) / step > 400) return lines;
  for (let u = Math.ceil(u0 / step) * step; u <= u1; u += step) {
    const s = toScreen(u, 0);
    lines.push({ x1: s.x, y1: 0, x2: s.x, y2: size.h, major: Math.abs(u % (step * 5)) < 1e-6 || Math.abs(u) < 1e-6, zero: Math.abs(u) < 1e-6 });
  }
  for (let v = Math.ceil(v0 / step) * step; v <= v1; v += step) {
    const s = toScreen(0, v);
    lines.push({ x1: 0, y1: s.y, x2: size.w, y2: s.y, major: Math.abs(v % (step * 5)) < 1e-6 || Math.abs(v) < 1e-6, zero: Math.abs(v) < 1e-6 });
  }
  return lines;
}
