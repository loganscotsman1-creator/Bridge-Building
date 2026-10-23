// Saving and loading: browser autosave, project/site files, the shared site library in the repo,
// and image import.
import { normalizeSite } from './schema.js';

const PROJECT_KEY = 'bss.project.v1';
const SITES_KEY = 'bss.sites.v1';

let saveTimer = null;
let lastSaveOk = true;
const saveListeners = new Set();

export function autosave(project) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    let ok = true;
    try {
      localStorage.setItem(PROJECT_KEY, JSON.stringify(project));
    } catch {
      ok = false; // usually the browser's storage quota (big images)
    }
    if (ok !== lastSaveOk) { lastSaveOk = ok; for (const l of saveListeners) l(ok); }
  }, 600);
}

export function onAutosaveStatus(fn) {
  saveListeners.add(fn);
  return () => saveListeners.delete(fn);
}

export function loadAutosave() {
  try {
    const raw = localStorage.getItem(PROJECT_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function downloadJSON(obj, filename) {
  const blob = new Blob([JSON.stringify(obj, null, 1)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function pickFile(accept) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.onchange = () => resolve(input.files[0] || null);
    input.click();
  });
}

export async function readJSONFile(file) {
  return JSON.parse(await file.text());
}

export function safeFilename(name, ext) {
  return (name || 'untitled').replace(/[^a-z0-9-_ ]+/gi, '').trim().replace(/\s+/g, '-').toLowerCase() + ext;
}

// Shrink big screenshots so project files stay shareable.
export function imageFileToData(file, maxDim = 1800) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('Not an image the browser can read'));
      img.onload = () => {
        const s = Math.min(1, maxDim / Math.max(img.width, img.height));
        const w = Math.round(img.width * s), h = Math.round(img.height * s);
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
        resolve({ url: canvas.toDataURL('image/jpeg', 0.85), w, h, name: file.name });
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

// ---- site layouts ----
// Only the parts of a site that carry over between projects (not where this year's members sit).
export function siteForSharing(site) {
  const { staging, ...rest } = site;
  return { kind: 'bridge-site', ...rest };
}

export function mySites() {
  try {
    return JSON.parse(localStorage.getItem(SITES_KEY) || '[]');
  } catch {
    return [];
  }
}

export function saveMySite(site) {
  const list = mySites().filter((s) => s.name !== site.name);
  list.unshift({ ...siteForSharing(site), savedAt: new Date().toISOString() });
  localStorage.setItem(SITES_KEY, JSON.stringify(list));
}

export function deleteMySite(name) {
  localStorage.setItem(SITES_KEY, JSON.stringify(mySites().filter((s) => s.name !== name)));
}

// Shared library: library/sites/index.json in the repo lists the files. See README.
export async function fetchSiteLibrary() {
  const res = await fetch('library/sites/index.json', { cache: 'no-cache' });
  if (!res.ok) throw new Error('Could not load the shared site library');
  const index = await res.json();
  return index.sites || [];
}

export async function fetchLibrarySite(file) {
  const res = await fetch('library/sites/' + file, { cache: 'no-cache' });
  if (!res.ok) throw new Error('Could not load ' + file);
  return normalizeSite(await res.json());
}
