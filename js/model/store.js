// The one place the open project lives. Components read it with useProject() and change it
// with updateProject(p => { ...mutate p... }). Every change is undoable and autosaved.
import { useEffect, useState } from '../lib/preact.js';
import { autosave } from './storage.js';

let project = null;
const listeners = new Set();
const undoStack = [];
const redoStack = [];
let lastKey = null;
let lastTime = 0;

function notify() {
  for (const l of listeners) l();
}

// Images are big and never edited in place, so they're shared between snapshots.
function cloneProject(p) {
  const images = p.images;
  const c = structuredClone({ ...p, images: null });
  c.images = images;
  return c;
}

export function setProject(p, { resetHistory = true } = {}) {
  if (resetHistory) { undoStack.length = 0; redoStack.length = 0; } else undoStack.push(project);
  project = p;
  notify();
  autosave(project);
}

export function getProject() {
  return project;
}

/**
 * @param {(p: object) => void} fn mutates a copy of the project
 * @param {{key?: string, undo?: boolean}} opts changes with the same key within 1.5 s share one
 *        undo step (typing in a field, dragging a point)
 */
export function updateProject(fn, opts = {}) {
  const next = cloneProject(project);
  fn(next);
  const now = Date.now();
  if (opts.undo !== false) {
    const merge = opts.key && opts.key === lastKey && now - lastTime < 1500;
    if (!merge) {
      undoStack.push(project);
      if (undoStack.length > 100) undoStack.shift();
    }
    redoStack.length = 0;
    lastKey = opts.key || null;
    lastTime = now;
  }
  project = next;
  notify();
  autosave(project);
}

export function undo() {
  if (!undoStack.length) return;
  redoStack.push(project);
  project = undoStack.pop();
  lastKey = null;
  notify();
  autosave(project);
}

export function redo() {
  if (!redoStack.length) return;
  undoStack.push(project);
  project = redoStack.pop();
  lastKey = null;
  notify();
  autosave(project);
}

export const canUndo = () => undoStack.length > 0;
export const canRedo = () => redoStack.length > 0;

export function useProject() {
  const [, setTick] = useState(0);
  useEffect(() => {
    const l = () => setTick((x) => x + 1);
    listeners.add(l);
    return () => listeners.delete(l);
  }, []);
  return project;
}
